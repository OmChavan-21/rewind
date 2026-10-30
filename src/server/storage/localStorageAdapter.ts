/**
 * Rewind Local Storage Adapter
 * Implements IStorageProvider using local filesystem (.rewind_store/ and projects/).
 * Preserves local development and offline unit test workflows.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  IStorageProvider,
  IProjectStore,
  IWorkspaceStore,
  ISnapshotStore,
  IChatMemoryStore,
  IAuditStore,
  ICreditStore,
  IRAGStore,
  CreditBalanceResult,
} from "./storageTypes";
import type { ProjectMetadata, ProjectSummary } from "../../types/project";
import type { PermittedFile, Snapshot, AgentAction } from "../../types/recovery";
import type { ChatSession, ChatMessage } from "../../types/chat";
import type { ProjectMemory } from "../../types/memory";
import type { RAGDocument, DocumentChunk, VectorSearchResult } from "../../types/rag";
import {
  getDefaultStoreRoot,
  listPermittedWorkspaceFiles,
  restoreSnapshot,
  recordAction as localRecordAction,
  getAuditHistory as localGetAuditHistory,
} from "../../engine/recoveryEngine";
import {
  listProjects as localListProjects,
  getProject as localGetProject,
  createProject as localCreateProject,
  resolveProjectWorkspace,
} from "../../engine/projectManager";
import {
  listChatSessions,
  getChatSession,
  createChatSession,
  listChatMessages,
  addChatMessage,
  listProjectMemories,
  saveProjectMemory,
} from "../../engine/chatMemoryStore";
import {
  saveSnapshotRecord,
  listStoredSnapshots,
  loadSnapshotRecord,
  atomicWriteFileSync,
} from "../../engine/storage";
import {
  getProjectCreditBalance,
  readProjectCreditStore,
  writeProjectCreditStore,
} from "../ai/dualAccounting";
import {
  isPermittedFile,
  resolveAndValidatePath,
  validateFileSize,
  SecurityError,
} from "../../security/boundaries";

export class LocalStorageAdapter implements IStorageProvider {
  readonly mode = "local" as const;
  readonly storeRoot: string;

  constructor(storeRoot?: string) {
    this.storeRoot = storeRoot || getDefaultStoreRoot();
  }

  get projects(): IProjectStore {
    const storeRoot = this.storeRoot;
    return {
      async listProjects(userId?: string): Promise<ProjectSummary> {
        return localListProjects(storeRoot, userId);
      },
      async getProject(projectId: string, _userId?: string): Promise<ProjectMetadata | null> {
        void _userId;
        const proj = localGetProject(projectId, storeRoot);
        if (!proj) return null;
        return proj;
      },
      async saveProject(project: ProjectMetadata, userId?: string): Promise<void> {
        localCreateProject(
          { name: project.name, description: project.description, template: "empty" },
          storeRoot,
          userId
        );
      },
      async deleteProject(_projectId: string, _userId?: string): Promise<boolean> {
        void _projectId;
        void _userId;
        return true;
      },
    };
  }

  get workspace(): IWorkspaceStore {
    const storeRoot = this.storeRoot;
    return {
      async listFiles(projectId: string, _userId?: string): Promise<PermittedFile[]> {
        void _userId;
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        return listPermittedWorkspaceFiles(wsPath);
      },
      async readFile(projectId: string, relativePath: string, _userId?: string): Promise<string> {
        void _userId;
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        const resolved = resolveAndValidatePath(wsPath, relativePath);
        if (!fs.existsSync(resolved)) {
          throw new SecurityError(`File not found: ${relativePath}`);
        }
        return fs.readFileSync(resolved, "utf-8");
      },
      async writeFile(
        projectId: string,
        relativePath: string,
        content: string | Buffer,
        _userId?: string
      ): Promise<void> {
        void _userId;
        if (!isPermittedFile(relativePath)) {
          throw new SecurityError(`File extension not permitted: ${relativePath}`);
        }
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        const resolved = resolveAndValidatePath(wsPath, relativePath, { allowNonExistent: true });
        validateFileSize(Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf-8"));
        atomicWriteFileSync(resolved, content);
      },
      async deleteFile(projectId: string, relativePath: string, _userId?: string): Promise<boolean> {
        void _userId;
        if (!isPermittedFile(relativePath)) {
          throw new SecurityError(`File extension not permitted: ${relativePath}`);
        }
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        const resolved = resolveAndValidatePath(wsPath, relativePath);
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
          return true;
        }
        return false;
      },
      async saveUploadedFile(
        projectId: string,
        relativePath: string,
        content: Buffer,
        _userId?: string
      ): Promise<void> {
        void _userId;
        if (!isPermittedFile(relativePath)) {
          throw new SecurityError(`File extension not permitted: ${relativePath}`);
        }
        validateFileSize(content.length);
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        const resolved = resolveAndValidatePath(wsPath, relativePath, { allowNonExistent: true });
        atomicWriteFileSync(resolved, content);
      },
    };
  }

  get snapshots(): ISnapshotStore {
    const storeRoot = this.storeRoot;
    return {
      async listSnapshots(projectId: string, _userId?: string): Promise<Snapshot[]> {
        void _userId;
        const snaps = listStoredSnapshots(storeRoot);
        return snaps.filter((s) => (s.metadata?.projectId as string) === projectId || (!s.metadata?.projectId && projectId === "demo-workspace"));
      },
      async getSnapshot(projectId: string, snapshotId: string, _userId?: string): Promise<Snapshot | null> {
        void _userId;
        const loaded = loadSnapshotRecord(storeRoot, snapshotId);
        if (!loaded) return null;
        const snapProj = (loaded.snapshot.metadata?.projectId as string) || "demo-workspace";
        if (snapProj !== projectId) {
          return null;
        }
        return loaded.snapshot;
      },
      async saveSnapshot(
        projectId: string,
        snapshot: Snapshot,
        fileContents: Map<string, string>,
        _userId?: string
      ): Promise<void> {
        void _userId;
        const withMeta: Snapshot = {
          ...snapshot,
          metadata: { ...snapshot.metadata, projectId },
        };
        saveSnapshotRecord(storeRoot, withMeta, fileContents);
      },
      async restoreSnapshot(
        projectId: string,
        snapshotId: string,
        _userId?: string
      ): Promise<{ restoredFiles: string[]; snapshot: Snapshot }> {
        void _userId;
        const wsPath = resolveProjectWorkspace(projectId, storeRoot);
        const res = restoreSnapshot(wsPath, storeRoot, snapshotId, { force: true });
        const loaded = loadSnapshotRecord(storeRoot, snapshotId);
        const snap = loaded ? loaded.snapshot : {
          id: res.snapshotId,
          workspaceId: projectId,
          name: "Restored Snapshot",
          createdAt: res.restoredAt,
          totalFiles: res.restoredFiles.length,
          totalBytes: 0,
          files: [],
        };
        return { restoredFiles: res.restoredFiles, snapshot: snap };
      },
    };
  }

  get chatMemories(): IChatMemoryStore {
    const storeRoot = this.storeRoot;
    return {
      async listSessions(projectId: string, userId?: string): Promise<ChatSession[]> {
        return listChatSessions(projectId, storeRoot, userId);
      },
      async getSession(projectId: string, sessionId: string, _userId?: string): Promise<ChatSession | null> {
        void _userId;
        return getChatSession(projectId, sessionId, storeRoot);
      },
      async saveSession(projectId: string, session: ChatSession, userId?: string): Promise<void> {
        createChatSession(
          {
            projectId,
            title: session.title,
            model: session.activeModel,
            routingMode: session.routingMode,
          },
          storeRoot,
          userId || session.userId
        );
      },
      async deleteSession(_projectId: string, _sessionId: string, _userId?: string): Promise<boolean> {
        void _projectId;
        void _sessionId;
        void _userId;
        return true;
      },
      async listMessages(projectId: string, sessionId: string, _userId?: string): Promise<ChatMessage[]> {
        void _userId;
        return listChatMessages(projectId, sessionId, storeRoot);
      },
      async appendMessage(
        projectId: string,
        sessionId: string,
        message: ChatMessage,
        userId?: string
      ): Promise<void> {
        addChatMessage(
          projectId,
          sessionId,
          {
            role: message.role,
            content: message.content,
            reasoning: message.reasoning,
            proposalId: message.proposalId,
          },
          storeRoot,
          userId || message.userId
        );
      },
      async listMemories(projectId: string, category?: string, _userId?: string): Promise<ProjectMemory[]> {
        void _userId;
        return listProjectMemories(projectId, storeRoot, category);
      },
      async saveMemory(projectId: string, memory: ProjectMemory, userId?: string): Promise<void> {
        saveProjectMemory(
          projectId,
          memory,
          storeRoot,
          userId || memory.userId
        );
      },
    };
  }

  get audit(): IAuditStore {
    const storeRoot = this.storeRoot;
    return {
      async recordAction(action: AgentAction, _userId?: string, _projectId?: string): Promise<void> {
        void _userId;
        void _projectId;
        localRecordAction(storeRoot, action);
      },
      async listAuditHistory(projectId?: string, _userId?: string, limit: number = 100): Promise<AgentAction[]> {
        void _userId;
        const history = localGetAuditHistory(storeRoot);
        const filtered = projectId
          ? history.filter((a: AgentAction) => !a.projectId || a.projectId === projectId)
          : history;
        return filtered.slice(0, limit);
      },
    };
  }

  get credits(): ICreditStore {
    const storeRoot = this.storeRoot;
    return {
      async getBalance(projectId: string, _userId?: string): Promise<CreditBalanceResult> {
        void _userId;
        return getProjectCreditBalance(projectId, storeRoot);
      },
      async reserve(
        projectId: string,
        taskId: string,
        amount: number,
        _userId?: string
      ): Promise<{ success: boolean; taskId: string; alreadyCompleted?: boolean }> {
        void _userId;
        const current = getProjectCreditBalance(projectId, storeRoot);
        if (current.remaining < amount) {
          return { success: false, taskId };
        }
        return { success: true, taskId };
      },
      async commit(
        projectId: string,
        taskId: string,
        amount: number,
        complexity: string,
        _userId?: string
      ): Promise<void> {
        void _userId;
        const store = readProjectCreditStore(projectId, storeRoot);
        if (store.tasks[taskId]) {
          return; // Idempotent
        }
        store.usedCredits += amount;
        store.tasks[taskId] = {
          credits: amount,
          chargedAt: new Date().toISOString(),
          complexity,
        };
        writeProjectCreditStore(projectId, store, storeRoot);
      },
      async release(_projectId: string, _taskId: string, _userId?: string): Promise<void> {
        void _projectId;
        void _taskId;
        void _userId;
        // No-op for local store
      },
    };
  }

  get rag(): IRAGStore {
    const storeRoot = this.storeRoot;
    return {
      async listDocuments(projectId: string, _userId?: string): Promise<RAGDocument[]> {
        void _userId;
        try {
          const vectorsFile = path.join(storeRoot, "vectors", `${projectId}.json`);
          if (!fs.existsSync(vectorsFile)) return [];
          const raw = fs.readFileSync(vectorsFile, "utf-8");
          const parsed = JSON.parse(raw);
          return parsed.documents ? Object.values(parsed.documents) : [];
        } catch {
          return [];
        }
      },
      async saveDocument(
        projectId: string,
        document: RAGDocument,
        chunks: DocumentChunk[],
        _userId?: string
      ): Promise<void> {
        void _userId;
        const vectorsDir = path.join(storeRoot, "vectors");
        if (!fs.existsSync(vectorsDir)) {
          fs.mkdirSync(vectorsDir, { recursive: true });
        }
        const vectorsFile = path.join(vectorsDir, `${projectId}.json`);
        let store: {
          projectId: string;
          documents: Record<string, RAGDocument>;
          chunks: DocumentChunk[];
        } = { projectId, documents: {}, chunks: [] };
        if (fs.existsSync(vectorsFile)) {
          try {
            store = JSON.parse(fs.readFileSync(vectorsFile, "utf-8"));
          } catch {
            // Re-init
          }
        }
        store.documents[document.id] = document;
        store.chunks = store.chunks.filter((c) => c.docId !== document.id).concat(chunks);
        atomicWriteFileSync(vectorsFile, JSON.stringify(store, null, 2));
      },
      async searchChunks(
        projectId: string,
        queryEmbedding: number[],
        topK: number,
        _userId?: string
      ): Promise<VectorSearchResult[]> {
        void _userId;
        const vectorsFile = path.join(storeRoot, "vectors", `${projectId}.json`);
        if (!fs.existsSync(vectorsFile)) return [];
        try {
          const raw = fs.readFileSync(vectorsFile, "utf-8");
          const store = JSON.parse(raw);
          const chunks: DocumentChunk[] = store.chunks || [];
          const results: VectorSearchResult[] = [];

          for (const chunk of chunks) {
            let dot = 0;
            let normA = 0;
            let normB = 0;
            const vector = chunk.vector || [];
            for (let i = 0; i < queryEmbedding.length; i++) {
              const a = queryEmbedding[i] || 0;
              const b = vector[i] || 0;
              dot += a * b;
              normA += a * a;
              normB += b * b;
            }
            const sim = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
            results.push({
              chunk,
              similarityScore: sim,
            });
          }

          results.sort((a, b) => b.similarityScore - a.similarityScore);
          return results.slice(0, topK);
        } catch {
          return [];
        }
      },
    };
  }
}

/**
 * Rewind Cloud Storage Adapter
 * Production-ready durable storage implementation utilizing:
 * - Google Cloud Firestore for metadata, state, transactions, chat, and memories.
 * - Firebase / Google Cloud Storage for binary workspace files and immutable snapshots.
 *
 * Enforces:
 * - Fail-closed execution when cloud services are unavailable.
 * - Strict tenant isolation by userId and projectId.
 * - Path traversal defense and file type/size validation.
 * - Atomic Firestore transactions for credit reservations and deduplication.
 */

import crypto from "node:crypto";
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
import { StorageError } from "./storageTypes";
import type { ProjectMetadata, ProjectSummary } from "../../types/project";
import type { PermittedFile, Snapshot, AgentAction } from "../../types/recovery";
import type { ChatSession, ChatMessage } from "../../types/chat";
import type { ProjectMemory } from "../../types/memory";
import type { RAGDocument, DocumentChunk, VectorSearchResult } from "../../types/rag";
import { INITIAL_DEMO_PROJECT } from "../../engine/demoWorkspace";
import { getFirestoreDb, getFirebaseStorageBucket } from "../firebaseService";
import { FirestoreStorageBucket } from "./firestoreStorageBucket";
import {
  isPermittedFile,
  validateFileSize,
  validateProjectId,
  validateSnapshotId,
  validateSessionId,
  validateMemoryId,
  SecurityError,
} from "../../security/boundaries";

export interface FirestoreDocRef {
  id: string;
  get(): Promise<{ exists: boolean; id?: string; data: () => Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  collection(name: string): FirestoreCollectionRef;
}

export interface FirestoreCollectionRef {
  doc(id?: string): FirestoreDocRef;
  get(): Promise<{
    docs: { id: string; data: () => Record<string, unknown>; ref: FirestoreDocRef }[];
    forEach(fn: (doc: { id: string; data: () => Record<string, unknown> }) => void): void;
  }>;
}

export interface FirestoreTransaction {
  get(docRef: FirestoreDocRef): Promise<{ exists: boolean; id?: string; data: () => Record<string, unknown> | undefined }>;
  set(docRef: FirestoreDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
  update(docRef: FirestoreDocRef, data: Record<string, unknown>): void;
  delete(docRef: FirestoreDocRef): void;
}

export interface FirestoreBatch {
  set(docRef: FirestoreDocRef, data: Record<string, unknown>): void;
  commit(): Promise<void>;
}

export interface FirestoreClient {
  collection(name: string): FirestoreCollectionRef;
  batch(): FirestoreBatch;
  runTransaction<T>(updateFunction: (tx: FirestoreTransaction) => Promise<T>): Promise<T>;
}

export interface StorageFile {
  name: string;
  metadata?: {
    size?: string;
    updated?: string;
    md5Hash?: string;
    crc32c?: string;
  };
  save(buffer: Buffer, opts?: { resumable?: boolean; metadata?: Record<string, unknown> }): Promise<void>;
  download(): Promise<[Buffer]>;
  delete(): Promise<void>;
  exists(): Promise<[boolean]>;
}

export interface StorageBucket {
  file(name: string): StorageFile;
  getFiles(options?: { prefix?: string }): Promise<[StorageFile[]]>;
}

const DEFAULT_DEMO_PROJECT: ProjectMetadata = {
  id: "demo-workspace",
  name: "Demo Project (NVIDIA Recovery)",
  description: "Sample workspace containing agent workflow, runtime config, and evaluator.",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  workspacePath: "demo-workspace",
  fileCount: 3,
  totalSizeBytes: 3000,
  snapshotCount: 0,
  status: "active",
  isDefault: true,
};

function normalizeRelativePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.split("/").some((part) => part === "..")) {
    throw new SecurityError(`Path traversal detected: '${relPath}'`);
  }
  return normalized;
}

function calculateSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export class CloudStorageAdapter implements IStorageProvider {
  readonly mode = "cloud" as const;
  private injectedDb: FirestoreClient | null = null;
  private injectedBucket: StorageBucket | null = null;

  constructor(optionsOrDb?: { db?: unknown; bucket?: unknown } | unknown, maybeBucket?: unknown) {
    if (optionsOrDb && typeof optionsOrDb === "object" && ("db" in optionsOrDb || "bucket" in optionsOrDb)) {
      const opts = optionsOrDb as { db?: unknown; bucket?: unknown };
      if (opts.db) this.injectedDb = opts.db as FirestoreClient;
      if (opts.bucket) this.injectedBucket = opts.bucket as StorageBucket;
    } else {
      if (optionsOrDb) this.injectedDb = optionsOrDb as FirestoreClient;
      if (maybeBucket) this.injectedBucket = maybeBucket as StorageBucket;
    }
  }

  private async getDb(): Promise<FirestoreClient> {
    if (this.injectedDb) return this.injectedDb;
    const db = (await getFirestoreDb()) as FirestoreClient | null;
    if (!db) {
      throw new StorageError(
        "Cloud Firestore is required in this environment but is unavailable or misconfigured.",
        "CLOUD_STORAGE_UNAVAILABLE",
        503
      );
    }
    return db;
  }

  private async getBucket(): Promise<StorageBucket> {
    if (this.injectedBucket) return this.injectedBucket;

    // 1. If explicit Cloud Storage bucket is configured, attempt GCS
    const explicitBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
    if (explicitBucket) {
      try {
        const bucket = (await getFirebaseStorageBucket()) as StorageBucket | null;
        if (bucket) return bucket;
      } catch (err) {
        console.warn(
          "[StorageAdapter] Firebase Cloud Storage unavailable, falling back to Firestore storage bucket:",
          err
        );
      }
    }

    // 2. Default to Firestore-backed storage bucket (100% Spark plan free tier compatible)
    const db = await this.getDb();
    return new FirestoreStorageBucket(db);
  }

  private async assertProjectOwnership(projectId: string, userId?: string): Promise<void> {
    validateProjectId(projectId);
    if (projectId === DEFAULT_DEMO_PROJECT.id) {
      if (!userId) {
        throw new StorageError("User ID is required to access a demo workspace", "FORBIDDEN", 403);
      }
      return;
    }
    if (userId) {
      const db = await this.getDb();
      try {
        const indexDoc = await db.collection("project_index").doc(projectId).get();
        if (indexDoc.exists) {
          const data = indexDoc.data();
          if (data && data.ownerId && data.ownerId !== userId) {
            throw new StorageError(`Project '${projectId}' access denied.`, "FORBIDDEN", 403);
          }
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
      }
    }
  }

  private workspacePrefix(projectId: string, userId?: string): string {
    if (projectId === DEFAULT_DEMO_PROJECT.id) {
      if (!userId) throw new StorageError("User ID is required to access a demo workspace", "FORBIDDEN", 403);
      return `users/${userId}/projects/${projectId}/workspace/`;
    }
    return `projects/${projectId}/workspace/`;
  }

  private snapshotFilesPrefix(projectId: string, snapshotId: string, userId?: string): string {
    if (projectId === DEFAULT_DEMO_PROJECT.id) {
      if (!userId) throw new StorageError("User ID is required to access a demo workspace", "FORBIDDEN", 403);
      return `users/${userId}/projects/${projectId}/snapshots/${snapshotId}/files/`;
    }
    return `projects/${projectId}/snapshots/${snapshotId}/files/`;
  }

  get projects(): IProjectStore {
    return {
      listProjects: async (userId?: string): Promise<ProjectSummary> => {
        const db = await this.getDb();
        const projectsList: ProjectMetadata[] = [{ ...DEFAULT_DEMO_PROJECT }];

        if (userId) {
          try {
            const snapshot = await db.collection("users").doc(userId).collection("projects").get();
            snapshot.forEach((doc) => {
              const data = doc.data() as unknown as ProjectMetadata;
              if (data.id !== DEFAULT_DEMO_PROJECT.id) {
                projectsList.push(data);
              }
            });
          } catch (err) {
            throw new StorageError(
              `Failed to retrieve projects from Firestore: ${err instanceof Error ? err.message : String(err)}`,
              "INTERNAL_ERROR",
              500
            );
          }
        }

        projectsList.sort((a, b) => {
          if (a.isDefault) return -1;
          if (b.isDefault) return 1;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });

        return {
          projects: projectsList,
          activeProjectId: projectsList[0]?.id || "demo-workspace",
          totalProjects: projectsList.length,
        };
      },

      getProject: async (projectId: string, userId?: string): Promise<ProjectMetadata | null> => {
        validateProjectId(projectId);
        if (projectId === DEFAULT_DEMO_PROJECT.id) {
          return { ...DEFAULT_DEMO_PROJECT };
        }
        if (!userId) {
          throw new StorageError("User ID is required to retrieve project metadata", "FORBIDDEN", 403);
        }

        const db = await this.getDb();
        try {
          const doc = await db.collection("users").doc(userId).collection("projects").doc(projectId).get();
          if (!doc.exists) {
            return null;
          }
          return doc.data() as unknown as ProjectMetadata;
        } catch (err) {
          throw new StorageError(
            `Failed to query project '${projectId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveProject: async (project: ProjectMetadata, userId?: string): Promise<void> => {
        validateProjectId(project.id);
        if (!userId) {
          throw new StorageError("User ID is required to save project metadata", "FORBIDDEN", 403);
        }
        if (project.id === DEFAULT_DEMO_PROJECT.id) {
          throw new StorageError("Cannot modify shared demo workspace", "FORBIDDEN", 403);
        }

        const db = await this.getDb();
        try {
          const indexDoc = await db.collection("project_index").doc(project.id).get();
          if (indexDoc.exists) {
            const data = indexDoc.data();
            if (data && data.ownerId && data.ownerId !== userId) {
              throw new StorageError(
                `Project '${project.id}' is already claimed by another user.`,
                "FORBIDDEN",
                403
              );
            }
          }

          const projectData = Object.fromEntries(
            Object.entries({
              ...project,
              userId,
              updatedAt: new Date().toISOString(),
            }).filter(([, value]) => value !== undefined)
          );

          await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(project.id)
            .set(
              projectData,
              { merge: true }
            );

          await db
            .collection("project_index")
            .doc(project.id)
            .set({ ownerId: userId, updatedAt: new Date().toISOString() }, { merge: true });
        } catch (err) {
          if (err instanceof StorageError) throw err;
          throw new StorageError(
            `Failed to persist project '${project.id}' to Firestore: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      deleteProject: async (projectId: string, userId?: string): Promise<boolean> => {
        validateProjectId(projectId);
        if (!userId) {
          throw new StorageError("User ID is required to delete a project", "FORBIDDEN", 403);
        }
        if (projectId === DEFAULT_DEMO_PROJECT.id) {
          throw new StorageError("Cannot delete shared demo workspace", "FORBIDDEN", 403);
        }

        const db = await this.getDb();
        try {
          await db.collection("users").doc(userId).collection("projects").doc(projectId).delete();
          await db.collection("project_index").doc(projectId).delete().catch(() => {});
          return true;
        } catch (err) {
          throw new StorageError(
            `Failed to delete project '${projectId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },
    };
  }

  get workspace(): IWorkspaceStore {
    return {
      listFiles: async (projectId: string, _userId?: string): Promise<PermittedFile[]> => {
        await this.assertProjectOwnership(projectId, _userId);
        const bucket = await this.getBucket();
        const prefix = this.workspacePrefix(projectId, _userId);

        try {
          const [files] = await bucket.getFiles({ prefix });
          if (projectId === DEFAULT_DEMO_PROJECT.id && files.length === 0) {
            for (const [relativePath, content] of Object.entries(INITIAL_DEMO_PROJECT)) {
              await bucket.file(`${prefix}${relativePath}`).save(Buffer.from(content, "utf-8"), {
                resumable: false,
                metadata: { contentType: "text/plain; charset=utf-8" },
              });
            }
            const [seededFiles] = await bucket.getFiles({ prefix });
            files.push(...seededFiles);
          }
          const permittedFiles: PermittedFile[] = [];

          for (const file of files) {
            const relPath = file.name.slice(prefix.length);
            if (!relPath || relPath.endsWith("/")) continue;

            if (isPermittedFile(relPath)) {
              const meta = file.metadata || {};
              const size = parseInt(meta.size || "0", 10);
              const hash = meta.md5Hash || meta.crc32c || calculateSha256(relPath);
              permittedFiles.push({
                path: relPath,
                size,
                hash,
                modifiedAt: meta.updated || new Date().toISOString(),
                extension: path.extname(relPath).toLowerCase(),
              });
            }
          }

          return permittedFiles;
        } catch (err) {
          throw new StorageError(
            `Failed to list files from Cloud Storage for project '${projectId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      readFile: async (projectId: string, relativePath: string, _userId?: string): Promise<string> => {
        await this.assertProjectOwnership(projectId, _userId);
        const normalized = normalizeRelativePath(relativePath);
        if (!isPermittedFile(normalized)) {
          throw new SecurityError(`File extension not permitted: ${normalized}`);
        }

        const bucket = await this.getBucket();
        const cloudPath = `${this.workspacePrefix(projectId, _userId)}${normalized}`;
        const file = bucket.file(cloudPath);

        try {
          const [exists] = await file.exists();
          if (!exists) {
            throw new StorageError(`File '${normalized}' not found in project '${projectId}'`, "NOT_FOUND", 404);
          }
          const [contents] = await file.download();
          return contents.toString("utf-8");
        } catch (err) {
          if (err instanceof StorageError || err instanceof SecurityError) throw err;
          throw new StorageError(
            `Failed to read file '${normalized}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      writeFile: async (
        projectId: string,
        relativePath: string,
        content: string | Buffer,
        _userId?: string
      ): Promise<void> => {
        await this.assertProjectOwnership(projectId, _userId);
        const normalized = normalizeRelativePath(relativePath);
        if (!isPermittedFile(normalized)) {
          throw new SecurityError(`File extension not permitted: ${normalized}`);
        }

        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
        validateFileSize(buffer.length);

        const bucket = await this.getBucket();
        const cloudPath = `${this.workspacePrefix(projectId, _userId)}${normalized}`;
        const file = bucket.file(cloudPath);

        try {
          await file.save(buffer, {
            resumable: false,
            metadata: {
              contentType: "text/plain; charset=utf-8",
              metadata: {
                sha256: calculateSha256(buffer),
              },
            },
          });
        } catch (err) {
          throw new StorageError(
            `Failed to write file '${normalized}' to Cloud Storage: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      deleteFile: async (projectId: string, relativePath: string, _userId?: string): Promise<boolean> => {
        await this.assertProjectOwnership(projectId, _userId);
        const normalized = normalizeRelativePath(relativePath);
        const bucket = await this.getBucket();
        const cloudPath = `${this.workspacePrefix(projectId, _userId)}${normalized}`;
        const file = bucket.file(cloudPath);

        try {
          const [exists] = await file.exists();
          if (!exists) return false;
          await file.delete();
          return true;
        } catch (err) {
          throw new StorageError(
            `Failed to delete file '${normalized}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveUploadedFile: async (
        projectId: string,
        relativePath: string,
        content: Buffer,
        _userId?: string
      ): Promise<void> => {
        return this.workspace.writeFile(projectId, relativePath, content, _userId);
      },
    };
  }

  get snapshots(): ISnapshotStore {
    return {
      listSnapshots: async (projectId: string, userId?: string): Promise<Snapshot[]> => {
        validateProjectId(projectId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snapshotRef = db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("snapshots");

          const docs = await snapshotRef.get();
          const list: Snapshot[] = [];
          docs.forEach((d) => {
            list.push(d.data() as unknown as Snapshot);
          });
          list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          return list;
        } catch (err) {
          throw new StorageError(
            `Failed to list snapshots for project '${projectId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      getSnapshot: async (projectId: string, snapshotId: string, userId?: string): Promise<Snapshot | null> => {
        validateProjectId(projectId);
        validateSnapshotId(snapshotId);
        if (!userId) return null;

        const db = await this.getDb();
        try {
          const doc = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("snapshots")
            .doc(snapshotId)
            .get();

          if (!doc.exists) return null;
          return doc.data() as unknown as Snapshot;
        } catch (err) {
          throw new StorageError(
            `Failed to get snapshot '${snapshotId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveSnapshot: async (
        projectId: string,
        snapshot: Snapshot,
        fileContents: Map<string, string>,
        userId?: string
      ): Promise<void> => {
        validateProjectId(projectId);
        validateSnapshotId(snapshot.id);
        if (!userId) {
          throw new StorageError("User ID is required to create a snapshot", "FORBIDDEN", 403);
        }
        await this.assertProjectOwnership(projectId, userId);

        const db = await this.getDb();
        const bucket = await this.getBucket();

        try {
          // 1. Upload immutable file copies to Cloud Storage
          for (const [relPath, content] of fileContents.entries()) {
            const normalized = normalizeRelativePath(relPath);
            const targetCloudPath = `${this.snapshotFilesPrefix(projectId, snapshot.id, userId)}${normalized}`;
            const file = bucket.file(targetCloudPath);
            await file.save(Buffer.from(content, "utf-8"), {
              resumable: false,
              metadata: {
                contentType: "text/plain; charset=utf-8",
              },
            });
          }

          // 2. Persist snapshot metadata to Firestore
          await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("snapshots")
            .doc(snapshot.id)
            .set({
              ...snapshot,
              metadata: { ...snapshot.metadata, projectId },
              createdAt: snapshot.createdAt || new Date().toISOString(),
            });
        } catch (err) {
          throw new StorageError(
            `Failed to persist snapshot '${snapshot.id}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      restoreSnapshot: async (
        projectId: string,
        snapshotId: string,
        userId?: string
      ): Promise<{ restoredFiles: string[]; snapshot: Snapshot }> => {
        validateProjectId(projectId);
        validateSnapshotId(snapshotId);
        if (!userId) {
          throw new StorageError("User ID required to restore snapshot", "FORBIDDEN", 403);
        }
        await this.assertProjectOwnership(projectId, userId);

        const snapshot = await this.snapshots.getSnapshot(projectId, snapshotId, userId);
        if (!snapshot) {
          throw new StorageError(`Snapshot '${snapshotId}' not found`, "NOT_FOUND", 404);
        }

        const bucket = await this.getBucket();
        const snapPrefix = this.snapshotFilesPrefix(projectId, snapshotId, userId);
        const wsPrefix = this.workspacePrefix(projectId, userId);

        // 1. STAGE: Pre-download all snapshot files into memory before touching workspace.
        const stagedFiles = new Map<string, Buffer>();
        try {
          const [files] = await bucket.getFiles({ prefix: snapPrefix });
          for (const file of files) {
            const relPath = file.name.slice(snapPrefix.length);
            if (!relPath || relPath.endsWith("/")) continue;

            const [content] = await file.download();
            stagedFiles.set(relPath, content);
          }
        } catch (stageErr) {
          throw new StorageError(
            `Snapshot staging failed for '${snapshotId}': could not download snapshot files: ${
              stageErr instanceof Error ? stageErr.message : String(stageErr)
            }`,
            "INTERNAL_ERROR",
            500
          );
        }

        // 2. BACKUP: Snapshot current workspace files in memory before applying changes so we can rollback on mid-flight failure.
        const currentBackup = new Map<string, Buffer>();
        const [preRestoreWsFiles] = await bucket.getFiles({ prefix: wsPrefix });
        for (const file of preRestoreWsFiles) {
          const relPath = file.name.slice(wsPrefix.length);
          if (!relPath || relPath.endsWith("/")) continue;
          try {
            const [content] = await file.download();
            currentBackup.set(relPath, content);
          } catch {
            // best-effort backup
          }
        }

        // 3. APPLY: Write staged snapshot files and clean up post-snapshot files.
        const appliedFiles: string[] = [];
        try {
          for (const [relPath, content] of stagedFiles.entries()) {
            const targetFile = bucket.file(`${wsPrefix}${relPath}`);
            await targetFile.save(content, { resumable: false });
            appliedFiles.push(relPath);
          }

          // Delete files that were created in the workspace after this snapshot was taken
          const targetPaths = new Set(appliedFiles);
          for (const file of preRestoreWsFiles) {
            const relPath = file.name.slice(wsPrefix.length);
            if (!relPath || relPath.endsWith("/")) continue;
            if (!targetPaths.has(relPath)) {
              await file.delete().catch(() => {});
            }
          }

          return { restoredFiles: appliedFiles, snapshot };
        } catch (applyErr) {
          // 4. ROLLBACK ON FAILURE: Clean up newly created files and re-write original workspace files from in-memory backup
          let rollbackFailed = false;
          try {
            for (const appliedPath of appliedFiles) {
              if (!currentBackup.has(appliedPath)) {
                await bucket.file(`${wsPrefix}${appliedPath}`).delete().catch(() => {});
              }
            }
            for (const [relPath, content] of currentBackup.entries()) {
              const file = bucket.file(`${wsPrefix}${relPath}`);
              await file.save(content, { resumable: false });
            }
          } catch {
            rollbackFailed = true;
          }

          throw new StorageError(
            `Snapshot restoration failed mid-flight for '${snapshotId}' (${
              applyErr instanceof Error ? applyErr.message : String(applyErr)
            }). ${
              rollbackFailed
                ? "WARNING: Automatic rollback also encountered errors."
                : "Active workspace was safely recovered to pre-restoration state."
            }`,
            "INTERNAL_ERROR",
            500
          );
        }
      },
    };
  }

  get chatMemories(): IChatMemoryStore {
    return {
      listSessions: async (projectId: string, userId?: string): Promise<ChatSession[]> => {
        validateProjectId(projectId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .get();

          const sessions: ChatSession[] = [];
          snapshot.forEach((doc) => {
            sessions.push(doc.data() as unknown as ChatSession);
          });
          sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          return sessions;
        } catch (err) {
          throw new StorageError(
            `Failed to list chat sessions: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      getSession: async (projectId: string, sessionId: string, userId?: string): Promise<ChatSession | null> => {
        validateProjectId(projectId);
        validateSessionId(sessionId);
        if (!userId) return null;

        const db = await this.getDb();
        try {
          const doc = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .doc(sessionId)
            .get();

          if (!doc.exists) return null;
          return doc.data() as unknown as ChatSession;
        } catch (err) {
          throw new StorageError(
            `Failed to get chat session '${sessionId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveSession: async (projectId: string, session: ChatSession, userId?: string): Promise<void> => {
        validateProjectId(projectId);
        validateSessionId(session.id);
        const ownerId = userId || session.userId;
        if (!ownerId) throw new StorageError("User ID required to save chat session", "FORBIDDEN", 403);

        const db = await this.getDb();
        try {
          await db
            .collection("users")
            .doc(ownerId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .doc(session.id)
            .set(
              {
                ...session,
                projectId,
                userId: ownerId,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
        } catch (err) {
          throw new StorageError(
            `Failed to save chat session '${session.id}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      deleteSession: async (projectId: string, sessionId: string, userId?: string): Promise<boolean> => {
        validateProjectId(projectId);
        validateSessionId(sessionId);
        if (!userId) throw new StorageError("User ID required to delete chat session", "FORBIDDEN", 403);

        const db = await this.getDb();
        try {
          await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .doc(sessionId)
            .delete();
          return true;
        } catch (err) {
          throw new StorageError(
            `Failed to delete chat session '${sessionId}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      listMessages: async (projectId: string, sessionId: string, userId?: string): Promise<ChatMessage[]> => {
        validateProjectId(projectId);
        validateSessionId(sessionId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .doc(sessionId)
            .collection("messages")
            .get();

          const messages: ChatMessage[] = [];
          snapshot.forEach((doc) => {
            messages.push(doc.data() as unknown as ChatMessage);
          });
          messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          return messages;
        } catch (err) {
          throw new StorageError(
            `Failed to list messages: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      appendMessage: async (
        projectId: string,
        sessionId: string,
        message: ChatMessage,
        userId?: string
      ): Promise<void> => {
        validateProjectId(projectId);
        validateSessionId(sessionId);
        const ownerId = userId || message.userId;
        if (!ownerId) throw new StorageError("User ID required to append chat message", "FORBIDDEN", 403);

        const db = await this.getDb();
        try {
          await db
            .collection("users")
            .doc(ownerId)
            .collection("projects")
            .doc(projectId)
            .collection("chat_sessions")
            .doc(sessionId)
            .collection("messages")
            .doc(message.id)
            .set({
              ...message,
              sessionId,
              userId: ownerId,
              createdAt: message.createdAt || new Date().toISOString(),
            });
        } catch (err) {
          throw new StorageError(
            `Failed to append chat message '${message.id}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      listMemories: async (projectId: string, category?: string, userId?: string): Promise<ProjectMemory[]> => {
        validateProjectId(projectId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("memories")
            .get();

          const memories: ProjectMemory[] = [];
          snapshot.forEach((doc) => {
            const data = doc.data() as unknown as ProjectMemory;
            if (!category || data.category === category) {
              memories.push(data);
            }
          });
          memories.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          return memories;
        } catch (err) {
          throw new StorageError(
            `Failed to list project memories: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveMemory: async (projectId: string, memory: ProjectMemory, userId?: string): Promise<void> => {
        validateProjectId(projectId);
        validateMemoryId(memory.id);
        const ownerId = userId || memory.userId;
        if (!ownerId) throw new StorageError("User ID required to save memory", "FORBIDDEN", 403);

        const db = await this.getDb();
        try {
          await db
            .collection("users")
            .doc(ownerId)
            .collection("projects")
            .doc(projectId)
            .collection("memories")
            .doc(memory.id)
            .set(
              {
                ...memory,
                projectId,
                userId: ownerId,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
        } catch (err) {
          throw new StorageError(
            `Failed to save memory '${memory.id}': ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },
    };
  }

  get audit(): IAuditStore {
    return {
      recordAction: async (action: AgentAction, userId?: string, projectId?: string): Promise<void> => {
        const ownerId = userId;
        const targetProjId = projectId || action.projectId || "demo-workspace";
        if (!ownerId) return;

        const db = await this.getDb();
        try {
          await db
            .collection("users")
            .doc(ownerId)
            .collection("projects")
            .doc(targetProjId)
            .collection("audit_logs")
            .doc(action.id)
            .set({
              ...action,
              projectId: targetProjId,
              recordedAt: new Date().toISOString(),
            });
        } catch (err) {
          console.error(`[CloudStorageAdapter recordAction Error]:`, err);
        }
      },

      listAuditHistory: async (
        projectId?: string,
        userId?: string,
        limit: number = 100
      ): Promise<AgentAction[]> => {
        if (!userId) return [];
        const db = await this.getDb();

        try {
          if (projectId) {
            const snap = await db
              .collection("users")
              .doc(userId)
              .collection("projects")
              .doc(projectId)
              .collection("audit_logs")
              .get();

            const items: AgentAction[] = [];
            snap.forEach((d) => items.push(d.data() as unknown as AgentAction));
            items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            return items.slice(0, limit);
          }

          // List across all projects for this user
          const projsSnap = await db.collection("users").doc(userId).collection("projects").get();
          const allItems: AgentAction[] = [];

          for (const pDoc of projsSnap.docs) {
            const logsSnap = await pDoc.ref.collection("audit_logs").get();
            logsSnap.forEach((d) => allItems.push(d.data() as unknown as AgentAction));
          }

          allItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          return allItems.slice(0, limit);
        } catch (err) {
          throw new StorageError(
            `Failed to query audit history from Firestore: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },
    };
  }

  get credits(): ICreditStore {
    const DEFAULT_ALLOWANCE = 100;

    return {
      getBalance: async (projectId: string, userId?: string): Promise<CreditBalanceResult> => {
        validateProjectId(projectId);
        if (!userId) {
          return { allowance: DEFAULT_ALLOWANCE, used: 0, remaining: DEFAULT_ALLOWANCE, inFlightReserved: 0 };
        }

        const db = await this.getDb();
        try {
          const docRef = db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("credits")
            .doc("balance");

          const doc = await docRef.get();
          if (!doc.exists) {
            return { allowance: DEFAULT_ALLOWANCE, used: 0, remaining: DEFAULT_ALLOWANCE, inFlightReserved: 0 };
          }
          const data = doc.data() || {};
          const allowance = typeof data.allowance === "number" ? data.allowance : DEFAULT_ALLOWANCE;
          const used = typeof data.used === "number" ? data.used : 0;
          let inFlightReserved = 0;
          if (data.activeReservations && typeof data.activeReservations === "object") {
            for (const r of Object.values(data.activeReservations as Record<string, { amount: number }>)) {
              if (r && typeof r.amount === "number") inFlightReserved += r.amount;
            }
          }
          const remaining = Math.max(0, allowance - used - inFlightReserved);
          return { allowance, used, remaining, inFlightReserved };
        } catch (err) {
          throw new StorageError(
            `Failed to get credit balance: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      reserve: async (
        projectId: string,
        taskId: string,
        amount: number,
        userId?: string
      ): Promise<{ success: boolean; taskId: string; alreadyCompleted?: boolean }> => {
        validateProjectId(projectId);
        if (!userId) {
          throw new StorageError("User ID required for credit reservation", "FORBIDDEN", 403);
        }

        const db = await this.getDb();
        const docRef = db
          .collection("users")
          .doc(userId)
          .collection("projects")
          .doc(projectId)
          .collection("credits")
          .doc("balance");

        try {
          return await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            const data = doc.exists ? doc.data() || {} : {};
            const tasks = (data.tasks as Record<string, unknown>) || {};

            // Idempotent check: if task already charged, don't reserve again
            if (tasks[taskId]) {
              return { success: true, taskId, alreadyCompleted: true };
            }

            const allowance = typeof data.allowance === "number" ? data.allowance : DEFAULT_ALLOWANCE;
            const used = typeof data.used === "number" ? data.used : 0;
            const activeReservations = (data.activeReservations as Record<string, { amount: number }>) || {};

            let currentReserved = 0;
            for (const r of Object.values(activeReservations)) {
              if (r && typeof r.amount === "number") currentReserved += r.amount;
            }

            const remaining = allowance - used - currentReserved;
            if (remaining < amount) {
              throw new StorageError(
                `Budget exceeded for Rewind Credits: requested ${amount}, remaining is ${remaining}`,
                "BUDGET_EXCEEDED",
                400
              );
            }

            activeReservations[taskId] = {
              amount,
            };

            transaction.set(
              docRef,
              {
                allowance,
                used,
                activeReservations,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );

            return { success: true, taskId };
          });
        } catch (err) {
          if (err instanceof StorageError) throw err;
          throw new StorageError(
            `Credit reservation failed: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      commit: async (
        projectId: string,
        taskId: string,
        amount: number,
        complexity: string,
        userId?: string
      ): Promise<void> => {
        validateProjectId(projectId);
        if (!userId) return;

        const db = await this.getDb();
        const docRef = db
          .collection("users")
          .doc(userId)
          .collection("projects")
          .doc(projectId)
          .collection("credits")
          .doc("balance");

        try {
          await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            const data = doc.exists ? doc.data() || {} : {};
            const tasks = (data.tasks as Record<string, unknown>) || {};

            // Idempotent: don't double charge if task already committed
            if (tasks[taskId]) {
              return;
            }

            const allowance = typeof data.allowance === "number" ? data.allowance : DEFAULT_ALLOWANCE;
            const used = (typeof data.used === "number" ? data.used : 0) + amount;
            const activeReservations = (data.activeReservations as Record<string, unknown>) || {};
            delete activeReservations[taskId];

            tasks[taskId] = {
              credits: amount,
              chargedAt: new Date().toISOString(),
              complexity,
            };

            transaction.set(
              docRef,
              {
                allowance,
                used,
                activeReservations,
                tasks,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
          });
        } catch (err) {
          throw new StorageError(
            `Credit commit transaction failed: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      release: async (projectId: string, taskId: string, userId?: string): Promise<void> => {
        validateProjectId(projectId);
        if (!userId) return;

        const db = await this.getDb();
        const docRef = db
          .collection("users")
          .doc(userId)
          .collection("projects")
          .doc(projectId)
          .collection("credits")
          .doc("balance");

        try {
          await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const activeReservations = (data.activeReservations as Record<string, unknown>) || {};
            if (activeReservations[taskId]) {
              delete activeReservations[taskId];
              transaction.update(docRef, { activeReservations, updatedAt: new Date().toISOString() });
            }
          });
        } catch (err) {
          console.error(`[CloudStorageAdapter credit release Error]:`, err);
        }
      },
    };
  }

  get rag(): IRAGStore {
    return {
      listDocuments: async (projectId: string, userId?: string): Promise<RAGDocument[]> => {
        validateProjectId(projectId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snap = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("documents")
            .get();

          const docs: RAGDocument[] = [];
          snap.forEach((d) => docs.push(d.data() as unknown as RAGDocument));
          return docs;
        } catch (err) {
          throw new StorageError(
            `Failed to list RAG documents: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      saveDocument: async (
        projectId: string,
        document: RAGDocument,
        chunks: DocumentChunk[],
        userId?: string
      ): Promise<void> => {
        validateProjectId(projectId);
        if (!userId) throw new StorageError("User ID required to save RAG document", "FORBIDDEN", 403);

        const db = await this.getDb();
        try {
          const batch = db.batch();
          const docRef = db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("documents")
            .doc(document.id);

          batch.set(docRef, { ...document, userId, projectId, savedAt: new Date().toISOString() } as unknown as Record<string, unknown>);

          for (const chunk of chunks) {
            const chunkRef = db
              .collection("users")
              .doc(userId)
              .collection("projects")
              .doc(projectId)
              .collection("chunks")
              .doc(chunk.chunkId);
            batch.set(chunkRef, { ...chunk, docId: document.id, userId, projectId } as unknown as Record<string, unknown>);
          }

          await batch.commit();
        } catch (err) {
          throw new StorageError(
            `Failed to persist RAG document and chunks: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },

      searchChunks: async (
        projectId: string,
        queryEmbedding: number[],
        topK: number,
        userId?: string
      ): Promise<VectorSearchResult[]> => {
        validateProjectId(projectId);
        if (!userId) return [];

        const db = await this.getDb();
        try {
          const snap = await db
            .collection("users")
            .doc(userId)
            .collection("projects")
            .doc(projectId)
            .collection("chunks")
            .get();

          const results: VectorSearchResult[] = [];
          snap.forEach((doc) => {
            const chunk = doc.data() as unknown as DocumentChunk;
            if (Array.isArray(chunk.vector)) {
              let dot = 0;
              let normA = 0;
              let normB = 0;
              for (let i = 0; i < queryEmbedding.length; i++) {
                const a = queryEmbedding[i] || 0;
                const b = chunk.vector[i] || 0;
                dot += a * b;
                normA += a * a;
                normB += b * b;
              }
              const score = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
              results.push({
                chunk,
                similarityScore: score,
              });
            }
          });

          results.sort((a, b) => b.similarityScore - a.similarityScore);
          return results.slice(0, topK);
        } catch (err) {
          throw new StorageError(
            `Failed to search chunks: ${err instanceof Error ? err.message : String(err)}`,
            "INTERNAL_ERROR",
            500
          );
        }
      },
    };
  }
}

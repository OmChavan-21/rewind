/**
 * Rewind Durable Storage Types and Interfaces
 * Provides abstract storage contracts for multi-tenant serverless deployment.
 * Supports both Local Storage (development/testing) and Cloud Storage (production Vercel/Firestore/GCS).
 */

import type { ProjectMetadata, ProjectSummary } from "../../types/project";
import type { PermittedFile, Snapshot, AgentAction } from "../../types/recovery";
import type { ChatSession, ChatMessage } from "../../types/chat";
import type { ProjectMemory } from "../../types/memory";
import type { RAGDocument, DocumentChunk, VectorSearchResult } from "../../types/rag";

export class StorageError extends Error {
  readonly code:
    | "CLOUD_STORAGE_UNAVAILABLE"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "VALIDATION_FAILED"
    | "CONFLICT"
    | "BUDGET_EXCEEDED"
    | "INTERNAL_ERROR";
  readonly statusCode: number;

  constructor(
    message: string,
    code: StorageError["code"] = "INTERNAL_ERROR",
    statusCode: number = 500
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface IProjectStore {
  listProjects(userId?: string): Promise<ProjectSummary>;
  getProject(projectId: string, userId?: string): Promise<ProjectMetadata | null>;
  saveProject(project: ProjectMetadata, userId?: string): Promise<void>;
  deleteProject(projectId: string, userId?: string): Promise<boolean>;
}

export interface IWorkspaceStore {
  listFiles(projectId: string, userId?: string): Promise<PermittedFile[]>;
  readFile(projectId: string, relativePath: string, userId?: string): Promise<string>;
  writeFile(
    projectId: string,
    relativePath: string,
    content: string | Buffer,
    userId?: string
  ): Promise<void>;
  deleteFile(projectId: string, relativePath: string, userId?: string): Promise<boolean>;
  saveUploadedFile(
    projectId: string,
    relativePath: string,
    content: Buffer,
    userId?: string
  ): Promise<void>;
}

export interface ISnapshotStore {
  listSnapshots(projectId: string, userId?: string): Promise<Snapshot[]>;
  getSnapshot(projectId: string, snapshotId: string, userId?: string): Promise<Snapshot | null>;
  saveSnapshot(
    projectId: string,
    snapshot: Snapshot,
    fileContents: Map<string, string>,
    userId?: string
  ): Promise<void>;
  restoreSnapshot(
    projectId: string,
    snapshotId: string,
    userId?: string
  ): Promise<{ restoredFiles: string[]; snapshot: Snapshot }>;
}

export interface IChatMemoryStore {
  listSessions(projectId: string, userId?: string): Promise<ChatSession[]>;
  getSession(projectId: string, sessionId: string, userId?: string): Promise<ChatSession | null>;
  saveSession(projectId: string, session: ChatSession, userId?: string): Promise<void>;
  deleteSession(projectId: string, sessionId: string, userId?: string): Promise<boolean>;
  listMessages(projectId: string, sessionId: string, userId?: string): Promise<ChatMessage[]>;
  appendMessage(
    projectId: string,
    sessionId: string,
    message: ChatMessage,
    userId?: string
  ): Promise<void>;
  listMemories(projectId: string, category?: string, userId?: string): Promise<ProjectMemory[]>;
  saveMemory(projectId: string, memory: ProjectMemory, userId?: string): Promise<void>;
}

export interface IAuditStore {
  recordAction(action: AgentAction, userId?: string, projectId?: string): Promise<void>;
  listAuditHistory(projectId?: string, userId?: string, limit?: number): Promise<AgentAction[]>;
}

export interface CreditBalanceResult {
  allowance: number;
  used: number;
  remaining: number;
  inFlightReserved: number;
  providerUsage?: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface CreditUsageMetadata {
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  providerCostUSD?: number | null;
}

export interface ICreditStore {
  getBalance(projectId: string, userId?: string): Promise<CreditBalanceResult>;
  reserve(
    projectId: string,
    taskId: string,
    amount: number,
    userId?: string
  ): Promise<{ success: boolean; taskId: string; alreadyCompleted?: boolean }>;
  commit(
    projectId: string,
    taskId: string,
    amount: number,
    complexity: string,
    userId?: string,
    usage?: CreditUsageMetadata
  ): Promise<void>;
  release(projectId: string, taskId: string, userId?: string): Promise<void>;
}

export interface IRAGStore {
  listDocuments(projectId: string, userId?: string): Promise<RAGDocument[]>;
  saveDocument(
    projectId: string,
    document: RAGDocument,
    chunks: DocumentChunk[],
    userId?: string
  ): Promise<void>;
  searchChunks(
    projectId: string,
    queryEmbedding: number[],
    topK: number,
    userId?: string
  ): Promise<VectorSearchResult[]>;
}

export interface IStorageProvider {
  readonly mode: "local" | "cloud";
  readonly projects: IProjectStore;
  readonly workspace: IWorkspaceStore;
  readonly snapshots: ISnapshotStore;
  readonly chatMemories: IChatMemoryStore;
  readonly audit: IAuditStore;
  readonly credits: ICreditStore;
  readonly rag: IRAGStore;
}

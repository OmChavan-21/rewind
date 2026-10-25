/**
 * Rewind - Core Recovery Engine Types
 * AI-agent reliability and recovery platform (Phase 1)
 */

export type WorkspaceStatus = "healthy" | "degraded" | "recovering" | "error";

export interface Workspace {
  id: string;
  name: string;
  relativePath: string;
  description: string;
  fileCount: number;
  lastSnapshotAt?: string;
  status: WorkspaceStatus;
}

export interface SnapshotFileRecord {
  path: string; // Relative canonical path (e.g. "src/evaluator.ts")
  hash: string; // SHA-256
  size: number;
  modifiedAt: string;
  mode?: number;
}

export interface Snapshot {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  createdAt: string;
  totalFiles: number;
  totalBytes: number;
  files: SnapshotFileRecord[];
  metadata?: Record<string, unknown>;
}

export type FileChangeType = "added" | "modified" | "deleted" | "unchanged";

export interface FileChange {
  path: string;
  type: FileChangeType;
  oldHash?: string;
  newHash?: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

export type ActionType =
  | "snapshot_create"
  | "file_modify"
  | "file_upload"
  | "demo_break"
  | "restore"
  | "validate"
  | "workspace_init";

export interface AgentAction {
  id: string;
  projectId?: string;
  timestamp: string;
  actionType: ActionType;
  targetPath?: string;
  summary: string;
  status: "success" | "failure";
  snapshotIdBefore?: string;
  snapshotIdAfter?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ValidationCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  details?: string;
}

export interface ValidationResult {
  passed: boolean;
  timestamp: string;
  target: string;
  checks: ValidationCheck[];
  summary: string;
  executionTimeMs: number;
}

export interface RecoveryConflict {
  path: string;
  reason: string;
  expectedHash?: string;
  actualHash?: string;
}

export interface RecoveryResult {
  success: boolean;
  snapshotId: string;
  restoredAt: string;
  preRestoreValidation?: ValidationResult;
  postRestoreValidation?: ValidationResult;
  restoredFiles: string[];
  conflicts: RecoveryConflict[];
  message: string;
}

export interface PermittedFile {
  path: string;
  size: number;
  hash: string;
  modifiedAt: string;
  extension: string;
}

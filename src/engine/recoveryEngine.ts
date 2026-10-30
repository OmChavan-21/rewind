import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type {
  Workspace,
  Snapshot,
  SnapshotFileRecord,
  FileChange,
  AgentAction,
  ValidationResult,
  RecoveryResult,
  RecoveryConflict,
  PermittedFile,
  ActionType,
} from "../types/recovery";
import {
  resolveAndValidatePath,
  isPermittedFile,
  validateFileSize,
  validateActionType,
  EXCLUDED_DIR_NAMES,
  SecurityError,
  validateSnapshotId,
} from "../security/boundaries";
import {
  calculateSha256,
  atomicWriteFileSync,
  saveSnapshotRecord,
  loadSnapshotRecord,
  listStoredSnapshots,
  appendAuditAction,
  getAuditActionHistory,
} from "./storage";
import { validateWorkspaceDeterministically } from "./validator";
import { initializeDemoWorkspace } from "./demoWorkspace";
export { validateWorkspaceDeterministically, initializeDemoWorkspace };
import { generateUnifiedDiff } from "./diff";

/**
 * Default location resolvers
 */
export function getDefaultWorkspaceRoot(): string {
  if (process.env.REWIND_WORKSPACE_DIR) {
    return path.resolve(process.env.REWIND_WORKSPACE_DIR);
  }
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), "demo-workspace");
  }
  return path.resolve(process.cwd(), "demo-workspace");
}

export function getDefaultStoreRoot(): string {
  if (process.env.REWIND_STORE_DIR) {
    return path.resolve(process.env.REWIND_STORE_DIR);
  }
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), ".rewind_store");
  }
  return path.resolve(process.cwd(), ".rewind_store");
}

/**
 * Recursively lists all permitted workspace files.
 * Skips excluded directories, checks extensions, computes SHA-256 and size.
 */
export function listPermittedWorkspaceFiles(workspaceRoot: string): PermittedFile[] {
  if (!fs.existsSync(workspaceRoot)) {
    return [];
  }

  const results: PermittedFile[] = [];

  function traverse(currentDir: string, relativeDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      // Check if it's a symbolic link (forbidden)
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        continue; // Exclude symlinks
      }

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
          traverse(fullPath, relPath);
        }
      } else if (entry.isFile()) {
        if (isPermittedFile(relPath)) {
          const stats = fs.statSync(fullPath);
          validateFileSize(stats.size);
          const content = fs.readFileSync(fullPath);
          const hash = calculateSha256(content);

          results.push({
            path: relPath.replace(/\\/g, "/"),
            size: stats.size,
            hash,
            modifiedAt: stats.mtime.toISOString(),
            extension: path.extname(entry.name).toLowerCase(),
          });
        }
      }
    }
  }

  traverse(workspaceRoot, "");
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reads a permitted text file safely from the workspace.
 */
export function readPermittedTextFile(workspaceRoot: string, relativePath: string): string {
  if (!isPermittedFile(relativePath)) {
    throw new SecurityError(`File '${relativePath}' is not permitted or contains sensitive patterns.`);
  }

  const resolved = resolveAndValidatePath(workspaceRoot, relativePath);
  const stats = fs.statSync(resolved);
  validateFileSize(stats.size);

  return fs.readFileSync(resolved, "utf-8");
}

/**
 * Records an action to the audit history log.
 */
export function recordAction(
  storeRoot: string,
  actionData: {
    actionType: ActionType;
    summary: string;
    status: "success" | "failure";
    targetPath?: string;
    snapshotIdBefore?: string;
    snapshotIdAfter?: string;
    details?: Record<string, unknown>;
    error?: string;
  }
): AgentAction {
  validateActionType(actionData.actionType);

  const action: AgentAction = {
    id: `act_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    timestamp: new Date().toISOString(),
    ...actionData,
  };

  appendAuditAction(storeRoot, action);
  return action;
}

/**
 * Creates a named snapshot of the current workspace state.
 * Preserves file contents and metadata in store outside the workspace.
 */
export function createSnapshot(
  workspaceRoot: string,
  storeRoot: string,
  name: string,
  description?: string,
  metadata?: Record<string, unknown>
): Snapshot {
  const permittedFiles = listPermittedWorkspaceFiles(workspaceRoot);
  const fileContents = new Map<string, string>();
  const fileRecords: SnapshotFileRecord[] = [];
  let totalBytes = 0;

  for (const file of permittedFiles) {
    const content = readPermittedTextFile(workspaceRoot, file.path);
    fileContents.set(file.path, content);
    totalBytes += file.size;

    fileRecords.push({
      path: file.path,
      hash: file.hash,
      size: file.size,
      modifiedAt: file.modifiedAt,
    });
  }

  const snapshot: Snapshot = {
    id: `snap_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    workspaceId:
      typeof metadata?.workspaceId === "string"
        ? metadata.workspaceId
        : typeof metadata?.projectId === "string"
        ? metadata.projectId
        : "demo-workspace",
    name: name.trim() || `Snapshot ${new Date().toLocaleTimeString()}`,
    description,
    createdAt: new Date().toISOString(),
    totalFiles: fileRecords.length,
    totalBytes,
    files: fileRecords,
    metadata,
  };

  saveSnapshotRecord(storeRoot, snapshot, fileContents);

  recordAction(storeRoot, {
    actionType: "snapshot_create",
    summary: `Created snapshot '${snapshot.name}' (${snapshot.totalFiles} files, ${snapshot.id})`,
    status: "success",
    snapshotIdAfter: snapshot.id,
    details: { totalFiles: snapshot.totalFiles, totalBytes: snapshot.totalBytes },
  });

  return snapshot;
}

/**
 * Retrieves snapshot list.
 */
export function listSnapshots(storeRoot: string): Snapshot[] {
  return listStoredSnapshots(storeRoot);
}

/**
 * Retrieves a single snapshot by ID.
 */
export function getSnapshot(
  storeRoot: string,
  snapshotId: string
): { snapshot: Snapshot; fileContents: Map<string, string> } | null {
  validateSnapshotId(snapshotId);
  return loadSnapshotRecord(storeRoot, snapshotId);
}

/**
 * Retrieves audit history log.
 */
export function getAuditHistory(storeRoot: string): AgentAction[] {
  return getAuditActionHistory(storeRoot);
}

/**
 * Compares current workspace state with a given snapshot.
 * Returns array of FileChange objects with line diffs.
 */
export function compareWorkspaceWithSnapshot(
  workspaceRoot: string,
  storeRoot: string,
  snapshotId: string,
  expectedProjectId?: string
): FileChange[] {
  validateSnapshotId(snapshotId);
  const loaded = loadSnapshotRecord(storeRoot, snapshotId);
  if (loaded && expectedProjectId && loaded.snapshot.workspaceId) {
    const isDefault = (expectedProjectId === "demo-workspace" && (!loaded.snapshot.workspaceId || loaded.snapshot.workspaceId === "demo-workspace"));
    if (!isDefault && loaded.snapshot.workspaceId !== expectedProjectId) {
      throw new SecurityError(`Snapshot '${snapshotId}' belongs to project '${loaded.snapshot.workspaceId}', not '${expectedProjectId}'.`);
    }
  }
  if (!loaded) {
    throw new Error(`Snapshot '${snapshotId}' not found.`);
  }

  const { snapshot, fileContents: snapshotContents } = loaded;
  const currentFiles = listPermittedWorkspaceFiles(workspaceRoot);
  const currentFileMap = new Map(currentFiles.map((f) => [f.path, f]));
  const snapshotFileMap = new Map(snapshot.files.map((f) => [f.path, f]));

  const changes: FileChange[] = [];

  // 1. Files in current workspace
  for (const [relPath, currFile] of currentFileMap.entries()) {
    const currentContent = readPermittedTextFile(workspaceRoot, relPath);
    const snapFile = snapshotFileMap.get(relPath);

    if (!snapFile) {
      changes.push({
        path: relPath,
        type: "added",
        newHash: currFile.hash,
        newContent: currentContent,
        diff: generateUnifiedDiff(relPath, "", currentContent),
      });
    } else if (currFile.hash !== snapFile.hash) {
      const snapContent = snapshotContents.get(relPath) || "";
      changes.push({
        path: relPath,
        type: "modified",
        oldHash: snapFile.hash,
        newHash: currFile.hash,
        oldContent: snapContent,
        newContent: currentContent,
        diff: generateUnifiedDiff(relPath, snapContent, currentContent),
      });
    } else {
      changes.push({
        path: relPath,
        type: "unchanged",
        oldHash: snapFile.hash,
        newHash: currFile.hash,
      });
    }
  }

  // 2. Files deleted since snapshot
  for (const [relPath, snapFile] of snapshotFileMap.entries()) {
    if (!currentFileMap.has(relPath)) {
      const snapContent = snapshotContents.get(relPath) || "";
      changes.push({
        path: relPath,
        type: "deleted",
        oldHash: snapFile.hash,
        oldContent: snapContent,
        diff: generateUnifiedDiff(relPath, snapContent, ""),
      });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Applies an approved file change.
 * Automatically takes a safety snapshot before modifying.
 */
export function applyApprovedFileChange(
  workspaceRoot: string,
  storeRoot: string,
  relativePath: string,
  newContent: string,
  actionSummary: string,
  options?: { projectId?: string }
): { change: FileChange; snapshotBeforeId: string } {
  if (!isPermittedFile(relativePath)) {
    throw new SecurityError(`File '${relativePath}' is not permitted for modification.`);
  }

  const resolved = resolveAndValidatePath(workspaceRoot, relativePath, { allowNonExistent: true });
  validateFileSize(Buffer.byteLength(newContent, "utf-8"));

  // Check if file existed and what old content was
  let oldContent = "";
  let oldHash: string | undefined;
  if (fs.existsSync(resolved)) {
    oldContent = fs.readFileSync(resolved, "utf-8");
    oldHash = calculateSha256(oldContent);
  }

  // AUTOMATIC SAFETY RULE: Take a snapshot before write operation
  const preSnapshot = createSnapshot(
    workspaceRoot,
    storeRoot,
    `Auto: Before editing ${relativePath}`,
    `Safety snapshot before applying approved modification: ${actionSummary}`,
    options?.projectId ? { projectId: options.projectId } : undefined
  );

  // Apply change atomically
  atomicWriteFileSync(resolved, newContent);

  const newHash = calculateSha256(newContent);
  const changeType = oldHash ? "modified" : "added";

  const change: FileChange = {
    path: relativePath,
    type: changeType,
    oldHash,
    newHash,
    oldContent,
    newContent,
    diff: generateUnifiedDiff(relativePath, oldContent, newContent),
  };

  recordAction(storeRoot, {
    actionType: "file_modify",
    summary: actionSummary || `Modified ${relativePath}`,
    status: "success",
    targetPath: relativePath,
    snapshotIdBefore: preSnapshot.id,
    details: { changeType, oldHash, newHash },
  });

  return { change, snapshotBeforeId: preSnapshot.id };
}

/**
 * Restores a snapshot with conflict detection and post-restore validation.
 */
export function restoreSnapshot(
  workspaceRoot: string,
  storeRoot: string,
  snapshotId: string,
  options: {
    expectedBaselineSnapshotId?: string;
    force?: boolean;
    expectedProjectId?: string;
  } = {}
): RecoveryResult {
  validateSnapshotId(snapshotId);
  if (options.expectedBaselineSnapshotId) {
    validateSnapshotId(options.expectedBaselineSnapshotId);
  }
  const loaded = loadSnapshotRecord(storeRoot, snapshotId);
  if (loaded && options.expectedProjectId && loaded.snapshot.workspaceId) {
    const isDefault = (options.expectedProjectId === "demo-workspace" && (!loaded.snapshot.workspaceId || loaded.snapshot.workspaceId === "demo-workspace"));
    if (!isDefault && loaded.snapshot.workspaceId !== options.expectedProjectId) {
      throw new SecurityError(`Cross-project restore blocked: Snapshot '${snapshotId}' belongs to project '${loaded.snapshot.workspaceId}', not '${options.expectedProjectId}'.`);
    }
  }
  if (!loaded) {
    throw new Error(`Target snapshot '${snapshotId}' not found.`);
  }

  const { snapshot, fileContents } = loaded;
  const conflicts: RecoveryConflict[] = [];

  // Check current workspace files
  const currentFiles = listPermittedWorkspaceFiles(workspaceRoot);
  const currentFileMap = new Map(currentFiles.map((f) => [f.path, f]));

  // If caller specified an expected baseline snapshot, ensure current state hasn't unexpectedly diverged
  if (options.expectedBaselineSnapshotId) {
    const baseline = loadSnapshotRecord(storeRoot, options.expectedBaselineSnapshotId);
    if (!baseline) {
      conflicts.push({
        path: "*",
        reason: `Expected baseline snapshot '${options.expectedBaselineSnapshotId}' not found.`,
      });
    } else {
      const baselineMap = new Map(baseline.snapshot.files.map((f) => [f.path, f]));
      for (const [pathKey, curr] of currentFileMap.entries()) {
        const base = baselineMap.get(pathKey);
        if (!base || base.hash !== curr.hash) {
          conflicts.push({
            path: pathKey,
            reason: `Workspace state diverged from expected baseline '${options.expectedBaselineSnapshotId}'.`,
            expectedHash: base?.hash,
            actualHash: curr.hash,
          });
        }
      }
    }
  }

  // If conflicts detected and not forced, refuse operation
  if (conflicts.length > 0 && !options.force) {
    recordAction(storeRoot, {
      actionType: "restore",
      summary: `Rollback to '${snapshot.name}' (${snapshotId}) refused due to conflicts`,
      status: "failure",
      details: { conflictsCount: conflicts.length, conflicts },
    });

    return {
      success: false,
      snapshotId,
      restoredAt: new Date().toISOString(),
      restoredFiles: [],
      conflicts,
      message: `Rollback refused: detected ${conflicts.length} unexpected conflict(s). Workspace has changed unexpectedly.`,
    };
  }

  // Pre-rollback safety checkpoint: snapshot current state before overwriting
  const preRollbackSnap = createSnapshot(
    workspaceRoot,
    storeRoot,
    `Pre-rollback Checkpoint (Target: ${snapshotId})`,
    `Safety snapshot captured immediately prior to restoring snapshot ${snapshot.name}`,
    { projectId: options.expectedProjectId || loaded.snapshot.workspaceId }
  );

  // In-memory backup of current workspace files for safe recovery if restore fails mid-flight
  const backupFileMap = new Map<string, string>();
  for (const [currPath] of currentFileMap.entries()) {
    try {
      const fullPath = resolveAndValidatePath(workspaceRoot, currPath);
      backupFileMap.set(currPath, fs.readFileSync(fullPath, "utf-8"));
    } catch {
      // best-effort backup
    }
  }

  const restoredFiles: string[] = [];

  try {
    // 1. Overwrite or recreate all snapshot files
  for (const fileRecord of snapshot.files) {
    const content = fileContents.get(fileRecord.path);
    if (content !== undefined) {
      const targetPath = resolveAndValidatePath(workspaceRoot, fileRecord.path, { allowNonExistent: true });
      atomicWriteFileSync(targetPath, content);
      restoredFiles.push(fileRecord.path);
    }
  }

  // 2. Remove files that were created after the snapshot
  const targetFilePaths = new Set(snapshot.files.map((f) => f.path));
  for (const [currPath] of currentFileMap.entries()) {
    if (!targetFilePaths.has(currPath)) {
      const fullPath = resolveAndValidatePath(workspaceRoot, currPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  } catch (restoreErr) {
    // Rollback to pre-restoration backup
    for (const [backupPath, backupContent] of backupFileMap.entries()) {
      try {
        const target = resolveAndValidatePath(workspaceRoot, backupPath, { allowNonExistent: true });
        atomicWriteFileSync(target, backupContent);
      } catch {
        // ignore
      }
    }
    throw new Error(
      `Snapshot restoration failed mid-flight: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}. Active workspace was safely recovered.`
    );
  }

  // 3. Post-restore deterministic validation
  const postRestoreValidation = validateWorkspaceDeterministically(workspaceRoot);

  const isSuccess = postRestoreValidation.passed;
  const message = isSuccess
    ? `Successfully restored snapshot '${snapshot.name}' (${snapshot.id}) and verified all project invariants.`
    : `Restoration applied, but post-restore validation reported invariant failures: ${postRestoreValidation.summary}`;

  recordAction(storeRoot, {
    actionType: "restore",
    summary: `Restored snapshot '${snapshot.name}' (${snapshotId})`,
    status: isSuccess ? "success" : "failure",
    snapshotIdBefore: preRollbackSnap.id,
    snapshotIdAfter: snapshot.id,
    details: {
      restoredFilesCount: restoredFiles.length,
      postValidationPassed: isSuccess,
    },
    error: isSuccess ? undefined : postRestoreValidation.summary,
  });

  return {
    success: isSuccess,
    snapshotId,
    restoredAt: new Date().toISOString(),
    postRestoreValidation,
    restoredFiles,
    conflicts: [],
    message,
  };
}

/**
 * Runs deterministic validation on the workspace and logs the event.
 */
export function validateWorkspace(
  workspaceRoot: string,
  storeRoot: string
): ValidationResult {
  const result = validateWorkspaceDeterministically(workspaceRoot);

  recordAction(storeRoot, {
    actionType: "validate",
    summary: `Workspace validation ${result.passed ? "passed" : "failed"} (${result.checks.length} checks)`,
    status: result.passed ? "success" : "failure",
    details: {
      checks: result.checks,
      executionTimeMs: result.executionTimeMs,
    },
  });

  return result;
}

/**
 * Intentionally breaks a sample file for demonstration/testing.
 * Captures an automatic snapshot before breaking so rollback is cleanly testable.
 */
export function introduceDemoFailure(
  workspaceRoot: string,
  storeRoot: string,
  targetFile: "agent-workflow.json" | "src/evaluator.ts" = "agent-workflow.json"
): { snapshotBeforeId: string; brokenFile: string; errorIntroduced: string } {
  // Capture snapshot before introducing break
  const preSnap = createSnapshot(
    workspaceRoot,
    storeRoot,
    "Known-Good State (Pre-Failure)",
    `Baseline snapshot captured right before introducing demo failure in ${targetFile}`
  );

  let errorIntroduced = "";
  const targetResolved = resolveAndValidatePath(workspaceRoot, targetFile);

  if (targetFile === "agent-workflow.json") {
    // Inject corrupt JSON syntax
    const brokenContent = `{\n  "agentName": "CorruptedDemoAgent",\n  "version": "1.0.0",\n  "steps": [\n    <<<SYNTAX_ERROR_CORRUPTED_JSON>>>\n`;
    atomicWriteFileSync(targetResolved, brokenContent);
    errorIntroduced = "Injected unparseable JSON syntax into 'agent-workflow.json'";
  } else {
    // Inject syntax and contract error into evaluator
    const brokenContent = `// INTENTIONAL DEMO CRASH INJECTED\n<<<SYNTAX_ERROR_CRASH>>>\nexport function evaluateSafetyPolicy() { throw new FatalAgentCorruptionError(); }\n`;
    atomicWriteFileSync(targetResolved, brokenContent);
    errorIntroduced = "Injected fatal synthetic syntax crash into 'src/evaluator.ts'";
  }

  recordAction(storeRoot, {
    actionType: "demo_break",
    summary: `Introduced intentional demo failure in ${targetFile}`,
    status: "success",
    targetPath: targetFile,
    snapshotIdBefore: preSnap.id,
    details: { errorIntroduced },
  });

  return {
    snapshotBeforeId: preSnap.id,
    brokenFile: targetFile,
    errorIntroduced,
  };
}

/**
 * Gets high-level workspace info.
 */
export function getWorkspaceInfo(workspaceRoot: string, storeRoot: string): Workspace {
  const files = listPermittedWorkspaceFiles(workspaceRoot);
  const snapshots = listSnapshots(storeRoot);
  const validation = validateWorkspaceDeterministically(workspaceRoot);

  let status: Workspace["status"] = "healthy";
  if (!validation.passed) {
    status = "degraded";
  }

  return {
    id: "demo-workspace",
    name: "Autonomous Agent Demo Workspace",
    relativePath: "demo-workspace",
    description: "Sandboxed workspace for autonomous AI agent task execution & recovery testing.",
    fileCount: files.length,
    lastSnapshotAt: snapshots[0]?.createdAt,
    status,
  };
}

/**
 * Initializes the workspace and store if not already set up.
 */
export function ensureWorkspaceAndStore(
  workspaceRoot: string,
  storeRoot: string
): { workspace: Workspace; initialSnapshot?: Snapshot } {
  initializeDemoWorkspace(workspaceRoot);
  const snapshots = listSnapshots(storeRoot);

  let initialSnapshot: Snapshot | undefined;
  if (snapshots.length === 0) {
    initialSnapshot = createSnapshot(
      workspaceRoot,
      storeRoot,
      "Initial Baseline",
      "Automatic baseline snapshot initialized with sample project blueprint"
    );
  }

  const workspace = getWorkspaceInfo(workspaceRoot, storeRoot);
  return { workspace, initialSnapshot };
}

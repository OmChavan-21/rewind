import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Snapshot, AgentAction } from "../types/recovery";
import { validateSnapshotId, SecurityError } from "../security/boundaries";

/**
 * Calculates SHA-256 hash of string or buffer content.
 */
export function calculateSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Performs an atomic file write by writing to a temporary sibling file and renaming.
 */
export function atomicWriteFileSync(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const randomSuffix = crypto.randomBytes(6).toString("hex");
  const tempPath = `${filePath}.${randomSuffix}.tmp`;

  fs.writeFileSync(tempPath, content);
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    // Windows fallback if target exists and rename requires overwrite
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tempPath, filePath);
    } catch (fallbackErr) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw fallbackErr;
    }
  }
}

/**
 * Ensures storage directories exist.
 */
export function ensureStoreLayout(storeRoot: string): {
  snapshotsDir: string;
  auditDir: string;
} {
  const snapshotsDir = path.join(storeRoot, "snapshots");
  const auditDir = path.join(storeRoot, "audit");

  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  return { snapshotsDir, auditDir };
}

/**
 * Persists a snapshot along with all its snapshot file copies.
 */
export function saveSnapshotRecord(
  storeRoot: string,
  snapshot: Snapshot,
  fileContents: Map<string, string>
): void {
  validateSnapshotId(snapshot.id);
  const { snapshotsDir } = ensureStoreLayout(storeRoot);
  const snapshotFolder = path.join(snapshotsDir, snapshot.id);

  // Containment verification: ensure target folder is strictly inside snapshotsDir
  const canonicalSnapshotsDir = fs.realpathSync(/*turbopackIgnore: true*/ snapshotsDir);
  const resolvedFolder = path.resolve(/*turbopackIgnore: true*/ snapshotFolder);
  if (!resolvedFolder.startsWith(canonicalSnapshotsDir + path.sep) && resolvedFolder !== canonicalSnapshotsDir) {
    throw new SecurityError(`Snapshot directory escapes store: ${snapshot.id}`);
  }

  const filesFolder = path.join(snapshotFolder, "files");

  if (!fs.existsSync(filesFolder)) {
    fs.mkdirSync(filesFolder, { recursive: true });
  }

  // Save each file snapshot
  for (const [relPath, content] of fileContents.entries()) {
    const targetFile = path.join(filesFolder, relPath);
    const targetParent = path.dirname(targetFile);
    if (!fs.existsSync(targetParent)) {
      fs.mkdirSync(targetParent, { recursive: true });
    }
    atomicWriteFileSync(targetFile, content);
  }

  // Save metadata
  const metaPath = path.join(snapshotFolder, "meta.json");
  atomicWriteFileSync(metaPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Loads a snapshot metadata and its backed files.
 */
export function loadSnapshotRecord(
  storeRoot: string,
  snapshotId: string
): { snapshot: Snapshot; fileContents: Map<string, string> } | null {
  validateSnapshotId(snapshotId);
  const { snapshotsDir } = ensureStoreLayout(storeRoot);
  const snapshotFolder = path.join(snapshotsDir, snapshotId);

  // Containment verification
  const canonicalSnapshotsDir = fs.existsSync(/*turbopackIgnore: true*/ snapshotsDir)
    ? fs.realpathSync(/*turbopackIgnore: true*/ snapshotsDir)
    : path.resolve(/*turbopackIgnore: true*/ snapshotsDir);
  const resolvedFolder = path.resolve(/*turbopackIgnore: true*/ snapshotFolder);
  if (!resolvedFolder.startsWith(canonicalSnapshotsDir + path.sep) && resolvedFolder !== canonicalSnapshotsDir) {
    throw new SecurityError(`Snapshot directory escapes store: ${snapshotId}`);
  }

  const metaPath = path.join(snapshotFolder, "meta.json");
  const filesFolder = path.join(snapshotFolder, "files");

  if (!fs.existsSync(metaPath)) {
    return null;
  }

  const metaContent = fs.readFileSync(metaPath, "utf-8");
  const snapshot: Snapshot = JSON.parse(metaContent);
  const fileContents = new Map<string, string>();

  for (const fileRecord of snapshot.files) {
    const storedFile = path.join(filesFolder, fileRecord.path);
    if (fs.existsSync(storedFile)) {
      fileContents.set(fileRecord.path, fs.readFileSync(storedFile, "utf-8"));
    }
  }

  return { snapshot, fileContents };
}

/**
 * Lists all stored snapshots sorted descending by creation time.
 */
export function listStoredSnapshots(storeRoot: string): Snapshot[] {
  const { snapshotsDir } = ensureStoreLayout(storeRoot);
  if (!fs.existsSync(/*turbopackIgnore: true*/ snapshotsDir)) {
    return [];
  }

  const entries = fs.readdirSync(/*turbopackIgnore: true*/ snapshotsDir, { withFileTypes: true });
  const snapshots: Snapshot[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const metaPath = path.join(snapshotsDir, entry.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const content = fs.readFileSync(metaPath, "utf-8");
          snapshots.push(JSON.parse(content));
        } catch {
          // Ignore corrupted entry
        }
      }
    }
  }

  return snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Appends an action to the application-level audit log.
 * Note: This is an application-level audit log for observability and debugging,
 * not a cryptographically tamper-proof hardware/blockchain audit log.
 */
export function appendAuditAction(storeRoot: string, action: AgentAction): void {
  const { auditDir } = ensureStoreLayout(storeRoot);
  const logFile = path.join(auditDir, "history.jsonl");

  const line = JSON.stringify(action) + "\n";
  fs.appendFileSync(logFile, line, "utf-8");
}

/**
 * Retrieves the application-level audit log history.
 */
export function getAuditActionHistory(storeRoot: string): AgentAction[] {
  const { auditDir } = ensureStoreLayout(storeRoot);
  const logFile = path.join(auditDir, "history.jsonl");

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const raw = fs.readFileSync(logFile, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const actions: AgentAction[] = [];

  for (const line of lines) {
    try {
      actions.push(JSON.parse(line));
    } catch {
      // Ignore malformed line
    }
  }

  return actions.reverse(); // Most recent first
}

import crypto from "node:crypto";
import { createSnapshot } from "@/engine/recoveryEngine";
import { getStorageProvider } from "@/server/storage/storageProvider";
import type { Snapshot } from "@/types/recovery";

interface CreateWorkspaceSnapshotOptions {
  workspaceRoot: string;
  storeRoot: string;
  projectId: string;
  userId: string;
  name: string;
  description: string;
}

/** Capture the current project files into the active storage provider. */
export async function createWorkspaceSnapshot({
  workspaceRoot,
  storeRoot,
  projectId,
  userId,
  name,
  description,
}: CreateWorkspaceSnapshotOptions): Promise<Snapshot> {
  const provider = getStorageProvider(storeRoot);
  if (provider.mode === "local") {
    return createSnapshot(workspaceRoot, storeRoot, name, description, { projectId });
  }

  const files = await provider.workspace.listFiles(projectId, userId);
  const fileContents = new Map<string, string>();
  for (const file of files) {
    fileContents.set(file.path, await provider.workspace.readFile(projectId, file.path, userId));
  }

  const snapshot: Snapshot = {
    id: `snap_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    workspaceId: projectId,
    name,
    description,
    createdAt: new Date().toISOString(),
    totalFiles: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files: files.map(({ path, hash, size, modifiedAt }) => ({ path, hash, size, modifiedAt })),
    metadata: { projectId },
  };

  await provider.snapshots.saveSnapshot(projectId, snapshot, fileContents, userId);
  return snapshot;
}

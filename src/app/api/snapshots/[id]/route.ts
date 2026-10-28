import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getSnapshot, compareWorkspaceWithSnapshot } from "@/engine/recoveryEngine";
import { validateSnapshotId, SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import type { FileChange } from "@/types/recovery";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    validateSnapshotId(id);

    const url = new URL(request.url);
    const projectIdParam = url.searchParams.get("projectId") || undefined;

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);

    if (provider.mode === "cloud") {
      const snapshot = await provider.snapshots.getSnapshot(projectId, id, user.uid);
      if (!snapshot) {
        return NextResponse.json({ error: `Snapshot '${id}' not found.` }, { status: 404 });
      }

      // Compute changes between current cloud workspace and snapshot
      const currentFiles = await provider.workspace.listFiles(projectId, user.uid);
      const currentMap = new Map(currentFiles.map((f) => [f.path, f.hash]));
      const snapshotMap = new Map(snapshot.files.map((f) => [f.path, f.hash]));

      const changes: FileChange[] = [];

      for (const snapFile of snapshot.files) {
        const currHash = currentMap.get(snapFile.path);
        if (!currHash) {
          changes.push({
            path: snapFile.path,
            type: "deleted",
            oldHash: snapFile.hash,
          });
        } else if (currHash !== snapFile.hash) {
          changes.push({
            path: snapFile.path,
            type: "modified",
            oldHash: snapFile.hash,
            newHash: currHash,
          });
        } else {
          changes.push({
            path: snapFile.path,
            type: "unchanged",
            oldHash: snapFile.hash,
            newHash: currHash,
          });
        }
      }

      for (const currFile of currentFiles) {
        if (!snapshotMap.has(currFile.path)) {
          changes.push({
            path: currFile.path,
            type: "added",
            newHash: currFile.hash,
          });
        }
      }

      return NextResponse.json({
        snapshot,
        changes,
      });
    }

    const data = getSnapshot(storeRoot, id);

    if (!data) {
      return NextResponse.json({ error: `Snapshot '${id}' not found.` }, { status: 404 });
    }

    const snapWorkspace = data.snapshot.workspaceId || "demo-workspace";
    if (snapWorkspace !== projectId) {
      const isDefaultAlias =
        projectId === "demo-workspace" &&
        (!data.snapshot.workspaceId || data.snapshot.workspaceId === "demo-workspace");
      if (!isDefaultAlias) {
        return NextResponse.json(
          { error: `Snapshot '${id}' does not belong to project '${projectId}'.` },
          { status: 403 }
        );
      }
    }

    await assertProjectAccessAsync(user, snapWorkspace, storeRoot, "read");

    const changes = compareWorkspaceWithSnapshot(workspaceRoot, storeRoot, id, projectId);

    return NextResponse.json({
      snapshot: data.snapshot,
      changes,
    });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Error loading snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

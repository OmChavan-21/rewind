import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getContextRoots } from "@/server/workspaceContext";
import { createSnapshot, listSnapshots } from "@/engine/recoveryEngine";
import { listProjectSnapshots } from "@/engine/projectManager";
import { syncSnapshotToFirebase } from "@/server/firebaseService";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import type { Snapshot } from "@/types/recovery";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;

    const { storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);

    if (projectIdParam) {
      await assertProjectAccessAsync(user, projectIdParam, storeRoot, "read");
    }

    const provider = getStorageProvider(storeRoot);
    let snapshots: Snapshot[];

    if (provider.mode === "local") {
      snapshots = projectIdParam
        ? listProjectSnapshots(projectIdParam, storeRoot)
        : listSnapshots(storeRoot);
    } else {
      snapshots = await provider.snapshots.listSnapshots(projectIdParam || "demo-workspace", user.uid);
    }

    return NextResponse.json({ snapshots, projectId });
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
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Manual Snapshot";
    const description = typeof body.description === "string" ? body.description.trim() : undefined;
    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const provider = getStorageProvider(storeRoot);
    let snapshot: Snapshot;

    if (provider.mode === "local") {
      snapshot = createSnapshot(workspaceRoot, storeRoot, name, description, { projectId });
      // Sync snapshot metadata to Firebase if configured
      await syncSnapshotToFirebase(user.uid, projectId, snapshot).catch(() => {});
    } else {
      const files = await provider.workspace.listFiles(projectId, user.uid);
      const fileContents = new Map<string, string>();
      for (const f of files) {
        const content = await provider.workspace.readFile(projectId, f.path, user.uid);
        fileContents.set(f.path, content);
      }
      const snapshotId = `snap_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      snapshot = {
        id: snapshotId,
        workspaceId: projectId,
        name,
        description,
        createdAt: new Date().toISOString(),
        totalFiles: files.length,
        totalBytes: files.reduce((acc, f) => acc + f.size, 0),
        files: files.map((f) => ({
          path: f.path,
          hash: f.hash,
          size: f.size,
          modifiedAt: f.modifiedAt,
        })),
        metadata: { projectId },
      };
      await provider.snapshots.saveSnapshot(projectId, snapshot, fileContents, user.uid);
    }

    return NextResponse.json({ snapshot, projectId }, { status: 201 });
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
    const message = error instanceof Error ? error.message : "Failed to create snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

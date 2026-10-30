import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { readPermittedTextFile } from "@/engine/recoveryEngine";
import { SecurityError, FileTooLargeError, UnsupportedFileTypeError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import { createWorkspaceSnapshot } from "@/server/workspaceSnapshots";
import type { AgentAction } from "@/types/recovery";
import crypto from "node:crypto";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get("path");
    const projectIdParam = searchParams.get("projectId") || undefined;

    if (!filePath) {
      return NextResponse.json({ error: "Query parameter 'path' is required." }, { status: 400 });
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);
    let content: string;

    if (provider.mode === "local") {
      content = readPermittedTextFile(workspaceRoot, filePath);
    } else {
      content = await provider.workspace.readFile(projectId, filePath, user.uid);
    }

    return NextResponse.json({ path: filePath, content });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof FileTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }

    const message = error instanceof Error ? error.message : "Error reading file";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get("path");
    const projectIdParam = searchParams.get("projectId") || undefined;
    if (!filePath) {
      return NextResponse.json({ error: "Query parameter 'path' is required." }, { status: 400 });
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");
    const provider = getStorageProvider(storeRoot);
    const existingFiles = await provider.workspace.listFiles(projectId, user.uid);
    if (!existingFiles.some((file) => file.path === filePath)) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }

    const snapshot = await createWorkspaceSnapshot({
      workspaceRoot,
      storeRoot,
      projectId,
      userId: user.uid,
      name: `Pre-delete: ${filePath}`.slice(0, 80),
      description: `Safety snapshot captured before deleting ${filePath}.`,
    });
    const deleted = await provider.workspace.deleteFile(projectId, filePath, user.uid);
    if (!deleted) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }

    const action: AgentAction = {
      id: `act_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      timestamp: new Date().toISOString(),
      actionType: "file_delete",
      summary: `Deleted '${filePath}' from project '${projectId}'`,
      status: "success",
      snapshotIdBefore: snapshot.id,
      details: { path: filePath },
      projectId,
      userId: user.uid,
    };
    await provider.audit.recordAction(action, user.uid, projectId);

    return NextResponse.json({ success: true, deletedPath: filePath, safetySnapshotId: snapshot.id });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Error deleting file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

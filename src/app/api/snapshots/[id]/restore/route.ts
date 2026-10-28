import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { restoreSnapshot } from "@/engine/recoveryEngine";
import { validateSnapshotId, SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import { enforceRateLimitAsync } from "@/security/rateLimiter";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitRes = await enforceRateLimitAsync(request, "snapshots_restore", 10, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const { id } = await params;
    validateSnapshotId(id);

    const body = await request.json().catch(() => ({}));
    const force = body.force !== false;
    const expectedBaselineSnapshotId = typeof body.expectedBaselineSnapshotId === "string"
      ? body.expectedBaselineSnapshotId
      : undefined;

    if (expectedBaselineSnapshotId) {
      validateSnapshotId(expectedBaselineSnapshotId);
    }

    const url = new URL(request.url);
    const projectIdParam = url.searchParams.get("projectId") || (typeof body.projectId === "string" ? body.projectId : undefined);
    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);

    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const provider = getStorageProvider(storeRoot);

    if (provider.mode === "local") {
      const result = restoreSnapshot(workspaceRoot, storeRoot, id, {
        force,
        expectedBaselineSnapshotId,
        expectedProjectId: projectId,
      });

      const statusCode = result.success ? 200 : result.conflicts.length > 0 ? 409 : 422;
      return NextResponse.json({ result }, { status: statusCode });
    } else {
      const { restoredFiles } = await provider.snapshots.restoreSnapshot(projectId, id, user.uid);
      const result = {
        success: true,
        snapshotId: id,
        restoredAt: new Date().toISOString(),
        restoredFiles,
        conflicts: [],
      };
      return NextResponse.json({ result }, { status: 200 });
    }
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
    const message = error instanceof Error ? error.message : "Error restoring snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

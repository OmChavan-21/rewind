import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getSnapshot, compareWorkspaceWithSnapshot } from "@/engine/recoveryEngine";
import { validateSnapshotId, SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

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
    assertProjectAccess(user, projectId, storeRoot, "read");

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

    assertProjectAccess(user, snapWorkspace, storeRoot, "read");

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
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Error loading snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

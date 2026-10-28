import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { createSnapshot, listSnapshots } from "@/engine/recoveryEngine";
import { listProjectSnapshots } from "@/engine/projectManager";
import { syncSnapshotToFirebase } from "@/server/firebaseService";
import {
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;

    const { storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);

    if (projectIdParam) {
      assertProjectAccess(user, projectIdParam, storeRoot, "read");
    }

    const snapshots = projectIdParam
      ? listProjectSnapshots(projectIdParam, storeRoot)
      : listSnapshots(storeRoot);

    return NextResponse.json({ snapshots, projectId });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
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
    assertProjectAccess(user, projectId, storeRoot, "write");

    const snapshot = createSnapshot(workspaceRoot, storeRoot, name, description, { projectId });

    // Sync snapshot metadata to Firebase if configured
    await syncSnapshotToFirebase(user.uid, projectId, snapshot).catch(() => {});

    return NextResponse.json({ snapshot, projectId }, { status: 201 });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Failed to create snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

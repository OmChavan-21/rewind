import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import {
  getWorkspaceInfo,
  initializeDemoWorkspace,
  validateWorkspaceDeterministically,
} from "@/engine/recoveryEngine";
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

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectId, storeRoot, "read");

    const info = getWorkspaceInfo(workspaceRoot, storeRoot);
    const validation = validateWorkspaceDeterministically(workspaceRoot);

    return NextResponse.json({
      workspace: { ...info, id: projectId },
      validation,
      projectId,
    });
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
    const force = Boolean(body.force);
    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectId, storeRoot, "write");

    initializeDemoWorkspace(workspaceRoot, force);
    const info = getWorkspaceInfo(workspaceRoot, storeRoot);
    const validation = validateWorkspaceDeterministically(workspaceRoot);

    return NextResponse.json({
      message: "Workspace initialized successfully",
      workspace: { ...info, id: projectId },
      validation,
      projectId,
    });
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

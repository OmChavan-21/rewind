import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listPermittedWorkspaceFiles } from "@/engine/recoveryEngine";
import { SecurityError } from "@/security/boundaries";
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

    const files = listPermittedWorkspaceFiles(workspaceRoot);
    return NextResponse.json({ files, projectId });
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
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

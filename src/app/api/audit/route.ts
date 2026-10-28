import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getAuditHistory } from "@/engine/recoveryEngine";
import { listProjects } from "@/engine/projectManager";
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
    const { storeRoot } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);

    if (projectIdParam && projectIdParam !== "demo-workspace") {
      assertProjectAccess(user, projectIdParam, storeRoot, "read");
    }

    const allActions = getAuditHistory(storeRoot);

    // If a specific project was requested, return only its actions
    if (projectIdParam) {
      const filtered = allActions.filter((a) =>
        projectIdParam === "demo-workspace"
          ? !a.projectId || a.projectId === "demo-workspace"
          : a.projectId === projectIdParam
      );
      return NextResponse.json({ actions: filtered, projectId: projectIdParam });
    }

    // Otherwise, admins see all actions; developers only see demo + their own projects
    if (user.role === "admin") {
      return NextResponse.json({ actions: allActions });
    }

    const userProjects = new Set(
      listProjects(storeRoot, user.uid).projects.map((p) => p.id)
    );
    userProjects.add("demo-workspace");

    const filtered = allActions.filter(
      (a) => !a.projectId || userProjects.has(a.projectId)
    );

    return NextResponse.json({ actions: filtered });
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

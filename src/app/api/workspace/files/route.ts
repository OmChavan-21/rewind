import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listPermittedWorkspaceFiles } from "@/engine/recoveryEngine";
import { SecurityError } from "@/security/boundaries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;

    const { workspaceRoot, projectId } = getContextRoots(projectIdParam);
    const files = listPermittedWorkspaceFiles(workspaceRoot);
    return NextResponse.json({ files, projectId });
  } catch (error: unknown) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listPermittedWorkspaceFiles } from "@/engine/recoveryEngine";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId") || undefined;

    const { workspaceRoot, projectId } = getContextRoots(projectIdParam);
    const files = listPermittedWorkspaceFiles(workspaceRoot);
    return NextResponse.json({ files, projectId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

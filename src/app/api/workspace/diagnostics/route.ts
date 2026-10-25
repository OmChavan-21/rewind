import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { runWorkspaceDiagnostics } from "@/engine/codeDiagnostics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId") || undefined;

    const { workspaceRoot, projectId: activeProjectId } = getContextRoots(projectId);
    const result = runWorkspaceDiagnostics(workspaceRoot, activeProjectId);

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error analyzing workspace diagnostics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;

    const { workspaceRoot, projectId: activeProjectId } = getContextRoots(projectId);
    const result = runWorkspaceDiagnostics(workspaceRoot, activeProjectId);

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error analyzing workspace diagnostics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

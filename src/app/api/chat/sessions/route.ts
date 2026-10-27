import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listChatSessions, createChatSession, DEFAULT_USER_ID } from "@/engine/chatMemoryStore";
import { getProject } from "@/engine/projectManager";
import { SecurityError } from "@/security/boundaries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId")?.trim() || "demo-workspace";
    const userIdParam = searchParams.get("userId")?.trim() || undefined;

    const { storeRoot } = getContextRoots(projectIdParam);

    // Verify project exists
    const proj = getProject(projectIdParam, storeRoot);
    if (!proj) {
      return NextResponse.json(
        { error: `Project '${projectIdParam}' not found.` },
        { status: 404 }
      );
    }

    const sessions = listChatSessions(projectIdParam, storeRoot, userIdParam);
    return NextResponse.json({ sessions, projectId: projectIdParam });
  } catch (err) {
    if (err instanceof SecurityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list chat sessions" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "demo-workspace";
    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const model = typeof body.model === "string" ? body.model.trim() : undefined;
    const routingMode = body.routingMode === "manual" ? "manual" : "auto";
    const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : DEFAULT_USER_ID;

    const { storeRoot } = getContextRoots(projectId);

    // Verify project exists
    const proj = getProject(projectId, storeRoot);
    if (!proj) {
      return NextResponse.json(
        { error: `Project '${projectId}' not found.` },
        { status: 404 }
      );
    }

    const session = createChatSession(
      {
        projectId,
        title,
        model,
        routingMode,
      },
      storeRoot,
      userId
    );

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    if (err instanceof SecurityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create chat session" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listChatSessions, createChatSession } from "@/engine/chatMemoryStore";
import { syncChatSessionToFirebase } from "@/server/firebaseService";
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
    const projectIdParam = searchParams.get("projectId")?.trim() || "demo-workspace";
    const { storeRoot } = getContextRoots(projectIdParam);

    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectIdParam, storeRoot, "read");

    const sessions = listChatSessions(projectIdParam, storeRoot, user.uid);
    return NextResponse.json({ sessions, projectId: projectIdParam });
  } catch (err) {
    if (
      err instanceof AuthenticationError ||
      err instanceof ForbiddenError ||
      err instanceof NotFoundError
    ) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
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
    const { storeRoot } = getContextRoots(projectId);

    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectId, storeRoot, "write");

    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const model = typeof body.model === "string" ? body.model.trim() : undefined;
    const routingMode = body.routingMode === "manual" ? "manual" : "auto";

    const session = createChatSession(
      {
        projectId,
        title,
        model,
        routingMode,
      },
      storeRoot,
      user.uid
    );

    // Sync session metadata to Firestore if configured
    await syncChatSessionToFirebase(user.uid, projectId, session).catch(() => {});

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    if (
      err instanceof AuthenticationError ||
      err instanceof ForbiddenError ||
      err instanceof NotFoundError
    ) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    if (err instanceof SecurityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create chat session" },
      { status: 500 }
    );
  }
}

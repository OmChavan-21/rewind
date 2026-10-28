import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getChatSession, listChatMessages } from "@/engine/chatMemoryStore";
import { SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

export async function GET(
  request: Request,
  props: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await props.params;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId")?.trim() || "demo-workspace";

    const { storeRoot } = getContextRoots(projectId);
    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectId, storeRoot, "read");

    const session = getChatSession(projectId, sessionId, storeRoot, user.uid);
    if (!session) {
      return NextResponse.json(
        { error: `Chat session '${sessionId}' not found in project '${projectId}'.` },
        { status: 404 }
      );
    }

    const messages = listChatMessages(projectId, sessionId, storeRoot, user.uid);

    return NextResponse.json({
      session,
      messages,
      projectId,
    });
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
      { error: err instanceof Error ? err.message : "Failed to retrieve session" },
      { status: 500 }
    );
  }
}

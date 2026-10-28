import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";

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
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);
    const session = await provider.chatMemories.getSession(projectId, sessionId, user.uid);
    if (!session) {
      return NextResponse.json(
        { error: `Chat session '${sessionId}' not found in project '${projectId}'.` },
        { status: 404 }
      );
    }

    const messages = await provider.chatMemories.listMessages(projectId, sessionId, user.uid);

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
    if (err instanceof StorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to retrieve session" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  props: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await props.params;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId")?.trim() || "demo-workspace";

    const { storeRoot } = getContextRoots(projectId);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const provider = getStorageProvider(storeRoot);
    const deleted = await provider.chatMemories.deleteSession(projectId, sessionId, user.uid);

    return NextResponse.json({ success: deleted, sessionId });
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
    if (err instanceof StorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete session" },
      { status: 500 }
    );
  }
}

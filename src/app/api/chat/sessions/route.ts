import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getContextRoots } from "@/server/workspaceContext";
import { createChatSession } from "@/engine/chatMemoryStore";
import { syncChatSessionToFirebase } from "@/server/firebaseService";
import { SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import { enforceRateLimitAsync } from "@/security/rateLimiter";
import type { ChatSession } from "@/types/chat";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get("projectId")?.trim() || "demo-workspace";
    const { storeRoot } = getContextRoots(projectIdParam);

    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectIdParam, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);
    const sessions = await provider.chatMemories.listSessions(projectIdParam, user.uid);
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
    if (err instanceof StorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list chat sessions" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const rateLimitRes = await enforceRateLimitAsync(request, "chat_sessions", 20, 60_000);
  if (rateLimitRes) {
    return rateLimitRes;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "demo-workspace";
    const { storeRoot } = getContextRoots(projectId);

    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const model = typeof body.model === "string" ? body.model.trim() : undefined;
    const routingMode = body.routingMode === "manual" ? "manual" : "auto";

    const provider = getStorageProvider(storeRoot);
    let session: ChatSession;

    if (provider.mode === "local") {
      session = createChatSession(
        {
          projectId,
          title,
          model,
          routingMode,
        },
        storeRoot,
        user.uid
      );
      await syncChatSessionToFirebase(user.uid, projectId, session).catch(() => {});
    } else {
      const sessionId = `session_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      session = {
        id: sessionId,
        projectId,
        title: title || "New Chat Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        extractedMemoriesCount: 0,
        lastMessageAt: new Date().toISOString(),
        activeModel: model || "nvidia/nemotron-3.5-lightning-30b-a3b",
        routingMode,
        userId: user.uid,
      };
      await provider.chatMemories.saveSession(projectId, session, user.uid);
    }

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
    if (err instanceof StorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create chat session" },
      { status: 500 }
    );
  }
}

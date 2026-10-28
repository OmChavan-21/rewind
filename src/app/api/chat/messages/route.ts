import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getContextRoots } from "@/server/workspaceContext";
import { addChatMessage } from "@/engine/chatMemoryStore";
import { extractAndPersistMemories } from "@/server/ai/memoryMembrane";
import { syncChatMessageToFirebase } from "@/server/firebaseService";
import { SecurityError } from "@/security/boundaries";
import type { ChatRole, ChatMessage } from "@/types/chat";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "demo-workspace";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const role: ChatRole = body.role === "assistant" ? "assistant" : body.role === "system" ? "system" : "user";
    const reasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : undefined;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : undefined;

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
    }

    if (!content) {
      return NextResponse.json({ error: "content cannot be empty." }, { status: 400 });
    }

    if (content.length > 5000) {
      return NextResponse.json(
        { error: "Message content exceeds maximum allowed length of 5000 characters." },
        { status: 400 }
      );
    }

    const { storeRoot } = getContextRoots(projectId);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const provider = getStorageProvider(storeRoot);

    // Verify session exists and belongs to user
    const session = await provider.chatMemories.getSession(projectId, sessionId, user.uid);
    if (!session) {
      return NextResponse.json(
        { error: `Chat session '${sessionId}' not found in project '${projectId}'.` },
        { status: 404 }
      );
    }

    // Save message
    let savedMessage: ChatMessage;
    if (provider.mode === "local") {
      savedMessage = addChatMessage(
        projectId,
        sessionId,
        {
          role,
          content,
          reasoning,
          proposalId,
          tokenUsage: body.tokenUsage,
        },
        storeRoot,
        user.uid
      );
      // Sync message to Firestore if configured
      await syncChatMessageToFirebase(user.uid, projectId, sessionId, savedMessage).catch(() => {});
    } else {
      const messageId = `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      savedMessage = {
        id: messageId,
        sessionId,
        projectId,
        role,
        content,
        reasoning,
        proposalId,
        tokenUsage: body.tokenUsage,
        createdAt: new Date().toISOString(),
        userId: user.uid,
      };
      await provider.chatMemories.appendMessage(projectId, sessionId, savedMessage, user.uid);
    }

    // If role is user, distill core intentions into project membrane
    let extractedMemories: unknown[] = [];
    if (role === "user") {
      const extraction = extractAndPersistMemories({
        projectId,
        sessionId,
        messageId: savedMessage.id,
        userPrompt: content,
        storeRoot,
        userId: user.uid,
      });
      extractedMemories = extraction.extractedMemories;
    }

    return NextResponse.json(
      {
        message: savedMessage,
        extractedMemories,
      },
      { status: 201 }
    );
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
      { error: err instanceof Error ? err.message : "Failed to send message" },
      { status: 500 }
    );
  }
}

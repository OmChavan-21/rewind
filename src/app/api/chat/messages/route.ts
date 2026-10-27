import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { addChatMessage, getChatSession, DEFAULT_USER_ID } from "@/engine/chatMemoryStore";
import { extractAndPersistMemories } from "@/server/ai/memoryMembrane";
import { SecurityError } from "@/security/boundaries";
import type { ChatRole } from "@/types/chat";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "demo-workspace";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const role: ChatRole = body.role === "assistant" ? "assistant" : body.role === "system" ? "system" : "user";
    const reasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : undefined;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : undefined;
    const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : DEFAULT_USER_ID;

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

    // Verify session exists and belongs to user
    const session = getChatSession(projectId, sessionId, storeRoot, userId);
    if (!session) {
      return NextResponse.json(
        { error: `Chat session '${sessionId}' not found in project '${projectId}'.` },
        { status: 404 }
      );
    }

    // Save message
    const savedMessage = addChatMessage(
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
      userId
    );

    // If role is user, distill core intentions into project membrane
    let extractedMemories: unknown[] = [];
    if (role === "user") {
      const extraction = extractAndPersistMemories({
        projectId,
        sessionId,
        messageId: savedMessage.id,
        userPrompt: content,
        storeRoot,
        userId,
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
    if (err instanceof SecurityError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to post message" },
      { status: 500 }
    );
  }
}

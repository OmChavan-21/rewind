import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import {
  listProjectMemories,
  saveProjectMemory,
  deactivateProjectMemory,
} from "@/engine/chatMemoryStore";
import { syncProjectMemoryToFirebase } from "@/server/firebaseService";
import { SecurityError } from "@/security/boundaries";
import type { MemoryCategory, ProjectMemory } from "@/types/memory";
import crypto from "node:crypto";
import {
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await props.params;
    const { storeRoot } = getContextRoots(projectId);
    const user = await requireAuthenticatedUser(request, storeRoot);

    assertProjectAccess(user, projectId, storeRoot, "read");

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("activeOnly") !== "false";

    const memories = listProjectMemories(projectId, storeRoot, user.uid, activeOnly);
    return NextResponse.json({ memories, projectId });
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
      { error: err instanceof Error ? err.message : "Failed to list project memories" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await props.params;
    const { storeRoot } = getContextRoots(projectId);
    const user = await requireAuthenticatedUser(request, storeRoot);

    assertProjectAccess(user, projectId, storeRoot, "write");

    const body = await request.json().catch(() => ({}));

    // Action: deactivate
    if (body.action === "deactivate") {
      const memoryId = typeof body.memoryId === "string" ? body.memoryId.trim() : "";
      if (!memoryId) {
        return NextResponse.json({ error: "memoryId is required to deactivate." }, { status: 400 });
      }
      const deactivated = deactivateProjectMemory(projectId, memoryId, storeRoot, user.uid);
      return NextResponse.json({ success: deactivated, memoryId });
    }

    // Action: create / update
    const category: MemoryCategory =
      body.category === "architectural_decision" ||
      body.category === "technical_constraint" ||
      body.category === "resolved_pattern"
        ? body.category
        : "project_intent";

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const distilledIntent = typeof body.distilledIntent === "string" ? body.distilledIntent.trim() : "";
    const importance = typeof body.importance === "number" ? Math.max(1, Math.min(5, body.importance)) : 3;
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

    if (!title || !distilledIntent) {
      return NextResponse.json(
        { error: "Both title and distilledIntent are required." },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const memoryId =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : `pmem_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    const memory: ProjectMemory = {
      id: memoryId,
      projectId,
      userId: user.uid,
      category,
      title,
      distilledIntent,
      importance,
      tags,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const saved = saveProjectMemory(projectId, memory, storeRoot, user.uid);
    // Sync memory to Firestore if configured
    await syncProjectMemoryToFirebase(user.uid, projectId, saved).catch(() => {});
    return NextResponse.json({ memory: saved }, { status: 201 });
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
      { error: err instanceof Error ? err.message : "Failed to modify memory" },
      { status: 500 }
    );
  }
}

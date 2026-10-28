import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { askProjectQuestion } from "@/server/ragService";
import { SecurityError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;
    const topK = typeof body.topK === "number" && body.topK > 0 ? Math.min(body.topK, 15) : 5;

    if (!question) {
      return NextResponse.json(
        { error: "Question is required." },
        { status: 400 }
      );
    }

    if (question.length > 2000) {
      return NextResponse.json(
        { error: "Question exceeds maximum length of 2000 characters." },
        { status: 400 }
      );
    }

    const { storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    assertProjectAccess(user, projectId, storeRoot, "read");

    const result = await askProjectQuestion(projectId, question, topK);

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Error asking project documents";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

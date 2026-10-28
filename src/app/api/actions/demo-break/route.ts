import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { introduceDemoFailure } from "@/engine/recoveryEngine";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
} from "@/server/auth";

export async function POST(request: Request) {
  try {
    const { workspaceRoot, storeRoot, projectId } = getContextRoots();
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const body = await request.json().catch(() => ({}));
    const target = body.targetFile === "src/evaluator.ts" ? "src/evaluator.ts" : "agent-workflow.json";

    const result = introduceDemoFailure(workspaceRoot, storeRoot, target);

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Error introducing demo failure";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

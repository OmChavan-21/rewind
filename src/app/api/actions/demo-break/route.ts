import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { introduceDemoFailure } from "@/engine/recoveryEngine";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const target = body.targetFile === "src/evaluator.ts" ? "src/evaluator.ts" : "agent-workflow.json";

    const { workspaceRoot, storeRoot } = getContextRoots();
    const result = introduceDemoFailure(workspaceRoot, storeRoot, target);

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error introducing demo failure";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

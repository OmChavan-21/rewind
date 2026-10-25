import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { validateWorkspace } from "@/engine/recoveryEngine";

export async function POST() {
  try {
    const { workspaceRoot, storeRoot } = getContextRoots();
    const validation = validateWorkspace(workspaceRoot, storeRoot);

    return NextResponse.json({ validation });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error validating workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

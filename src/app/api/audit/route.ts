import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getAuditHistory } from "@/engine/recoveryEngine";

export async function GET() {
  try {
    const { storeRoot } = getContextRoots();
    const actions = getAuditHistory(storeRoot);
    return NextResponse.json({ actions });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

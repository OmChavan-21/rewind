import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getAuditHistory } from "@/engine/recoveryEngine";
import {
  requireAuthenticatedUser,
  AuthenticationError,
  ForbiddenError,
} from "@/server/auth";

export async function GET(request: Request) {
  try {
    const { storeRoot } = getContextRoots();
    await requireAuthenticatedUser(request, storeRoot);
    const actions = getAuditHistory(storeRoot);
    return NextResponse.json({ actions });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

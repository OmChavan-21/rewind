import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { validateWorkspace } from "@/engine/recoveryEngine";
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
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const validation = validateWorkspace(workspaceRoot, storeRoot);

    return NextResponse.json({ validation });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError || error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Error validating workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

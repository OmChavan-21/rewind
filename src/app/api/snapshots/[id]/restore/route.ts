import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { restoreSnapshot } from "@/engine/recoveryEngine";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const force = body.force !== false; // Default to true if user triggered explicit UI restore, or read flag
    const expectedBaselineSnapshotId = typeof body.expectedBaselineSnapshotId === "string"
      ? body.expectedBaselineSnapshotId
      : undefined;

    const url = new URL(request.url);
    const projectIdParam = url.searchParams.get("projectId") || (typeof body.projectId === "string" ? body.projectId : undefined);
    const { workspaceRoot, storeRoot } = getContextRoots(projectIdParam);
    const result = restoreSnapshot(workspaceRoot, storeRoot, id, {
      force,
      expectedBaselineSnapshotId,
    });

    const statusCode = result.success ? 200 : result.conflicts.length > 0 ? 409 : 422;
    return NextResponse.json({ result }, { status: statusCode });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error restoring snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

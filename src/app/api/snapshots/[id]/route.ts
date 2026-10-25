import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { getSnapshot, compareWorkspaceWithSnapshot } from "@/engine/recoveryEngine";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { workspaceRoot, storeRoot } = getContextRoots();
    const data = getSnapshot(storeRoot, id);

    if (!data) {
      return NextResponse.json({ error: `Snapshot '${id}' not found.` }, { status: 404 });
    }

    const changes = compareWorkspaceWithSnapshot(workspaceRoot, storeRoot, id);

    return NextResponse.json({
      snapshot: data.snapshot,
      changes,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error loading snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

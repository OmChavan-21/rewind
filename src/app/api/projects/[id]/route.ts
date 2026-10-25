import { NextResponse } from "next/server";
import {
  getProject,
  setActiveProject,
  listProjectSnapshots,
} from "@/engine/projectManager";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const params = await props.params;
    const storeRoot = getDefaultStoreRoot();
    const project = getProject(params.id, storeRoot);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const snapshots = listProjectSnapshots(params.id, storeRoot);

    return NextResponse.json({
      project,
      snapshots,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch project";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const params = await props.params;
    const storeRoot = getDefaultStoreRoot();
    const activeProject = setActiveProject(params.id, storeRoot);

    return NextResponse.json({
      message: `Active project switched to '${activeProject.name}'`,
      project: activeProject,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to set active project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

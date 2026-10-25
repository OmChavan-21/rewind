import { NextResponse } from "next/server";
import {
  listProjects,
  createProject,
} from "@/engine/projectManager";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { syncProjectToFirebase } from "@/server/firebaseService";

export async function GET() {
  try {
    const storeRoot = getDefaultStoreRoot();
    const summary = listProjects(storeRoot);
    return NextResponse.json(summary);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to list projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const storeRoot = getDefaultStoreRoot();
    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : undefined;
    const template = body.template === "demo" ? "demo" : "empty";

    if (!name) {
      return NextResponse.json(
        { error: "Project name is required." },
        { status: 400 }
      );
    }

    const newProject = createProject({ name, description, template }, storeRoot);

    // Sync to Firebase if configured
    await syncProjectToFirebase("default_user", newProject).catch(() => {});

    const summary = listProjects(storeRoot);
    return NextResponse.json({
      project: newProject,
      activeProjectId: newProject.id,
      projects: summary.projects,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

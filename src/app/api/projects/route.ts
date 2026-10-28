import { NextResponse } from "next/server";
import {
  listProjects,
  createProject,
} from "@/engine/projectManager";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { syncProjectToFirebase } from "@/server/firebaseService";
import { requireAuthenticatedUser, AuthenticationError, ForbiddenError } from "@/server/auth";

export async function GET(request: Request) {
  try {
    const storeRoot = getDefaultStoreRoot();
    const user = await requireAuthenticatedUser(request, storeRoot);
    const summary = listProjects(storeRoot, user.uid);
    return NextResponse.json(summary);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Failed to list projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const storeRoot = getDefaultStoreRoot();
    const user = await requireAuthenticatedUser(request, storeRoot);
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

    const newProject = createProject({ name, description, template }, storeRoot, user.uid);

    // Sync to Firebase if configured
    await syncProjectToFirebase(user.uid, newProject).catch(() => {});

    const summary = listProjects(storeRoot, user.uid);
    return NextResponse.json({
      project: newProject,
      activeProjectId: newProject.id,
      projects: summary.projects,
    });
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Failed to create project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

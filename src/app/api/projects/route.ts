import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  createProject,
} from "@/engine/projectManager";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import { syncProjectToFirebase } from "@/server/firebaseService";
import {
  requireAuthenticatedUser,
  AuthenticationError,
  ForbiddenError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";
import type { ProjectMetadata } from "@/types/project";
import { INITIAL_DEMO_PROJECT } from "@/engine/demoWorkspace";

export async function GET(request: Request) {
  try {
    const storeRoot = getDefaultStoreRoot();
    const user = await requireAuthenticatedUser(request, storeRoot);
    const provider = getStorageProvider(storeRoot);
    const summary = await provider.projects.listProjects(user.uid);
    return NextResponse.json(summary);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
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

    const provider = getStorageProvider(storeRoot);
    let newProject: ProjectMetadata;

    if (provider.mode === "local") {
      newProject = createProject({ name, description, template }, storeRoot, user.uid);
      await syncProjectToFirebase(user.uid, newProject).catch(() => {});
    } else {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30);
      const uniqueId = `proj_${slug || "workspace"}_${crypto.randomBytes(3).toString("hex")}`;
      newProject = {
        id: uniqueId,
        name,
        ...(description ? { description } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspacePath: `projects/${uniqueId}`,
        fileCount: template === "demo" ? Object.keys(INITIAL_DEMO_PROJECT).length : 1,
        totalSizeBytes: 0,
        snapshotCount: 0,
        status: "active",
        userId: user.uid,
      };
      await provider.projects.saveProject(newProject, user.uid);
      if (template === "demo") {
        for (const [relativePath, content] of Object.entries(INITIAL_DEMO_PROJECT)) {
          await provider.workspace.writeFile(newProject.id, relativePath, content, user.uid);
        }
      } else {
        const starterReadme = `# ${name}\n\n${description || "Created with Rewind."}\n\nWorkspace initialized: ${new Date().toISOString()}\n`;
        await provider.workspace.writeFile(newProject.id, "README.md", starterReadme, user.uid);
      }
    }

    const summary = await provider.projects.listProjects(user.uid);
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
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Failed to create project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

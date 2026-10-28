import { NextResponse } from "next/server";
import { setActiveProject } from "@/engine/projectManager";
import { getDefaultStoreRoot } from "@/engine/recoveryEngine";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";

export async function GET(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const params = await props.params;
    const storeRoot = getDefaultStoreRoot();
    const user = await requireAuthenticatedUser(request, storeRoot);

    const project = await assertProjectAccessAsync(user, params.id, storeRoot, "read");
    const provider = getStorageProvider(storeRoot);
    const snapshots = await provider.snapshots.listSnapshots(params.id, user.uid);

    return NextResponse.json({
      project,
      snapshots,
    });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
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
    const user = await requireAuthenticatedUser(request, storeRoot);

    const project = await assertProjectAccessAsync(user, params.id, storeRoot, "write");
    const provider = getStorageProvider(storeRoot);
    let activeProject = project;

    if (provider.mode === "local") {
      activeProject = setActiveProject(params.id, storeRoot);
    }

    return NextResponse.json({
      message: `Active project switched to '${activeProject.name}'`,
      project: activeProject,
    });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Failed to set active project";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

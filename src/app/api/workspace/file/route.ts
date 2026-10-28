import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { readPermittedTextFile } from "@/engine/recoveryEngine";
import { SecurityError, FileTooLargeError, UnsupportedFileTypeError } from "@/security/boundaries";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get("path");
    const projectIdParam = searchParams.get("projectId") || undefined;

    if (!filePath) {
      return NextResponse.json({ error: "Query parameter 'path' is required." }, { status: 400 });
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);
    let content: string;

    if (provider.mode === "local") {
      content = readPermittedTextFile(workspaceRoot, filePath);
    } else {
      content = await provider.workspace.readFile(projectId, filePath, user.uid);
    }

    return NextResponse.json({ path: filePath, content });
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof FileTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }

    const message = error instanceof Error ? error.message : "Error reading file";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

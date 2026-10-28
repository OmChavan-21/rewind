import { NextResponse } from "next/server";
import fs from "node:fs";
import { getContextRoots } from "@/server/workspaceContext";
import { resolveAndValidatePath } from "@/security/boundaries";
import { ingestDocument, loadProjectVectorStore } from "@/server/ragService";
import { syncDocumentToFirebase } from "@/server/firebaseService";
import {
  requireAuthenticatedUser,
  assertProjectAccessAsync,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@/server/auth";
import { getStorageProvider, StorageError } from "@/server/storage/storageProvider";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;

    if (!filePath) {
      return NextResponse.json(
        { error: "filePath is required to index a document." },
        { status: 400 }
      );
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "write");

    const provider = getStorageProvider(storeRoot);
    let buffer: Buffer;

    if (provider.mode === "cloud") {
      const contentStr = await provider.workspace.readFile(projectId, filePath, user.uid);
      buffer = Buffer.from(contentStr, "utf-8");
    } else {
      const canonicalPath = resolveAndValidatePath(workspaceRoot, filePath);
      if (!fs.existsSync(canonicalPath)) {
        return NextResponse.json(
          { error: `File '${filePath}' does not exist in workspace.` },
          { status: 404 }
        );
      }
      buffer = fs.readFileSync(canonicalPath);
    }

    const ragDoc = await ingestDocument(projectId, filePath, buffer, storeRoot);

    if (provider.mode === "cloud") {
      const store = loadProjectVectorStore(projectId, storeRoot);
      const docChunks = store.chunks.filter((c) => c.docId === ragDoc.id);
      await provider.rag.saveDocument(projectId, ragDoc, docChunks, user.uid);
    } else {
      // Sync metadata to Firebase if configured
      await syncDocumentToFirebase(user.uid, projectId, ragDoc).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      document: ragDoc,
      message: `Successfully indexed '${filePath}' into ${ragDoc.chunkCount} vector chunks.`,
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
    const message = error instanceof Error ? error.message : "Error ingesting document into RAG";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

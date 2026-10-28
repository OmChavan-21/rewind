import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { loadProjectVectorStore } from "@/server/ragService";
import { SecurityError } from "@/security/boundaries";
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
    const projId = searchParams.get("projectId") || undefined;

    const { projectId, storeRoot } = getContextRoots(projId);
    const user = await requireAuthenticatedUser(request, storeRoot);
    await assertProjectAccessAsync(user, projectId, storeRoot, "read");

    const provider = getStorageProvider(storeRoot);

    if (provider.mode === "cloud") {
      const documents = await provider.rag.listDocuments(projectId, user.uid);
      return NextResponse.json({
        projectId,
        embeddingModel: "deterministic_projection_128",
        vectorDimensions: 128,
        documents,
        totalChunks: documents.reduce((sum, d) => sum + (d.chunkCount || 0), 0),
        updatedAt: new Date().toISOString(),
      });
    }

    const store = loadProjectVectorStore(projectId, storeRoot);

    return NextResponse.json({
      projectId,
      embeddingModel: store.embeddingModel,
      vectorDimensions: store.vectorDimensions,
      documents: Object.values(store.documents),
      totalChunks: store.chunks.length,
      updatedAt: store.updatedAt,
    });
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
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : "Error listing RAG documents";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

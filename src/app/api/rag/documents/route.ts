import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { loadProjectVectorStore } from "@/server/ragService";
import { SecurityError } from "@/security/boundaries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projId = searchParams.get("projectId") || undefined;

    const { projectId, storeRoot } = getContextRoots(projId);
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
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Error listing RAG documents";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

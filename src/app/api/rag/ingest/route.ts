import { NextResponse } from "next/server";
import fs from "node:fs";
import { getContextRoots } from "@/server/workspaceContext";
import { resolveAndValidatePath } from "@/security/boundaries";
import { ingestDocument } from "@/server/ragService";
import { syncDocumentToFirebase } from "@/server/firebaseService";

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
    const canonicalPath = resolveAndValidatePath(workspaceRoot, filePath);

    if (!fs.existsSync(canonicalPath)) {
      return NextResponse.json(
        { error: `File '${filePath}' does not exist in workspace.` },
        { status: 404 }
      );
    }

    const buffer = fs.readFileSync(canonicalPath);
    const ragDoc = await ingestDocument(projectId, filePath, buffer, storeRoot);

    // Sync metadata to Firebase if configured
    await syncDocumentToFirebase("default_user", projectId, ragDoc).catch(() => {});

    return NextResponse.json({
      success: true,
      document: ragDoc,
      message: `Successfully indexed '${filePath}' into ${ragDoc.chunkCount} vector chunks.`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error ingesting document into RAG";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

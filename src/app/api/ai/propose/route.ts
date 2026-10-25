import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listPermittedWorkspaceFiles, readPermittedTextFile } from "@/engine/recoveryEngine";
import { generateChangeProposal, AIError } from "@/server/nebiusService";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "Please provide a prompt describing your desired change.", category: "invalid_payload" },
        { status: 400 }
      );
    }

    if (prompt.length > 3000) {
      return NextResponse.json(
        { error: "Prompt exceeds maximum allowed length of 3000 characters.", category: "invalid_payload" },
        { status: 400 }
      );
    }

    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;
    const { workspaceRoot } = getContextRoots(projectIdParam);
    const permittedFiles = listPermittedWorkspaceFiles(workspaceRoot);

    // Enforce AI context limits (max 20 files, max 200KB total)
    const contextFiles: { path: string; content: string }[] = [];
    let totalBytes = 0;
    const maxFiles = 20;
    const maxBytes = 200 * 1024;

    for (const file of permittedFiles.slice(0, maxFiles)) {
      if (file.path.endsWith(".pdf")) continue; // Skip binary PDFs in code change context
      const content = readPermittedTextFile(workspaceRoot, file.path);
      const byteLen = Buffer.byteLength(content, "utf-8");
      if (totalBytes + byteLen > maxBytes) break;
      contextFiles.push({ path: file.path, content });
      totalBytes += byteLen;
    }

    const proposal = await generateChangeProposal(prompt, contextFiles);

    return NextResponse.json({ proposal });
  } catch (err: unknown) {
    if (err instanceof AIError) {
      return NextResponse.json(
        {
          error: err.message,
          category: err.category,
          provider: err.provider,
          model: err.model,
          suggestion: err.suggestion,
        },
        { status: err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500 }
      );
    }

    const message = err instanceof Error ? err.message : "Error generating AI proposal";
    return NextResponse.json(
      { error: message, category: "provider_error" },
      { status: 500 }
    );
  }
}

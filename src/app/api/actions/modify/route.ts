import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { applyApprovedFileChange } from "@/engine/recoveryEngine";
import { SecurityError, FileTooLargeError, UnsupportedFileTypeError } from "@/security/boundaries";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    const summary = typeof body.summary === "string" ? body.summary.trim() : "Controlled modification";
    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;

    if (!filePath) {
      return NextResponse.json({ error: "Missing required parameter 'path'." }, { status: 400 });
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(projectIdParam);
    const result = applyApprovedFileChange(
      workspaceRoot,
      storeRoot,
      filePath,
      content,
      summary,
      { projectId }
    );

    return NextResponse.json({
      success: true,
      change: result.change,
      snapshotBeforeId: result.snapshotBeforeId,
    });
  } catch (error: unknown) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof FileTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Error modifying file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

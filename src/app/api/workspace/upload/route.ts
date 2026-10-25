import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getContextRoots } from "@/server/workspaceContext";
import {
  resolveAndValidatePath,
  isPermittedFile,
  sanitizeRelativePath,
  SecurityError,
  FileTooLargeError,
  ALLOWED_EXTENSIONS_LIST,
} from "@/security/boundaries";
import {
  validateUploadLimits,
  getDirectorySizeBytes,
  computeDynamicLimits,
} from "@/security/limits";
import {
  createSnapshot,
  listPermittedWorkspaceFiles,
  getDefaultStoreRoot,
} from "@/engine/recoveryEngine";
import { loadProjectsRegistry } from "@/engine/projectManager";
import { atomicWriteFileSync, appendAuditAction } from "@/engine/storage";
import { ingestDocument } from "@/server/ragService";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    const uploadedFiles: {
      name: string;
      contentBuffer: Buffer;
      relPath: string;
    }[] = [];
    let overwrite = false;
    let targetProjectId: string | undefined;
    let ingestToRAG = true;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      overwrite = formData.get("overwrite") === "true";
      const projId = formData.get("projectId");
      if (typeof projId === "string" && projId.trim()) {
        targetProjectId = projId.trim();
      }

      const ragVal = formData.get("ingestToRAG");
      if (ragVal !== null) {
        ingestToRAG = ragVal === "true";
      }

      let entries = formData.getAll("files");
      if (entries.length === 0) {
        entries = formData.getAll("file");
      }

      for (const entry of entries) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          "arrayBuffer" in entry &&
          typeof (entry as { arrayBuffer: unknown }).arrayBuffer === "function"
        ) {
          const fileEntry = entry as unknown as { name?: string; arrayBuffer: () => Promise<ArrayBuffer> };
          const fileName = typeof fileEntry.name === "string" && fileEntry.name.trim() ? fileEntry.name.trim() : "uploaded_file";
          const buffer = Buffer.from(await fileEntry.arrayBuffer());
          const cleanName = sanitizeRelativePath(fileName);
          uploadedFiles.push({
            name: fileName,
            contentBuffer: buffer,
            relPath: cleanName,
          });
        }
      }
    } else {
      // JSON payload support
      const body = await request.json().catch(() => ({}));
      overwrite = Boolean(body.overwrite);
      if (typeof body.projectId === "string" && body.projectId.trim()) {
        targetProjectId = body.projectId.trim();
      }
      if (body.ingestToRAG !== undefined) {
        ingestToRAG = Boolean(body.ingestToRAG);
      }

      if (Array.isArray(body.files)) {
        for (const f of body.files) {
          if (f && typeof f.name === "string" && f.name.trim()) {
            const cleanName = sanitizeRelativePath(f.name.trim());
            let buffer: Buffer;
            if (typeof f.base64 === "string") {
              buffer = Buffer.from(f.base64, "base64");
            } else if (typeof f.content === "string") {
              buffer = Buffer.from(f.content, "utf-8");
            } else {
              buffer = Buffer.from("");
            }
            uploadedFiles.push({
              name: f.name.trim(),
              contentBuffer: buffer,
              relPath: cleanName,
            });
          }
        }
      }
    }

    if (uploadedFiles.length === 0) {
      return NextResponse.json(
        { error: "No valid files received in upload request." },
        { status: 400 }
      );
    }

    // Server-side project validation: prevent uploading to non-existent or invalid projects
    const defaultStore = getDefaultStoreRoot();
    const registry = loadProjectsRegistry(defaultStore);
    if (targetProjectId && !registry.projects[targetProjectId]) {
      return NextResponse.json(
        { error: `Project '${targetProjectId}' does not exist.` },
        { status: 404 }
      );
    }

    const { workspaceRoot, storeRoot, projectId } = getContextRoots(targetProjectId);
    const currentStats = getDirectorySizeBytes(workspaceRoot);
    const dynamicLimits = computeDynamicLimits(currentStats.totalBytes);

    // 1. Validate dynamic resource limits (count, sizes, storage quota)
    const filesForValidation = uploadedFiles.map((f) => ({
      name: f.name,
      size: f.contentBuffer.length,
    }));
    validateUploadLimits(filesForValidation, currentStats.totalBytes, dynamicLimits);

    // 2. Validate paths, extensions, and check for existing file conflicts
    const conflictingFiles: string[] = [];
    const validatedFiles: {
      canonicalPath: string;
      relPath: string;
      buffer: Buffer;
      isPdf: boolean;
    }[] = [];

    for (const file of uploadedFiles) {
      // Validate extension and forbidden prefixes
      if (!isPermittedFile(file.relPath)) {
        return NextResponse.json(
          {
            error: `File '${file.name}' has an unsupported file type or forbidden name. Allowed types include: ${ALLOWED_EXTENSIONS_LIST.join(", ")}.`,
          },
          { status: 400 }
        );
      }

      // Allow non-existent target files on upload while verifying boundary containment and no symlink escape
      const canonicalPath = resolveAndValidatePath(workspaceRoot, file.relPath, { allowNonExistent: true });
      const isPdf = file.relPath.toLowerCase().endsWith(".pdf");

      if (fs.existsSync(canonicalPath) && !overwrite) {
        conflictingFiles.push(file.relPath);
      }

      validatedFiles.push({
        canonicalPath,
        relPath: file.relPath,
        buffer: file.contentBuffer,
        isPdf,
      });
    }

    // 3. If conflicts exist and overwrite was not approved, refuse write with conflict list
    if (conflictingFiles.length > 0) {
      return NextResponse.json(
        {
          error: "Files already exist in workspace. Overwrite confirmation required.",
          conflict: true,
          conflictingFiles,
        },
        { status: 409 }
      );
    }

    // 4. Capture an automatic safety snapshot before writing uploaded files
    const safetySnapshot = createSnapshot(
      workspaceRoot,
      storeRoot,
      `Pre-Upload Safety (${uploadedFiles.length} file${uploadedFiles.length > 1 ? "s" : ""})`,
      `Automatic safety checkpoint before writing uploaded files: ${uploadedFiles.map((f) => f.relPath).join(", ")}`,
      { workspaceId: projectId }
    );

    // 5. Write files safely using atomic writes
    const writtenFiles: string[] = [];
    const ragIndexedFiles: string[] = [];
    const ragErrors: { file: string; error: string }[] = [];

    for (const item of validatedFiles) {
      const parentDir = path.dirname(item.canonicalPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      atomicWriteFileSync(item.canonicalPath, item.buffer);
      writtenFiles.push(item.relPath);

      // Ingest into RAG if user selected ingestion (supports Python, code, Markdown, text, and PDF)
      if (ingestToRAG) {
        try {
          await ingestDocument(projectId, item.relPath, item.buffer, storeRoot);
          ragIndexedFiles.push(item.relPath);
        } catch (ragErr) {
          const errMsg = ragErr instanceof Error ? ragErr.message : "RAG ingestion failed";
          console.warn(`[RAG Ingestion Warning for ${item.relPath}]:`, errMsg);
          ragErrors.push({ file: item.relPath, error: errMsg });
        }
      }
    }

    // 6. Record audit action
    appendAuditAction(storeRoot, {
      id: `act_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      projectId,
      timestamp: new Date().toISOString(),
      actionType: "file_upload",
      targetPath: writtenFiles.join(", "),
      summary: `Uploaded ${writtenFiles.length} file(s) to project '${projectId}'`,
      status: "success",
      snapshotIdBefore: safetySnapshot.id,
      details: {
        files: writtenFiles,
        totalBytes: filesForValidation.reduce((sum, f) => sum + f.size, 0),
        ragIndexedFiles,
        ragErrors: ragErrors.length > 0 ? ragErrors : undefined,
      },
    });

    const updatedFiles = listPermittedWorkspaceFiles(workspaceRoot);

    const ragWarning = ragErrors.length > 0
      ? ` (Note: RAG indexing failed for: ${ragErrors.map((e) => e.file).join(", ")})`
      : "";

    return NextResponse.json({
      success: true,
      message: `Successfully uploaded ${writtenFiles.length} file(s).${ragWarning}`,
      uploadedFiles: writtenFiles,
      ragIndexedFiles,
      ragErrors: ragErrors.length > 0 ? ragErrors : undefined,
      dynamicLimits,
      safetySnapshotId: safetySnapshot.id,
      workspaceFiles: updatedFiles,
    });
  } catch (error: unknown) {
    if (error instanceof SecurityError || error instanceof FileTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Internal error during file upload";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

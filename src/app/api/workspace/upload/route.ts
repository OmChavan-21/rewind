import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getContextRoots } from "@/server/workspaceContext";
import {
  resolveAndValidatePath,
  isPermittedFile,
  sanitizeRelativePath,
  validateProjectId,
  SecurityError,
  FileTooLargeError,
  ALLOWED_EXTENSIONS_LIST,
} from "@/security/boundaries";
import {
  validateUploadLimits,
  getDirectorySizeBytes,
  computeDynamicLimits,
  getResourceLimits,
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
    const maxTotalAllowed = getResourceLimits().maxTotalUploadSizeBytes;

    // Pre-flight check: Reject requests with Content-Length exceeding maximum total limit before processing
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > maxTotalAllowed) {
        return NextResponse.json(
          {
            error: `Upload request size (${contentLength} bytes) exceeds maximum total upload limit of ${maxTotalAllowed} bytes.`,
          },
          { status: 413 }
        );
      }
    }

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

      let cumulativeBytes = 0;
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
          cumulativeBytes += buffer.length;

          if (cumulativeBytes > maxTotalAllowed) {
            return NextResponse.json(
              {
                error: `Total upload size exceeded maximum limit of ${maxTotalAllowed} bytes during upload processing.`,
              },
              { status: 413 }
            );
          }

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
        let cumulativeBytes = 0;
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
            cumulativeBytes += buffer.length;

            if (cumulativeBytes > maxTotalAllowed) {
              return NextResponse.json(
                {
                  error: `Total upload size exceeded maximum limit of ${maxTotalAllowed} bytes.`,
                },
                { status: 413 }
              );
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

    // Validate project ID format and existence
    if (targetProjectId) {
      validateProjectId(targetProjectId);
      const defaultStore = getDefaultStoreRoot();
      const registry = loadProjectsRegistry(defaultStore);
      if (!registry.projects[targetProjectId] && targetProjectId !== "demo-workspace") {
        return NextResponse.json(
          { error: `Project '${targetProjectId}' does not exist.` },
          { status: 404 }
        );
      }
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
      // Validate extension, forbidden prefixes, and Windows reserved names
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

    // If conflicts exist and overwrite is false, refuse write before any modification
    if (conflictingFiles.length > 0) {
      return NextResponse.json(
        {
          error: `File(s) already exist: ${conflictingFiles.join(", ")}. Set overwrite=true to replace existing files.`,
          conflictingFiles,
        },
        { status: 409 }
      );
    }

    // 3. AUTOMATIC SAFETY SNAPSHOT: Capture pre-upload state before writing files
    const safetySnapshot = createSnapshot(
      workspaceRoot,
      storeRoot,
      `Pre-upload: ${validatedFiles.map((f) => path.basename(f.relPath)).join(", ")}`.slice(0, 50),
      `Automated safety snapshot captured prior to uploading ${validatedFiles.length} file(s).`,
      {
        action: "file_upload",
        fileCount: validatedFiles.length,
        files: validatedFiles.map((f) => f.relPath),
        projectId,
      }
    );

    // 4. Safe atomic writes to designated project workspace
    const writtenFiles: string[] = [];
    for (const vf of validatedFiles) {
      const parentDir = path.dirname(vf.canonicalPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      atomicWriteFileSync(vf.canonicalPath, vf.buffer);
      writtenFiles.push(vf.relPath);
    }

    // 5. Ingest into RAG if requested
    const ragIndexedFiles: string[] = [];
    const ragErrors: { file: string; error: string }[] = [];

    if (ingestToRAG) {
      for (const vf of validatedFiles) {
        try {
          await ingestDocument(projectId, vf.relPath, vf.buffer, storeRoot);
          ragIndexedFiles.push(vf.relPath);
        } catch (ragErr: unknown) {
          const errMsg = ragErr instanceof Error ? ragErr.message : String(ragErr);
          ragErrors.push({ file: vf.relPath, error: errMsg });
          console.warn(`[RAG Ingestion Warning for ${vf.relPath}]:`, errMsg);
        }
      }
    }

    // 6. Record audit action
    appendAuditAction(storeRoot, {
      id: `act_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      timestamp: new Date().toISOString(),
      actionType: "file_upload",
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

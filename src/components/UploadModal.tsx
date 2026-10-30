"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  UploadCloud,
  X,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  FileCode,
  FileCheck,
  Info,
} from "lucide-react";
import {
  ALLOWED_EXTENSIONS_LIST,
  isAllowedFileExtension,
} from "../security/allowedExtensions";
import type { EffectiveResourceLimits } from "../types/limits";

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeProjectId: string;
  onUploadSuccess: () => void;
}

export function UploadModal({
  isOpen,
  onClose,
  activeProjectId,
  onUploadSuccess,
}: UploadModalProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dynamicLimits, setDynamicLimits] = useState<EffectiveResourceLimits | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [ingestToRAG, setIngestToRAG] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    fetch(`/api/system/limits?projectId=${encodeURIComponent(activeProjectId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.dynamicLimits) {
          setDynamicLimits(data.dynamicLimits);
        }
      })
      .catch(() => {});
  }, [isOpen, activeProjectId]);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, isFolder = false) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      const invalidFiles = selected.filter((f) => !isAllowedFileExtension(f.name));
      const files = isFolder ? selected.filter((f) => isAllowedFileExtension(f.name)) : selected;
      if (invalidFiles.length > 0) {
        if (!isFolder) {
          const ext = invalidFiles[0].name.includes(".")
            ? "." + invalidFiles[0].name.split(".").pop()
            : "unknown";
          setError(
            `[Security Violation] Disallowed file type '${ext}'. Permitted extensions: ${ALLOWED_EXTENSIONS_LIST.join(", ")}`
          );
          setSelectedFiles([]);
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      if (files.length === 0) {
        setError("No supported files found in that folder.");
        setSelectedFiles([]);
        return;
      }

      if (dynamicLimits) {
        const { effective } = dynamicLimits;
        if (effective.remainingStorageBytes <= 0) {
          setError("Project storage quota exhausted. No additional files can be uploaded.");
          setSelectedFiles([]);
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }

        let totalSize = 0;
        for (const file of files) {
          const isDoc = file.name.toLowerCase().endsWith(".pdf");
          const limit = isDoc ? effective.maxDocumentSizeBytes : effective.maxFileSizeBytes;
          if (file.size > limit) {
            const limitMb = (limit / (1024 * 1024)).toFixed(1);
            const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
            setError(`File '${file.name}' (${sizeMb} MB) exceeds dynamic limit of ${limitMb} MB.`);
            setSelectedFiles([]);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
          }
          totalSize += file.size;
        }

        if (totalSize > effective.remainingStorageBytes) {
          const remainingMb = (effective.remainingStorageBytes / (1024 * 1024)).toFixed(1);
          const totalMb = (totalSize / (1024 * 1024)).toFixed(2);
          setError(`Selected files total ${totalMb} MB, exceeding the ${remainingMb} MB remaining project storage.`);
          setSelectedFiles([]);
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      setSelectedFiles(files);
      setError(null);
      setSelectionNotice(invalidFiles.length > 0
        ? `Skipped ${invalidFiles.length} unsupported file(s); only permitted source and document types will be uploaded.`
        : null);
      setConflictFiles(null);
      setUploadSuccess(null);
    }
  };

  const executeUpload = async (forceOverwrite: boolean = false) => {
    if (selectedFiles.length === 0) {
      setError("Please select at least one file to upload.");
      return;
    }

    for (const file of selectedFiles) {
      if (!isAllowedFileExtension(file.name)) {
        const ext = file.name.includes(".")
          ? "." + file.name.split(".").pop()
          : "unknown";
        setError(
          `[Security Violation] Disallowed file type '${ext}'. Permitted extensions: ${ALLOWED_EXTENSIONS_LIST.join(", ")}`
        );
        return;
      }
    }

    setIsUploading(true);
    setError(null);
    setUploadSuccess(null);

    try {
      const limits = dynamicLimits?.effective;
      const maxFilesPerBatch = limits?.maxFilesPerUpload || maxFiles;
      const maxBytesPerBatch = limits?.maxTotalUploadSizeBytes || 25 * 1024 * 1024;
      const batches: File[][] = [];
      let batch: File[] = [];
      let batchBytes = 0;
      for (const file of selectedFiles) {
        if (batch.length >= maxFilesPerBatch || batchBytes + file.size > maxBytesPerBatch) {
          if (batch.length > 0) batches.push(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(file);
        batchBytes += file.size;
      }
      if (batch.length > 0) batches.push(batch);

      let uploadedCount = 0;
      for (const [batchIndex, files] of batches.entries()) {
        setUploadProgress(`Uploading batch ${batchIndex + 1} of ${batches.length} (${uploadedCount} of ${selectedFiles.length} files complete)`);
        const formData = new FormData();
        formData.append("projectId", activeProjectId);
        formData.append("overwrite", forceOverwrite ? "true" : "false");
        formData.append("ingestToRAG", ingestToRAG ? "true" : "false");
        for (const file of files) {
          formData.append("files", file, file.name);
          formData.append("paths", file.webkitRelativePath || file.name);
        }

        const res = await fetch("/api/workspace/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (res.status === 409 && data.conflict) {
          setConflictFiles(data.conflictingFiles || []);
          setError(uploadedCount > 0
            ? `Uploaded ${uploadedCount} file(s); some files already exist in the remaining batches. Confirm overwrite to finish.`
            : "Some files already exist. Confirm overwrite below.");
          return;
        }
        if (!res.ok) {
          throw new Error(data.error || `Upload stopped after ${uploadedCount} file(s).`);
        }
        uploadedCount += data.uploadedFiles?.length || files.length;
      }

      setUploadSuccess(
        `Successfully uploaded ${uploadedCount} file(s) in ${batches.length} batch(es). Pre-change safety snapshots captured.`
      );
      setUploadProgress(null);
      setSelectedFiles([]);
      setConflictFiles(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
      onUploadSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error uploading files");
    } finally {
      setUploadProgress(null);
      setIsUploading(false);
    }
  };

  const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);

  const effective = dynamicLimits?.effective;
  const reasons = dynamicLimits?.reasonsForReduction || [];
  const maxFiles = effective ? effective.maxFilesPerUpload : 10;
  const batchLimitMb = effective ? (effective.maxTotalUploadSizeBytes / (1024 * 1024)).toFixed(0) : "25";
  const isStorageExhausted = Boolean(effective && effective.remainingStorageBytes <= 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Upload Files</h2>
              <p className="text-xs text-slate-400 font-mono">
                Target: {activeProjectId}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Dynamic Resource Notice */}
        {reasons.length > 0 && (
          <div className="mt-3 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-[11px] text-amber-200">
            <Info className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-300">Dynamic resource limits active: </span>
              {reasons.join(" ")}
            </div>
          </div>
        )}

        {/* Storage Exhaustion Alert */}
        {isStorageExhausted && (
          <div className="mt-3 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-2 text-xs text-rose-300 font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>Project storage quota exhausted. Uploads are disabled until space is freed.</span>
          </div>
        )}

        {/* Dropzone / File Picker */}
        <div className="mt-4">
          <div
            className={`border-2 border-dashed ${
              isStorageExhausted
                ? "border-rose-800/50 bg-rose-950/10 cursor-not-allowed opacity-60"
                : "border-slate-700 hover:border-cyan-500/60 cursor-pointer bg-slate-950/40 hover:bg-slate-950/60"
            } rounded-xl p-6 text-center transition group`}
          >
            <UploadCloud className="w-8 h-8 mx-auto text-slate-500 group-hover:text-cyan-400 transition mb-2" />
            <p className="text-sm font-medium text-slate-200">
              {isStorageExhausted ? "Uploads Disabled (Quota Full)" : "Select files or upload a whole folder"}
            </p>
            <p className="text-xs text-slate-400 mt-1 font-mono">
              Supported: {ALLOWED_EXTENSIONS_LIST.join(", ")}
            </p>
            <p className="text-[11px] text-cyan-400/90 mt-1 font-mono">
              Per batch: {maxFiles} files / {batchLimitMb}MB · larger folders upload in safe batches
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <button type="button" disabled={isStorageExhausted} onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-cyan-700 bg-cyan-950/50 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-900/60 disabled:opacity-50">Choose files</button>
              <button type="button" disabled={isStorageExhausted} onClick={() => folderInputRef.current?.click()} className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50">Choose folder</button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={isStorageExhausted}
              accept={ALLOWED_EXTENSIONS_LIST.join(",")}
              onChange={handleFileChange}
              className="hidden"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              disabled={isStorageExhausted}
              accept={ALLOWED_EXTENSIONS_LIST.join(",")}
              onChange={(e) => handleFileChange(e, true)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              className="hidden"
            />
          </div>
        </div>

        {/* Selected files preview */}
        {selectedFiles.length > 0 && (
          <div className="mt-4 max-h-40 overflow-y-auto space-y-1.5 pr-1">
            <div className="flex items-center justify-between text-xs text-slate-400 pb-1 border-b border-slate-800 font-mono">
              <span>{selectedFiles.length} file(s) selected</span>
              <span>Total: {totalMb} MB</span>
            </div>
            {selectedFiles.slice(0, 20).map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-2 rounded-lg bg-slate-950/60 border border-slate-800 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {f.name.endsWith(".pdf") ? (
                    <FileText className="w-4 h-4 text-purple-400 shrink-0" />
                  ) : f.name.endsWith(".py") ? (
                    <FileCode className="w-4 h-4 text-yellow-400 shrink-0" />
                  ) : (
                    <FileCode className="w-4 h-4 text-cyan-400 shrink-0" />
                  )}
                  <span className="truncate text-slate-200 font-mono">{f.webkitRelativePath || f.name}</span>
                </div>
                <span className="text-slate-400 font-mono shrink-0 ml-2">
                  {(f.size / 1024).toFixed(1)} KB
                </span>
              </div>
            ))}
            {selectedFiles.length > 20 && (
              <p className="px-2 py-1 text-[11px] text-slate-400">and {selectedFiles.length - 20} more file(s), uploaded in batches</p>
            )}
          </div>
        )}

        {/* Ingest to RAG checkbox */}
        <div className="mt-4 flex items-center gap-2.5 p-3 rounded-xl bg-slate-950/40 border border-slate-800/80">
          <input
            type="checkbox"
            id="ingestRAG"
            checked={ingestToRAG}
            onChange={(e) => setIngestToRAG(e.target.checked)}
            className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500/20"
          />
          <label htmlFor="ingestRAG" className="text-xs text-slate-300 cursor-pointer">
            <span className="font-medium text-slate-200">Ingest into RAG Knowledge Base</span>
            <span className="block text-[11px] text-slate-400">
              Optional. Creates embeddings for document Q&A; leave off for faster source-code uploads.
            </span>
          </label>
        </div>

        {uploadProgress && (
          <div className="mt-4 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-xs text-cyan-200">{uploadProgress}</div>
        )}

        {/* Error / Conflict Alert */}
        {selectionNotice && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">{selectionNotice}</div>
        )}
        {error && (
          <div className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2.5 text-xs text-rose-300">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">{error}</p>
              {conflictFiles && conflictFiles.length > 0 && (
                <ul className="mt-1.5 list-disc list-inside font-mono text-[11px] text-rose-200">
                  {conflictFiles.map((cf, idx) => (
                    <li key={idx}>{cf}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Success Alert */}
        {uploadSuccess && (
          <div className="mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-2.5 text-xs text-emerald-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{uploadSuccess}</p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-5 flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
          <button
            onClick={onClose}
            disabled={isUploading}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            Close
          </button>

          {conflictFiles && conflictFiles.length > 0 ? (
            <button
              onClick={() => executeUpload(true)}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 font-semibold text-xs transition shadow-lg shadow-rose-500/20"
            >
              {isUploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5" />
              )}
              Confirm Overwrite & Upload
            </button>
          ) : (
            <button
              onClick={() => executeUpload(false)}
              disabled={isUploading || selectedFiles.length === 0 || isStorageExhausted}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 font-semibold text-xs transition shadow-lg shadow-cyan-500/20 disabled:opacity-50"
            >
              {isUploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FileCheck className="w-3.5 h-3.5" />
              )}
              Upload {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ""}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

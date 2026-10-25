"use client";

import React, { useState, useEffect } from "react";
import {
  FileCode,
  FileText,
  FileJson,
  Hash,
  Eye,
  Check,
  Copy,
  UploadCloud,
  FolderPlus,
} from "lucide-react";
import type { PermittedFile } from "@/types/recovery";

interface FileExplorerProps {
  files: PermittedFile[];
  onSelectFile?: (filePath: string) => void;
  selectedFilePath?: string;
  projectId?: string;
  onOpenUpload?: () => void;
}

export function FileExplorer({
  files,
  onSelectFile,
  selectedFilePath,
  projectId,
  onOpenUpload,
}: FileExplorerProps) {
  const [userSelectedFile, setUserSelectedFile] = useState<string>("");
  const activeFile = selectedFilePath || userSelectedFile || files[0]?.path || "";

  const [fileContent, setFileContent] = useState<string>("");
  const [isLoadingContent, setIsLoadingContent] = useState<boolean>(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;

    if (!activeFile) {
      Promise.resolve().then(() => {
        if (isMounted) {
          setFileContent("");
          setIsLoadingContent(false);
        }
      });
      return () => {
        isMounted = false;
      };
    }

    Promise.resolve().then(() => {
      if (isMounted) setIsLoadingContent(true);
    });

    const url = `/api/workspace/file?path=${encodeURIComponent(activeFile)}${
      projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""
    }`;

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.content !== undefined) {
          setFileContent(data.content);
        } else {
          setFileContent(`// Error reading file: ${data.error || "Unknown"}`);
        }
      })
      .catch((err: unknown) => {
        if (!isMounted) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        setFileContent(`// Network error loading file: ${errMsg}`);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingContent(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [activeFile, projectId]);

  const handleCopy = () => {
    navigator.clipboard.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getFileIcon = (ext: string) => {
    if (ext === ".json") return <FileJson className="w-3.5 h-3.5 text-amber-400" />;
    if (ext === ".ts" || ext === ".tsx") return <FileCode className="w-3.5 h-3.5 text-cyan-400" />;
    if (ext === ".py") return <FileCode className="w-3.5 h-3.5 text-yellow-400" />;
    if (ext === ".pdf") return <FileText className="w-3.5 h-3.5 text-purple-400" />;
    if (ext === ".md" || ext === ".txt") return <FileText className="w-3.5 h-3.5 text-slate-300" />;
    return <FileCode className="w-3.5 h-3.5 text-emerald-400" />;
  };

  const lines = fileContent.split("\n");

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-lg min-h-[460px]">
      {/* File Tree Left Column */}
      <div className="md:col-span-4 border-r border-slate-800/80 bg-slate-950/60 p-3 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400 font-mono">
            <span>Workspace Files</span>
            <span className="text-[10px] text-cyan-400 font-normal font-mono">
              {files.length} permitted
            </span>
          </div>

          {/* Action Header with Upload Button */}
          {onOpenUpload && (
            <div className="mb-2.5">
              <button
                onClick={onOpenUpload}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-xs font-semibold transition"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                Upload Files
              </button>
            </div>
          )}

          {files.length === 0 ? (
            <div className="p-6 text-center rounded-lg bg-slate-900/40 border border-slate-800/80 my-4">
              <FolderPlus className="w-7 h-7 mx-auto text-slate-500 mb-2" />
              <p className="text-xs text-slate-300 font-medium">No files in project</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Upload your source code or knowledge base documents to begin.
              </p>
              {onOpenUpload && (
                <button
                  onClick={onOpenUpload}
                  className="mt-3 px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 text-xs font-bold transition hover:bg-cyan-400"
                >
                  Add First File
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {files.map((file) => {
                const isSelected = activeFile === file.path;
                return (
                  <button
                    key={file.path}
                    onClick={() => {
                      setUserSelectedFile(file.path);
                      onSelectFile?.(file.path);
                    }}
                    className={`w-full flex items-center justify-between p-2 rounded-lg text-left text-xs font-mono transition ${
                      isSelected
                        ? "bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 font-semibold"
                        : "text-slate-300 hover:bg-slate-800/60 hover:text-white border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      {getFileIcon(file.extension)}
                      <span className="truncate">{file.path}</span>
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0 ml-2">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected file hash metadata */}
        {files.find((f) => f.path === activeFile) && (
          <div className="mt-4 p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400 space-y-1">
            <div className="flex items-center gap-1 text-slate-300 font-semibold">
              <Hash className="w-3 h-3 text-cyan-400" />
              <span>SHA-256 Digest</span>
            </div>
            <p className="truncate text-slate-400" title={files.find((f) => f.path === activeFile)?.hash}>
              {files.find((f) => f.path === activeFile)?.hash}
            </p>
          </div>
        )}
      </div>

      {/* Code Viewer Right Column */}
      <div className="md:col-span-8 flex flex-col bg-slate-950">
        {/* Code Header */}
        <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between select-none">
          <div className="flex items-center gap-2 text-xs font-mono text-slate-200">
            <Eye className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-semibold">{activeFile || "No file selected"}</span>
            {activeFile && (
              <span className="text-[10px] text-slate-400">({lines.length} lines)</span>
            )}
          </div>

          {activeFile && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Code Content */}
        <div className="p-3 font-mono text-xs overflow-auto flex-1 max-h-[420px] bg-slate-950/90">
          {isLoadingContent ? (
            <div className="p-8 text-center text-slate-400 font-mono text-xs">
              Loading verified content...
            </div>
          ) : !activeFile ? (
            <div className="p-8 text-center text-slate-400 font-mono text-xs">
              Select or upload a file to view content.
            </div>
          ) : (
            <div className="table w-full">
              {lines.map((line, idx) => (
                <div key={idx} className="table-row hover:bg-slate-900/60 transition-colors">
                  <span className="table-cell select-none pr-4 text-right text-[11px] text-slate-400 w-10">
                    {idx + 1}
                  </span>
                  <span className="table-cell whitespace-pre font-mono text-slate-200">
                    {line || " "}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

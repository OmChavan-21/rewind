"use client";

import React from "react";
import {
  Camera,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Shield,
  UploadCloud,
  FolderGit2,
} from "lucide-react";
import type { WorkspaceStatus, ValidationResult } from "@/types/recovery";

interface TopBarProps {
  status: WorkspaceStatus;
  validation?: ValidationResult;
  activeProjectId?: string;
  onOpenSnapshotModal: () => void;
  onRunValidation: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  onOpenUpload?: () => void;
  onOpenProjectManager?: () => void;
}

export function TopBar({
  status,
  validation,
  activeProjectId = "demo-workspace",
  onOpenSnapshotModal,
  onRunValidation,
  onRefresh,
  isLoading,
  onOpenUpload,
  onOpenProjectManager,
}: TopBarProps) {
  const isHealthy = status === "healthy" && (validation?.passed ?? true);

  return (
    <header className="h-16 px-6 bg-slate-950/70 backdrop-blur-md border-b border-slate-800/80 flex items-center justify-between sticky top-0 z-30 select-none">
      {/* Left: Breadcrumbs & status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="text-slate-400">rewind</span>
          <span className="text-slate-500">/</span>
          <button
            onClick={onOpenProjectManager}
            title="Click to switch projects"
            className="flex items-center gap-1.5 text-slate-200 font-semibold bg-slate-900 hover:bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-800 hover:border-slate-700 transition"
          >
            <FolderGit2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>{activeProjectId}</span>
          </button>
        </div>

        {/* Live Status Indicator */}
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            isHealthy
              ? "bg-emerald-950/60 text-emerald-300 border-emerald-800/80"
              : "bg-rose-950/60 text-rose-300 border-rose-800/80"
          }`}
        >
          {isHealthy ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Healthy & Verified</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 animate-bounce" />
              <span>Degraded (Invariants Failing)</span>
            </>
          )}
        </div>
      </div>

      {/* Right: Quick actions */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh workspace state"
          className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition active:scale-95 disabled:opacity-50"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
        </button>

        {onOpenUpload && (
          <button
            onClick={onOpenUpload}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-xs font-semibold transition"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            <span>Upload</span>
          </button>
        )}

        <button
          onClick={onRunValidation}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-semibold border border-slate-800 hover:border-slate-700 transition active:scale-95 disabled:opacity-50"
        >
          <Shield className="w-3.5 h-3.5 text-cyan-400" />
          <span>Validate Project</span>
        </button>

        <button
          onClick={onOpenSnapshotModal}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 text-xs font-semibold shadow-md shadow-cyan-500/20 transition active:scale-[0.98] disabled:opacity-50"
        >
          <Camera className="w-3.5 h-3.5" />
          <span>New Snapshot</span>
        </button>
      </div>
    </header>
  );
}

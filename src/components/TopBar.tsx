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
  User,
  LogOut,
  LogIn,
} from "lucide-react";
import type { WorkspaceStatus, ValidationResult } from "@/types/recovery";
import type { AuthUser } from "@/types/auth";

interface TopBarProps {
  status: WorkspaceStatus;
  validation?: ValidationResult;
  activeProjectId?: string;
  currentUser?: AuthUser | null;
  onOpenSnapshotModal: () => void;
  onRunValidation: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  onOpenUpload?: () => void;
  onOpenProjectManager?: () => void;
  onOpenAuthModal?: () => void;
  onLogout?: () => void;
}

export function TopBar({
  status,
  validation,
  activeProjectId = "demo-workspace",
  currentUser,
  onOpenSnapshotModal,
  onRunValidation,
  onRefresh,
  isLoading,
  onOpenUpload,
  onOpenProjectManager,
  onOpenAuthModal,
  onLogout,
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

      {/* Right: Quick actions & Auth */}
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

        {/* User / Auth section */}
        <div className="h-5 w-[1px] bg-slate-800 mx-1" />

        {currentUser ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300">
              <User className="w-3.5 h-3.5 text-cyan-400" />
              <span className="max-w-[120px] truncate">{currentUser.displayName || currentUser.email}</span>
              <span className="text-[10px] uppercase font-mono px-1 py-0.2 bg-cyan-950 text-cyan-300 rounded border border-cyan-800/60">
                {currentUser.role}
              </span>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                title="Sign out"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-rose-400 hover:border-rose-900/60 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ) : (
          onOpenAuthModal && (
            <button
              onClick={onOpenAuthModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-semibold border border-slate-700 hover:border-cyan-500/50 transition"
            >
              <LogIn className="w-3.5 h-3.5 text-cyan-400" />
              <span>Sign In</span>
            </button>
          )
        )}
      </div>
    </header>
  );
}

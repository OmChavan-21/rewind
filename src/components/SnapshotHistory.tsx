"use client";

import React, { useState } from "react";
import {
  Camera,
  Undo2,
  Calendar,
  Files,
  HardDrive,
  GitCompare,
  FolderGit2,
  Info,
  ShieldCheck,
} from "lucide-react";
import type { Snapshot } from "@/types/recovery";

interface SnapshotHistoryProps {
  snapshots: Snapshot[];
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
  onCompareSnapshot: (snapshotId: string) => void;
  isLoading: boolean;
  activeProjectId?: string;
}

export function SnapshotHistory({
  snapshots,
  onRestoreSnapshot,
  onCompareSnapshot,
  isLoading,
  activeProjectId,
}: SnapshotHistoryProps) {
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-lg space-y-0">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
            Snapshot Vault & Recovery Checkpoints
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 font-mono">
            {snapshots.length} stored
          </span>
        </div>

        {activeProjectId && (
          <span className="text-xs text-slate-400 font-mono">
            Project: <code className="text-cyan-400">{activeProjectId}</code>
          </span>
        )}
      </div>

      {/* Storage Information Bar */}
      <div className="px-4 py-2 bg-slate-950/40 border-b border-slate-800/60 flex items-center justify-between text-[11px] text-slate-400 font-mono">
        <div className="flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span>Storage Path: <code className="text-slate-300">.rewind_store/snapshots/&lt;id&gt;/</code></span>
        </div>
        <span className="text-emerald-400/90 font-medium">Persists Across Server Restarts</span>
      </div>

      {/* Snapshot Cards */}
      <div className="p-4 space-y-3">
        {snapshots.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 font-mono">
            No snapshots captured for this project yet. Click &quot;New Snapshot&quot; to create a recovery baseline.
          </div>
        ) : (
          snapshots.map((snap) => {
            const isConfirming = confirmRestoreId === snap.id;
            return (
              <div
                key={snap.id}
                className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition flex flex-col md:flex-row md:items-center justify-between gap-4 font-mono"
              >
                {/* Left: Info */}
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-sm font-bold text-slate-100 font-mono">
                      {snap.name}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 truncate max-w-[180px]">
                      {snap.id}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 flex items-center gap-1">
                      <FolderGit2 className="w-2.5 h-2.5" />
                      {snap.workspaceId || "demo-workspace"}
                    </span>
                  </div>

                  {snap.description && (
                    <p className="text-xs text-slate-400 font-sans">
                      {snap.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-cyan-400" />
                      {new Date(snap.createdAt).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <Files className="w-3 h-3 text-teal-400" />
                      {snap.totalFiles} files
                    </span>
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-3 h-3 text-purple-400" />
                      {(snap.totalBytes / 1024).toFixed(1)} KB
                    </span>
                  </div>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onCompareSnapshot(snap.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold border border-slate-800 hover:border-slate-700 transition"
                  >
                    <GitCompare className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Compare Diff</span>
                  </button>

                  {isConfirming ? (
                    <div className="flex items-center gap-1.5 bg-amber-950/60 p-1.5 rounded-xl border border-amber-800">
                      <button
                        onClick={async () => {
                          setConfirmRestoreId(null);
                          await onRestoreSnapshot(snap.id);
                        }}
                        disabled={isLoading}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition disabled:opacity-50"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Confirm Rollback
                      </button>
                      <button
                        onClick={() => setConfirmRestoreId(null)}
                        className="px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 text-xs font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmRestoreId(snap.id)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-950/60 hover:bg-amber-900 text-amber-300 text-xs font-semibold border border-amber-800/80 transition disabled:opacity-50"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                      <span>Restore Snapshot</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

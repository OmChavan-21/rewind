"use client";

import React, { useState, useEffect } from "react";
import {
  GitCompare,
  FilePlus,
  FileMinus,
  FileEdit,
  CheckCircle2,
} from "lucide-react";
import type { Snapshot, FileChange } from "@/types/recovery";

interface DiffViewerProps {
  snapshots: Snapshot[];
  selectedSnapshotId?: string;
  onSelectSnapshot?: (id: string) => void;
}

export function DiffViewer({
  snapshots,
  selectedSnapshotId,
  onSelectSnapshot,
}: DiffViewerProps) {
  const [userSelectedId, setUserSelectedId] = useState<string>("");
  const activeSnapshotId = selectedSnapshotId || userSelectedId || snapshots[0]?.id || "";

  const [changes, setChanges] = useState<FileChange[]>([]);
  const [activeChangePath, setActiveChangePath] = useState<string>("");
  const [isLoadingDiff, setIsLoadingDiff] = useState<boolean>(false);

  useEffect(() => {
    if (!activeSnapshotId) return;

    let isMounted = true;

    async function fetchDiff() {
      try {
        setIsLoadingDiff(true);
        const res = await fetch(`/api/snapshots/${activeSnapshotId}`);
        const data = await res.json();
        if (isMounted && data.changes) {
          setChanges(data.changes);
          const firstModified = data.changes.find((c: FileChange) => c.type !== "unchanged");
          setActiveChangePath(firstModified?.path || data.changes[0]?.path || "");
        }
      } catch {
        // Ignore diff fetch error
      } finally {
        if (isMounted) setIsLoadingDiff(false);
      }
    }

    fetchDiff();

    return () => {
      isMounted = false;
    };
  }, [activeSnapshotId]);

  const activeChange = changes.find((c) => c.path === activeChangePath);
  const modifiedCount = changes.filter((c) => c.type !== "unchanged").length;

  const renderBadge = (type: FileChange["type"]) => {
    switch (type) {
      case "added":
        return (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800 font-mono">
            <FilePlus className="w-3 h-3" /> ADDED
          </span>
        );
      case "modified":
        return (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-400 border border-amber-800 font-mono">
            <FileEdit className="w-3 h-3" /> MODIFIED
          </span>
        );
      case "deleted":
        return (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-950/80 text-rose-400 border border-rose-800 font-mono">
            <FileMinus className="w-3 h-3" /> DELETED
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800 font-mono">
            <CheckCircle2 className="w-3 h-3" /> UNCHANGED
          </span>
        );
    }
  };

  const diffLines = activeChange?.diff ? activeChange.diff.split("\n") : [];

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-lg">
      {/* Diff Controls Header */}
      <div className="px-4 py-3 bg-slate-950/80 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
            Snapshot Diff Comparator
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 font-mono">
            {modifiedCount} file{modifiedCount !== 1 ? "s" : ""} divergent
          </span>
        </div>

        {/* Snapshot Selector */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-slate-400 font-mono">Compare against:</label>
          <select
            value={activeSnapshotId}
            onChange={(e) => {
              setUserSelectedId(e.target.value);
              onSelectSnapshot?.(e.target.value);
            }}
            className="text-xs bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-2.5 py-1 font-mono focus:outline-none focus:border-cyan-500"
          >
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.id.slice(0, 14)}...)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Diff Content Grid */}
      <div className="grid grid-cols-1 md:grid-cols-12 min-h-[380px]">
        {/* Changed Files List */}
        <div className="md:col-span-4 border-r border-slate-800 bg-slate-950/40 p-3 space-y-1">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-2">
            Target Files Comparison
          </div>

          {isLoadingDiff ? (
            <div className="p-4 text-center text-xs text-slate-400 font-mono">
              Computing diff...
            </div>
          ) : changes.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400 font-mono">
              No files tracked in this snapshot.
            </div>
          ) : (
            changes.map((change) => {
              const isSelected = activeChangePath === change.path;
              return (
                <button
                  key={change.path}
                  onClick={() => setActiveChangePath(change.path)}
                  className={`w-full flex items-center justify-between p-2 rounded-lg text-left text-xs font-mono transition ${
                    isSelected
                      ? "bg-slate-800 text-white border border-slate-700"
                      : "text-slate-300 hover:bg-slate-900/80 border border-transparent"
                  }`}
                >
                  <span className="truncate pr-2">{change.path}</span>
                  {renderBadge(change.type)}
                </button>
              );
            })
          )}
        </div>

        {/* Diff View Area */}
        <div className="md:col-span-8 bg-slate-950 flex flex-col">
          {activeChange ? (
            <>
              <div className="px-4 py-2 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs font-mono font-medium text-slate-200">
                  {activeChange.path}
                </span>
                {renderBadge(activeChange.type)}
              </div>

              <div className="p-3 font-mono text-xs overflow-auto max-h-[360px] bg-slate-950/90 flex-1">
                {activeChange.type === "unchanged" ? (
                  <div className="p-8 text-center text-slate-400 font-mono text-xs">
                    File is identical to this snapshot. No changes detected.
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {diffLines.map((line, idx) => {
                      let lineClass = "text-slate-400";
                      let bgClass = "";

                      if (line.startsWith("+") && !line.startsWith("+++")) {
                        lineClass = "text-emerald-300";
                        bgClass = "bg-emerald-950/30";
                      } else if (line.startsWith("-") && !line.startsWith("---")) {
                        lineClass = "text-rose-300";
                        bgClass = "bg-rose-950/30";
                      } else if (line.startsWith("@@")) {
                        lineClass = "text-cyan-400 font-semibold";
                        bgClass = "bg-cyan-950/20";
                      }

                      return (
                        <div
                          key={idx}
                          className={`px-2 py-0.5 rounded font-mono whitespace-pre text-[11px] ${lineClass} ${bgClass}`}
                        >
                          {line}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-slate-400 font-mono text-xs">
              Select a file to inspect diff.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import React, { useState } from "react";
import {
  FileEdit,
  Bug,
  ShieldCheck,
  Undo2,
  RefreshCw,
  Sparkles,
  Info,
} from "lucide-react";

interface DemoControlBarProps {
  onModifyFile: () => Promise<void>;
  onIntroduceFailure: (target: "agent-workflow.json" | "src/evaluator.ts") => Promise<void>;
  onValidate: () => Promise<void>;
  onRestoreLatest: () => Promise<void>;
  onResetWorkspace: () => Promise<void>;
  hasSnapshots: boolean;
  isLoading: boolean;
}

export function DemoControlBar({
  onModifyFile,
  onIntroduceFailure,
  onValidate,
  onRestoreLatest,
  onResetWorkspace,
  hasSnapshots,
  isLoading,
}: DemoControlBarProps) {
  const [activeFailureTarget, setActiveFailureTarget] = useState<
    "agent-workflow.json" | "src/evaluator.ts"
  >("agent-workflow.json");

  return (
    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-xl space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              Demo Operations Bar
            </h3>
            <p className="text-[11px] text-slate-400">
              Interactive test controls for Phase 1 verification
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
          <Info className="w-3.5 h-3.5 text-cyan-400" />
          <span>Automatic safety snapshots taken before every write</span>
        </div>
      </div>

      {/* Control Buttons Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
        {/* 1. Controlled Modification */}
        <button
          onClick={onModifyFile}
          disabled={isLoading}
          className="flex flex-col items-start p-3 rounded-lg bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 text-left transition group disabled:opacity-50"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <FileEdit className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform" />
            <span className="text-xs font-semibold text-slate-200">
              1. Modify File
            </span>
          </div>
          <span className="text-[10px] text-slate-400 leading-tight">
            Updates version & tools in <code className="text-cyan-300">workflow.json</code> safely
          </span>
        </button>

        {/* 2. Introduce Failure */}
        <div className="flex flex-col p-3 rounded-lg bg-slate-950/70 border border-slate-800 hover:border-rose-500/40 text-left transition group">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Bug className="w-4 h-4 text-rose-400 group-hover:rotate-12 transition-transform" />
              <span className="text-xs font-semibold text-rose-300">
                2. Demo Failure
              </span>
            </div>
            <select
              value={activeFailureTarget}
              onChange={(e) =>
                setActiveFailureTarget(
                  e.target.value as "agent-workflow.json" | "src/evaluator.ts"
                )
              }
              className="text-[10px] bg-slate-900 border border-slate-800 text-slate-300 rounded px-1 py-0.5"
            >
              <option value="agent-workflow.json">workflow.json</option>
              <option value="src/evaluator.ts">evaluator.ts</option>
            </select>
          </div>
          <button
            onClick={() => onIntroduceFailure(activeFailureTarget)}
            disabled={isLoading}
            className="w-full mt-auto py-1 px-2 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-200 text-[10px] font-semibold border border-rose-800 transition disabled:opacity-50 text-center"
          >
            Inject Intentional Break
          </button>
        </div>

        {/* 3. Validate Workspace */}
        <button
          onClick={onValidate}
          disabled={isLoading}
          className="flex flex-col items-start p-3 rounded-lg bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/40 text-left transition group disabled:opacity-50"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform" />
            <span className="text-xs font-semibold text-slate-200">
              3. Validate Checks
            </span>
          </div>
          <span className="text-[10px] text-slate-400 leading-tight">
            Executes deterministic project validation rules
          </span>
        </button>

        {/* 4. Restore Latest Snapshot */}
        <button
          onClick={onRestoreLatest}
          disabled={isLoading || !hasSnapshots}
          className="flex flex-col items-start p-3 rounded-lg bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-amber-500/40 text-left transition group disabled:opacity-50"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <Undo2 className="w-4 h-4 text-amber-400 group-hover:-rotate-45 transition-transform" />
            <span className="text-xs font-semibold text-slate-200">
              4. Safe Rollback
            </span>
          </div>
          <span className="text-[10px] text-slate-400 leading-tight">
            Validates baseline, restores files, and re-validates
          </span>
        </button>

        {/* 5. Reset Blueprint */}
        <button
          onClick={onResetWorkspace}
          disabled={isLoading}
          className="flex flex-col items-start p-3 rounded-lg bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-left transition group disabled:opacity-50"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <RefreshCw className="w-4 h-4 text-slate-400 group-hover:rotate-180 transition-transform duration-500" />
            <span className="text-xs font-semibold text-slate-300">
              Reset Blueprint
            </span>
          </div>
          <span className="text-[10px] text-slate-400 leading-tight">
            Reinitializes pristine sample files
          </span>
        </button>
      </div>
    </div>
  );
}

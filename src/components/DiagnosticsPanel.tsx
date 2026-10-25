"use client";

import React, { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCircle2,
  RotateCw,
  FileCode,
  ShieldCheck,
  Search,
  Filter,
  ExternalLink,
} from "lucide-react";
import type { WorkspaceDiagnosticsResult } from "../types/diagnostics";

interface DiagnosticsPanelProps {
  diagnosticsResult: WorkspaceDiagnosticsResult | null;
  isLoading: boolean;
  onRerunDiagnostics: () => Promise<void>;
  onSelectFile?: (filePath: string) => void;
}

export function DiagnosticsPanel({
  diagnosticsResult,
  isLoading,
  onRerunDiagnostics,
  onSelectFile,
}: DiagnosticsPanelProps) {
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const diagnostics = diagnosticsResult?.diagnostics || [];

  const filteredDiagnostics = diagnostics.filter((diag) => {
    if (filterSeverity !== "all" && diag.severity !== filterSeverity) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        diag.filePath.toLowerCase().includes(q) ||
        diag.message.toLowerCase().includes(q) ||
        (diag.suggestion && diag.suggestion.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  const infoCount = diagnostics.filter((d) => d.severity === "info").length;

  return (
    <div className="space-y-4">
      {/* Top Banner / Summary Card */}
      <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/90 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <FileCode className="w-4 h-4 text-cyan-400" />
              Code & System Diagnostics
            </h2>
            {errorCount === 0 ? (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> All Checks Passing
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {errorCount} Error{errorCount > 1 ? "s" : ""} Detected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Static AST syntax analysis, JSON parser diagnostics, and deterministic invariant assertions.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="px-2.5 py-1 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium">
              {errorCount} Errors
            </span>
            <span className="px-2.5 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
              {warningCount} Warnings
            </span>
            <span className="px-2.5 py-1 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
              {infoCount} Info
            </span>
          </div>

          <button
            onClick={onRerunDiagnostics}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
            {isLoading ? "Analyzing..." : "Rerun Diagnostics"}
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/80">
        <div className="relative w-full sm:w-72">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by file or error message..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950/60 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto">
          <Filter className="w-3.5 h-3.5 text-slate-400 ml-1" />
          {["all", "error", "warning"].map((sev) => (
            <button
              key={sev}
              onClick={() => setFilterSeverity(sev)}
              className={`px-2.5 py-1 rounded-lg text-xs font-mono uppercase tracking-wider transition ${
                filterSeverity === sev
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
            >
              {sev}
            </button>
          ))}
        </div>
      </div>

      {/* Diagnostics List */}
      {filteredDiagnostics.length === 0 ? (
        <div className="p-12 text-center rounded-xl bg-slate-900/40 border border-slate-800">
          <ShieldCheck className="w-10 h-10 mx-auto text-emerald-400 mb-2 opacity-80" />
          <h3 className="text-sm font-semibold text-slate-200">No Diagnostics Issues Found</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            All files in the workspace have valid syntax, conform to schema constraints, and satisfy deterministic safety invariants.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredDiagnostics.map((diag) => {
            const isError = diag.severity === "error";
            const isWarning = diag.severity === "warning";

            return (
              <div
                key={diag.id}
                className={`p-3.5 rounded-xl border transition ${
                  isError
                    ? "bg-rose-950/10 border-rose-500/30 hover:border-rose-500/50"
                    : isWarning
                    ? "bg-amber-950/10 border-amber-500/30 hover:border-amber-500/50"
                    : "bg-slate-900/60 border-slate-800"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    {isError ? (
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    ) : isWarning ? (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    )}

                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-slate-200">
                          {diag.filePath}
                        </span>
                        <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-400">
                          Line {diag.line}, Col {diag.column}
                        </span>
                        <span
                          className={`px-1.5 py-0.2 rounded text-[9px] font-mono uppercase font-bold ${
                            diag.category === "syntax"
                              ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                              : diag.category === "validation"
                              ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                              : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                          }`}
                        >
                          {diag.category}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          Source: {diag.source}
                        </span>
                      </div>

                      <p className="text-xs text-slate-300 mt-1.5 font-medium leading-relaxed">
                        {diag.message}
                      </p>

                      {diag.codeSnippet && (
                        <div className="mt-2 p-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto">
                          <code>{diag.codeSnippet}</code>
                        </div>
                      )}

                      {diag.suggestion && (
                        <p className="text-[11px] text-cyan-400/90 mt-2 flex items-center gap-1 font-sans">
                          <span className="font-semibold text-slate-400">Action:</span> {diag.suggestion}
                        </p>
                      )}
                    </div>
                  </div>

                  {onSelectFile && diag.filePath && diag.filePath !== "workspace" && (
                    <button
                      onClick={() => onSelectFile(diag.filePath)}
                      title="Open file in explorer"
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

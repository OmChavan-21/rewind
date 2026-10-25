"use client";

import React from "react";
import {
  Activity,
  Camera,
  Files,
  ShieldCheck,
  AlertOctagon,
  Clock,
} from "lucide-react";
import type { Workspace, Snapshot, ValidationResult } from "@/types/recovery";

interface HealthOverviewProps {
  workspace: Workspace | null;
  snapshots: Snapshot[];
  validation: ValidationResult | null;
  actionCount: number;
}

export function HealthOverview({
  workspace,
  snapshots,
  validation,
  actionCount,
}: HealthOverviewProps) {
  const latestSnapshot = snapshots[0];
  const passedChecks = validation?.checks.filter((c) => c.status === "pass").length || 0;
  const totalChecks = validation?.checks.length || 0;
  const isHealthy = validation ? validation.passed : workspace?.status === "healthy";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Card 1: Workspace Health */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-sm relative overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
            Workspace State
          </span>
          <div
            className={`p-1.5 rounded-lg ${
              isHealthy ? "bg-emerald-950 text-emerald-400" : "bg-rose-950 text-rose-400"
            }`}
          >
            {isHealthy ? (
              <ShieldCheck className="w-4 h-4" />
            ) : (
              <AlertOctagon className="w-4 h-4 animate-pulse" />
            )}
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className={`text-xl font-bold tracking-tight font-mono ${
              isHealthy ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {isHealthy ? "HEALTHY" : "DEGRADED"}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1 font-mono">
          {totalChecks > 0 ? `${passedChecks} of ${totalChecks} checks passing` : "Checking invariants..."}
        </p>
      </div>

      {/* Card 2: Latest Snapshot */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-sm relative overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
            Latest Snapshot
          </span>
          <div className="p-1.5 rounded-lg bg-cyan-950 text-cyan-400">
            <Camera className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-2 truncate">
          <span className="text-sm font-semibold text-slate-200 truncate font-mono">
            {latestSnapshot ? latestSnapshot.name : "None yet"}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>
            {latestSnapshot
              ? new Date(latestSnapshot.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              : "Create initial snapshot"}
          </span>
        </p>
      </div>

      {/* Card 3: Monitored Files */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-sm relative overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
            Permitted Files
          </span>
          <div className="p-1.5 rounded-lg bg-teal-950 text-teal-400">
            <Files className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tracking-tight text-white font-mono">
            {workspace?.fileCount ?? 0}
          </span>
          <span className="text-xs text-slate-400">files</span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1 font-mono">
          Strictly allowlisted extensions
        </p>
      </div>

      {/* Card 4: Audited Actions */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-sm relative overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
            Audited Actions
          </span>
          <div className="p-1.5 rounded-lg bg-purple-950 text-purple-400">
            <Activity className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tracking-tight text-white font-mono">
            {actionCount}
          </span>
          <span className="text-xs text-slate-400">events</span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1 font-mono">
          App-level chronological log
        </p>
      </div>
    </div>
  );
}

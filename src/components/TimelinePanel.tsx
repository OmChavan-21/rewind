"use client";

import React, { useState } from "react";
import {
  History,
  CheckCircle2,
  XCircle,
  Camera,
  FileEdit,
  Bug,
  Undo2,
  ShieldCheck,
  Clock,
  Layers,
  Info,
} from "lucide-react";
import type { AgentAction, ActionType } from "@/types/recovery";

interface TimelinePanelProps {
  actions: AgentAction[];
}

export function TimelinePanel({ actions }: TimelinePanelProps) {
  const [filter, setFilter] = useState<string>("all");

  const filteredActions = actions.filter((act) => {
    if (filter === "all") return true;
    if (filter === "snapshots") return act.actionType === "snapshot_create";
    if (filter === "mutations") return act.actionType === "file_modify" || act.actionType === "demo_break";
    if (filter === "restores") return act.actionType === "restore";
    if (filter === "validations") return act.actionType === "validate";
    return true;
  });

  const getActionIcon = (type: ActionType) => {
    switch (type) {
      case "snapshot_create":
        return <Camera className="w-3.5 h-3.5 text-cyan-400" />;
      case "file_modify":
        return <FileEdit className="w-3.5 h-3.5 text-indigo-400" />;
      case "demo_break":
        return <Bug className="w-3.5 h-3.5 text-rose-400" />;
      case "restore":
        return <Undo2 className="w-3.5 h-3.5 text-amber-400" />;
      case "validate":
        return <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />;
      default:
        return <Layers className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  const getActionBadge = (type: ActionType) => {
    switch (type) {
      case "snapshot_create":
        return "bg-cyan-950/80 text-cyan-300 border-cyan-800";
      case "file_modify":
        return "bg-indigo-950/80 text-indigo-300 border-indigo-800";
      case "demo_break":
        return "bg-rose-950/80 text-rose-300 border-rose-800";
      case "restore":
        return "bg-amber-950/80 text-amber-300 border-amber-800";
      case "validate":
        return "bg-emerald-950/80 text-emerald-300 border-emerald-800";
      default:
        return "bg-slate-900 text-slate-300 border-slate-800";
    }
  };

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-lg space-y-0">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-950/80 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
            Audit Timeline & Event Stream
          </h3>
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
            {actions.length} recorded
          </span>
        </div>

        {/* Filter Buttons */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: "all", label: "All" },
            { id: "snapshots", label: "Snapshots" },
            { id: "mutations", label: "Modifications" },
            { id: "restores", label: "Restores" },
            { id: "validations", label: "Validations" },
          ].map((btn) => (
            <button
              key={btn.id}
              onClick={() => setFilter(btn.id)}
              className={`px-2.5 py-1 rounded text-[11px] font-mono transition ${
                filter === btn.id
                  ? "bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 font-semibold"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Audit Log Disclaimer Banner */}
      <div className="px-4 py-2 bg-slate-950/40 border-b border-slate-800/80 flex items-center gap-2 text-[10px] text-slate-400 font-mono">
        <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span>
          Application-level audit log for observability and debugging. Not a cryptographically protected audit system.
        </span>
      </div>

      {/* Timeline Stream */}
      <div className="p-4 space-y-3 max-h-[500px] overflow-y-auto">
        {filteredActions.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 font-mono">
            No audit records found matching filter.
          </div>
        ) : (
          filteredActions.map((action) => {
            const isSuccess = action.status === "success";
            return (
              <div
                key={action.id}
                className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition flex flex-col gap-2 font-mono"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-slate-900 border border-slate-800">
                      {getActionIcon(action.actionType)}
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded border uppercase font-bold tracking-wider ${getActionBadge(
                        action.actionType
                      )}`}
                    >
                      {action.actionType}
                    </span>
                    <span className="text-xs font-semibold text-slate-200">
                      {action.summary}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div
                      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border ${
                        isSuccess
                          ? "bg-emerald-950/60 text-emerald-300 border-emerald-800"
                          : "bg-rose-950/60 text-rose-300 border-rose-800"
                      }`}
                    >
                      {isSuccess ? (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          <span>SUCCESS</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-3 h-3 text-rose-400" />
                          <span>FAILURE</span>
                        </>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-500" />
                      {new Date(action.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>

                {/* Sub details: snapshot IDs, target path, errors */}
                <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-3 pt-1 border-t border-slate-900">
                  <span className="text-slate-400 font-mono">ID: {action.id}</span>
                  {action.targetPath && (
                    <span>
                      Target: <code className="text-cyan-400">{action.targetPath}</code>
                    </span>
                  )}
                  {action.snapshotIdBefore && (
                    <span>
                      Pre-Snap: <code className="text-slate-300">{action.snapshotIdBefore.slice(0, 16)}...</code>
                    </span>
                  )}
                  {action.snapshotIdAfter && (
                    <span>
                      Post-Snap: <code className="text-emerald-400">{action.snapshotIdAfter.slice(0, 16)}...</code>
                    </span>
                  )}
                  {action.error && (
                    <span className="text-rose-400 font-medium">Error: {action.error}</span>
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

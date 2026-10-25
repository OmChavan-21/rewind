"use client";

import React from "react";
import {
  ShieldCheck,
  History,
  Camera,
  FolderGit2,
  Settings,
  Activity,
  Cpu,
  Bot,
  FileCode,
  BookOpen,
  ChevronRight,
} from "lucide-react";
import type { WorkspaceStatus } from "@/types/recovery";

export type ActiveTab =
  | "overview"
  | "diagnostics"
  | "rag"
  | "ai"
  | "snapshots"
  | "activity"
  | "settings";

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  workspaceStatus?: WorkspaceStatus;
  fileCount: number;
  snapshotCount: number;
  aiConnected?: boolean;
  activeProjectId?: string;
  onOpenProjectManager?: () => void;
  diagnosticErrorCount?: number;
  ragDocsCount?: number;
}

export function Sidebar({
  activeTab,
  setActiveTab,
  workspaceStatus = "healthy",
  fileCount,
  snapshotCount,
  aiConnected = false,
  activeProjectId = "demo-workspace",
  onOpenProjectManager,
  diagnosticErrorCount = 0,
  ragDocsCount = 0,
}: SidebarProps) {
  const navItems = [
    {
      id: "overview" as const,
      label: "Workspace Files",
      icon: Activity,
      badge: workspaceStatus === "healthy" ? "Healthy" : "Degraded",
      badgeColor:
        workspaceStatus === "healthy"
          ? "bg-emerald-950 text-emerald-400 border-emerald-800"
          : "bg-rose-950 text-rose-400 border-rose-800",
    },
    {
      id: "diagnostics" as const,
      label: "Code Diagnostics",
      icon: FileCode,
      badge: diagnosticErrorCount > 0 ? `${diagnosticErrorCount} err` : "Pass",
      badgeColor:
        diagnosticErrorCount > 0
          ? "bg-rose-950 text-rose-400 border-rose-800 animate-pulse"
          : "bg-emerald-950 text-emerald-400 border-emerald-800",
    },
    {
      id: "rag" as const,
      label: "RAG Knowledge",
      icon: BookOpen,
      badge: ragDocsCount > 0 ? `${ragDocsCount} docs` : undefined,
      badgeColor: "bg-teal-950 text-teal-400 border-teal-800",
    },
    {
      id: "ai" as const,
      label: "AI Proposals (NVIDIA)",
      icon: Bot,
      badge: aiConnected ? "Live" : "Setup",
      badgeColor: aiConnected
        ? "bg-emerald-950 text-emerald-400 border-emerald-800"
        : "bg-amber-950 text-amber-400 border-amber-800",
    },
    {
      id: "snapshots" as const,
      label: "Snapshots Vault",
      icon: Camera,
      badge: String(snapshotCount),
      badgeColor: "bg-cyan-950 text-cyan-400 border-cyan-800",
    },
    {
      id: "activity" as const,
      label: "Audit Timeline",
      icon: History,
    },
    {
      id: "settings" as const,
      label: "Settings & Limits",
      icon: Settings,
    },
  ];

  return (
    <aside className="w-64 bg-slate-950/80 backdrop-blur-xl border-r border-slate-800/80 flex flex-col justify-between shrink-0 h-screen sticky top-0 select-none">
      <div>
        {/* Brand Header */}
        <div className="p-5 border-b border-slate-800/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-teal-500 to-emerald-400 shadow-lg shadow-cyan-500/20 text-slate-950">
              <FolderGit2 className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-white">Rewind</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                  v0.2
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium">Agent Reliability Engine</p>
            </div>
          </div>
        </div>

        {/* Hackathon Badge */}
        <div className="mx-4 mt-4 p-2.5 rounded-lg bg-gradient-to-r from-emerald-950/40 via-cyan-950/30 to-purple-950/40 border border-slate-800/80 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="text-[11px] text-slate-300 leading-tight">
            <span className="font-semibold text-emerald-300">NVIDIA × Nebius</span>
            <span className="block text-[10px] text-slate-400">Global AI Hackathon</span>
          </div>
        </div>

        {/* Workspace Selector Card */}
        <div className="px-4 mt-5">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
              Active Project
            </label>
            {onOpenProjectManager && (
              <button
                onClick={onOpenProjectManager}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-mono transition"
              >
                Switch
              </button>
            )}
          </div>
          <button
            onClick={onOpenProjectManager}
            className="w-full p-2.5 rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-800 flex items-center justify-between transition group text-left"
          >
            <div className="flex items-center gap-2 truncate min-w-0">
              <div
                className={`w-2 h-2 rounded-full shrink-0 ${
                  workspaceStatus === "healthy"
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                    : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)] animate-pulse"
                }`}
              />
              <span className="text-xs font-mono font-medium text-slate-200 truncate">
                {activeProjectId}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              <span className="text-[10px] text-slate-400 font-mono">{fileCount} files</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 transition" />
            </div>
          </button>
        </div>

        {/* Navigation */}
        <nav className="px-3 mt-5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? "bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 shadow-sm shadow-cyan-500/5 font-semibold"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 transition-colors ${
                      isActive ? "text-cyan-400 stroke-[2.2]" : "text-slate-500 stroke-[1.8]"
                    }`}
                  />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                      item.badgeColor || "bg-slate-800 text-slate-400 border-slate-700"
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Safety Sandbox Badge */}
      <div className="p-4 border-t border-slate-800/60">
        <div className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5 font-semibold text-slate-300 mb-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Sandbox Enforced</span>
          </div>
          <p className="text-[10px] text-slate-400 leading-snug">
            Single-workspace path containment with immutable snapshot recovery.
          </p>
        </div>
      </div>
    </aside>
  );
}

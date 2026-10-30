"use client";

import React, { useState } from "react";
import {
  FolderGit2,
  X,
  Plus,
  CheckCircle2,
  FolderOpen,
  Calendar,
  Layers,
  HardDrive,
  RotateCw,
  Sparkles,
} from "lucide-react";
import type { ProjectMetadata } from "../types/project";

interface ProjectManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectMetadata[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (name: string, description?: string, template?: "empty" | "demo") => Promise<void>;
  onRefresh: () => void;
}

export function ProjectManagerModal({
  isOpen,
  onClose,
  projects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onRefresh,
}: ProjectManagerModalProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [template, setTemplate] = useState<"demo" | "empty">("empty");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setError("Please enter a project name.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreateProject(newName.trim(), newDescription.trim() || undefined, template);
      setNewName("");
      setNewDescription("");
      setShowCreateForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 overflow-hidden max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Project Workspaces</h2>
              <p className="text-xs text-slate-400">
                Manage, isolate, and switch between project environments.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              title="Refresh project list"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            >
              <RotateCw className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4 pr-1">
          {showCreateForm ? (
            <form onSubmit={handleCreate} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
                Create New Isolated Project
              </h3>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Fraud Detection Agent"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Briefly describe the purpose of this workspace"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Starter Template
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setTemplate("demo")}
                    className={`p-2.5 rounded-lg border text-left text-xs transition ${
                      template === "demo"
                        ? "border-cyan-500/80 bg-cyan-500/10 text-cyan-300"
                        : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <span className="font-semibold block text-slate-200">Demo Blueprint</span>
                    <span className="text-[11px] block mt-0.5">Includes workflow, evaluator, and runtime configs.</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTemplate("empty")}
                    className={`p-2.5 rounded-lg border text-left text-xs transition ${
                      template === "empty"
                        ? "border-cyan-500/80 bg-cyan-500/10 text-cyan-300"
                        : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <span className="font-semibold block text-slate-200">Empty Workspace</span>
                    <span className="text-[11px] block mt-0.5">Clean folder initialized with only a README.</span>
                  </button>
                </div>
              </div>

              {error && <p className="text-xs text-rose-400">{error}</p>}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 font-semibold text-xs transition"
                >
                  {isSubmitting ? "Creating..." : "Create Project"}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400 font-mono">
                {projects.length} project(s) accessible
              </span>
              <button
                onClick={() => setShowCreateForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-xs font-semibold transition"
              >
                <Plus className="w-3.5 h-3.5" />
                New Project
              </button>
            </div>
          )}

          {/* Projects List */}
          <div className="space-y-2.5">
            {projects.map((proj) => {
              const isActive = proj.id === activeProjectId;
              return (
                <div
                  key={proj.id}
                  className={`p-3.5 rounded-xl border transition flex items-center justify-between gap-4 ${
                    isActive
                      ? "bg-cyan-950/20 border-cyan-500/40 shadow-sm shadow-cyan-500/10"
                      : "bg-slate-950/40 border-slate-800/80 hover:border-slate-700"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FolderOpen className={`w-4 h-4 ${isActive ? "text-cyan-400" : "text-slate-400"}`} />
                      <h4 className="text-sm font-semibold text-slate-200 truncate">
                        {proj.name}
                      </h4>
                      {isActive && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                          <CheckCircle2 className="w-2.5 h-2.5" /> Active
                        </span>
                      )}
                      {proj.isDefault && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20">
                          Default Demo
                        </span>
                      )}
                    </div>

                    {proj.description && (
                      <p className="text-xs text-slate-400 mt-1 line-clamp-1">
                        {proj.description}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-slate-500 font-mono">
                      <span className="flex items-center gap-1">
                        <Layers className="w-3 h-3 text-slate-400" />
                        {proj.fileCount} files
                      </span>
                      <span className="flex items-center gap-1">
                        <HardDrive className="w-3 h-3 text-slate-400" />
                        {(proj.totalSizeBytes / 1024).toFixed(1)} KB
                      </span>
                      <span className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-cyan-400" />
                        {proj.snapshotCount} snapshots
                      </span>
                      <span className="flex items-center gap-1 text-[10px]">
                        <Calendar className="w-3 h-3 text-slate-400" />
                        {new Date(proj.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="shrink-0">
                    {isActive ? (
                      <span className="text-xs font-mono text-cyan-400 font-medium">Selected</span>
                    ) : (
                      <button
                        onClick={() => {
                          onSelectProject(proj.id);
                          onClose();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
                      >
                        Switch
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

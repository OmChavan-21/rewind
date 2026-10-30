"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Sidebar, type ActiveTab } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { HealthOverview } from "@/components/HealthOverview";
import { DemoControlBar } from "@/components/DemoControlBar";
import { FileExplorer } from "@/components/FileExplorer";
import { DiffViewer } from "@/components/DiffViewer";
import { TimelinePanel } from "@/components/TimelinePanel";
import { SnapshotHistory } from "@/components/SnapshotHistory";
import { SettingsPanel } from "@/components/SettingsPanel";
import { NewSnapshotModal } from "@/components/NewSnapshotModal";
import { AIAssistantPanel } from "@/components/AIAssistantPanel";
import { UploadModal } from "@/components/UploadModal";
import { ProjectManagerModal } from "@/components/ProjectManagerModal";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { RAGPanel } from "@/components/RAGPanel";
import type {
  Workspace,
  Snapshot,
  AgentAction,
  ValidationResult,
  PermittedFile,
} from "@/types/recovery";
import type { AIStatus } from "@/types/ai";
import type { ProjectMetadata } from "@/types/project";
import type { AuthUser } from "@/types/auth";
import type { WorkspaceDiagnosticsResult } from "@/types/diagnostics";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  description?: string;
}

export default function RewindDashboard() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");

  // Core workspace & recovery state
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [files, setFiles] = useState<PermittedFile[]>([]);
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [selectedSnapshotIdForDiff, setSelectedSnapshotIdForDiff] = useState<string>("");
  const [selectedFileForExplorer, setSelectedFileForExplorer] = useState<string>("");

  // Projects state
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>("demo-workspace");

  // Diagnostics & RAG state
  const [diagnosticsResult, setDiagnosticsResult] = useState<WorkspaceDiagnosticsResult | null>(null);
  const [isLoadingDiagnostics, setIsLoadingDiagnostics] = useState<boolean>(false);
  const [ragDocsCount, setRagDocsCount] = useState<number>(0);

  // User & Authentication state
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [authModalMode, setAuthModalMode] = useState<AuthMode>("login");
  const [authModalOobCode, setAuthModalOobCode] = useState<string>("");
  const [isResendingVerification, setIsResendingVerification] = useState<boolean>(false);

  // Modals & UI state
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((msg: Omit<ToastMessage, "id">) => {
    const id = String(Date.now());
    setToast({ id, ...msg });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 5000);
  }, []);

  // Fetch all dashboard data for active project
  const refreshData = useCallback(
    async (targetProjectId?: string) => {
      const projId = targetProjectId || activeProjectId;
      setIsLoading(true);
      try {
        const [wsRes, snapRes, actRes, fileRes, aiRes, projRes, diagRes, ragRes] =
          await Promise.all([
            fetch(`/api/workspace?projectId=${projId}`),
            fetch(`/api/snapshots?projectId=${projId}`),
            fetch("/api/audit"),
            fetch(`/api/workspace/files?projectId=${projId}`),
            fetch("/api/ai/status"),
            fetch("/api/projects"),
            fetch(`/api/workspace/diagnostics?projectId=${projId}`),
            fetch(`/api/rag/documents?projectId=${projId}`).catch(() => null),
          ]);

        const [
          wsData,
          snapData,
          actData,
          fileData,
          aiData,
          projData,
          diagData,
          ragData,
        ] = await Promise.all([
          wsRes.json(),
          snapRes.json(),
          actRes.json(),
          fileRes.json(),
          aiRes.json().catch(() => ({})),
          projRes.json().catch(() => ({ projects: [] })),
          diagRes.json().catch(() => null),
          ragRes ? ragRes.json().catch(() => null) : null,
        ]);

        if (wsData.workspace) setWorkspace(wsData.workspace);
        if (wsData.validation) setValidation(wsData.validation);
        if (snapData.snapshots) setSnapshots(snapData.snapshots);
        if (actData.actions) setActions(actData.actions);
        setFiles(Array.isArray(fileData.files) ? fileData.files : []);
        if (aiData.status) setAiStatus(aiData.status);
        if (projData.projects) setProjects(projData.projects);
        if (diagData) setDiagnosticsResult(diagData);
        if (ragData && ragData.documents) setRagDocsCount(ragData.documents.length);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "Failed to load dashboard data";
        showToast({
          type: "error",
          title: "Sync Error",
          description: errMsg,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [activeProjectId, showToast]
  );

  useEffect(() => {
    let isMounted = true;
    const projId = activeProjectId;

    Promise.all([
      fetch(`/api/workspace?projectId=${projId}`).then((r) => r.json()),
      fetch(`/api/snapshots?projectId=${projId}`).then((r) => r.json()),
      fetch("/api/audit").then((r) => r.json()),
      fetch(`/api/workspace/files?projectId=${projId}`).then((r) => r.json()),
      fetch("/api/ai/status").then((r) => r.json()).catch(() => ({})),
      fetch("/api/projects").then((r) => r.json()).catch(() => ({ projects: [] })),
      fetch(`/api/workspace/diagnostics?projectId=${projId}`).then((r) => r.json()).catch(() => null),
      fetch(`/api/rag/documents?projectId=${projId}`).then((r) => r.json()).catch(() => null),
    ])
      .then(([wsData, snapData, actData, fileData, aiData, projData, diagData, ragData]) => {
        if (!isMounted) return;
        if (wsData?.workspace) setWorkspace(wsData.workspace);
        if (wsData?.validation) setValidation(wsData.validation);
        if (snapData?.snapshots) setSnapshots(snapData.snapshots);
        if (actData?.actions) setActions(actData.actions);
        if (fileData?.files) setFiles(fileData.files);
        if (aiData?.status) setAiStatus(aiData.status);
        if (projData?.projects) setProjects(projData.projects);
        if (diagData) setDiagnosticsResult(diagData);
        if (ragData?.documents) setRagDocsCount(ragData.documents.length);
      })
      .catch((err: unknown) => {
        if (!isMounted) return;
        const errMsg = err instanceof Error ? err.message : "Failed to load dashboard data";
        showToast({
          type: "error",
          title: "Sync Error",
          description: errMsg,
        });
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeProjectId, showToast]);

  // Check authenticated user on load & detect password recovery action codes
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.user) {
          setCurrentUser(data.user);
        }
      })
      .catch(() => {});

    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const oobCode = urlParams.get("oobCode");
      const mode = urlParams.get("mode");
      if (oobCode && (mode === "resetPassword" || !mode)) {
        queueMicrotask(() => {
          setAuthModalMode("reset");
          setAuthModalOobCode(oobCode);
          setIsAuthModalOpen(true);
        });
      }
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setCurrentUser(null);
      refreshData();
      showToast({
        type: "info",
        title: "Signed Out",
        description: "You have been logged out successfully.",
      });
    } catch {
      // Ignored
    }
  }, [refreshData, showToast]);

  const handleResendVerificationEmail = useCallback(async () => {
    if (!currentUser) return;
    setIsResendingVerification(true);
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: currentUser.email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send verification email");
      showToast({
        type: "success",
        title: "Verification Email Sent",
        description: data.message || "Please check your inbox.",
      });
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Email Dispatch Error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsResendingVerification(false);
    }
  }, [currentUser, showToast]);

  // Project Switching
  const handleSelectProject = async (projectId: string) => {
    try {
      setIsLoading(true);
      const res = await fetch(`/api/projects/${projectId}`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to switch project");
      setFiles([]);
      setSelectedFileForExplorer("");
      setActiveProjectId(projectId);
      showToast({
        type: "info",
        title: "Project Switched",
        description: `Active workspace changed to '${projectId}'.`,
      });
      await refreshData(projectId);
    } catch (err) {
      showToast({
        type: "error",
        title: "Project Switch Error",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Create Project
  const handleCreateProject = async (
    name: string,
    description?: string,
    template?: "empty" | "demo"
  ) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, template }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to create project");
    }

    showToast({
      type: "success",
      title: "Project Created",
      description: `New isolated project '${data.project.name}' initialized.`,
    });
    setFiles([]);
    setSelectedFileForExplorer("");
    setActiveProjectId(data.project.id);
    await refreshData(data.project.id);
  };

  const handleDeleteWorkspaceFile = async (filePath: string) => {
    try {
      const params = new URLSearchParams({ path: filePath, projectId: activeProjectId });
      const res = await fetch(`/api/workspace/file?${params.toString()}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to delete file.");
      if (selectedFileForExplorer === filePath) setSelectedFileForExplorer("");
      await refreshData(activeProjectId);
      showToast({
        type: "success",
        title: "File Deleted",
        description: `${filePath} was removed from this workspace.`,
      });
    } catch (error) {
      showToast({
        type: "error",
        title: "Delete Failed",
        description: error instanceof Error ? error.message : "Failed to delete file.",
      });
    }
  };

  // Rerun Code Diagnostics
  const handleRerunDiagnostics = async () => {
    setIsLoadingDiagnostics(true);
    try {
      const res = await fetch("/api/workspace/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      const data = await res.json();
      if (res.ok) {
        setDiagnosticsResult(data);
        showToast({
          type: data.hasErrors ? "info" : "success",
          title: "Diagnostics Pass Complete",
          description: data.hasErrors
            ? `${data.errorCount} error(s) detected across workspace files.`
            : "All workspace files passed AST syntax and schema validation.",
        });
      }
    } catch (err) {
      showToast({
        type: "error",
        title: "Diagnostics Error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoadingDiagnostics(false);
    }
  };

  // Demo Action 1: Controlled File Modification
  const handleModifyFile = async () => {
    try {
      setIsLoading(true);
      const currentRes = await fetch(
        `/api/workspace/file?path=agent-workflow.json&projectId=${activeProjectId}`
      );
      const currentJson = await currentRes.json();

      let newWorkflowContent = "";
      try {
        const parsed = JSON.parse(currentJson.content);
        const newVersion = (parseFloat(parsed.version || "1.0") + 0.1).toFixed(1);
        parsed.version = `${newVersion}.0`;
        if (!parsed.permittedTools.includes("automated_recovery_evaluator")) {
          parsed.permittedTools.push("automated_recovery_evaluator");
        }
        newWorkflowContent = JSON.stringify(parsed, null, 2);
      } catch {
        newWorkflowContent = `{\n  "agentName": "NebiusNvidiaRecoveryBot",\n  "version": "1.1.0",\n  "environment": "sandbox-demo",\n  "maxRetryAttempts": 4,\n  "permittedTools": ["code_analysis", "diff_verifier", "syntax_validator", "snapshot_engine"],\n  "steps": [{"stepId": "01_analyze", "action": "code_analysis"}]\n}\n`;
      }

      const res = await fetch("/api/actions/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "agent-workflow.json",
          content: newWorkflowContent,
          summary: "Updated agent-workflow.json (version & tool allowlist)",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Modification failed");

      showToast({
        type: "success",
        title: "Controlled Edit Applied",
        description: `Pre-change safety snapshot captured (${data.snapshotBeforeId.slice(0, 14)}...). File updated.`,
      });
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Modification Refused",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Demo Action 2: Introduce Demo Failure
  const handleIntroduceFailure = async (
    target: "agent-workflow.json" | "src/evaluator.ts"
  ) => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/actions/demo-break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetFile: target }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to inject error");

      showToast({
        type: "info",
        title: "Demo Failure Injected",
        description: `Synthetic failure introduced in ${target}. Safety checkpoint created before break.`,
      });
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Error Injecting Failure",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Demo Action 3: Validate Workspace
  const handleValidate = async () => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/actions/validate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Validation failed");

      setValidation(data.validation);
      if (data.validation.passed) {
        showToast({
          type: "success",
          title: "Validation Passed",
          description: "All deterministic project invariants and schemas passed.",
        });
      } else {
        showToast({
          type: "error",
          title: "Validation Invariant Failures",
          description: data.validation.summary,
        });
      }
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Validation Error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Restore Snapshot
  const handleRestoreSnapshot = async (snapshotId: string) => {
    try {
      setIsLoading(true);
      const res = await fetch(`/api/snapshots/${snapshotId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.result?.message || "Restore failed");
      }

      showToast({
        type: "success",
        title: "Snapshot Restored",
        description: data.result.message,
      });
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Recovery Refused / Failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreLatest = async () => {
    if (snapshots.length === 0) return;
    await handleRestoreSnapshot(snapshots[0].id);
  };

  // Reset Blueprint
  const handleResetWorkspace = async () => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, projectId: activeProjectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset workspace");

      showToast({
        type: "success",
        title: "Workspace Blueprint Reset",
        description: "Reinitialized clean sample project files.",
      });
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Reset Error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Create New Snapshot
  const handleCreateSnapshot = async (name: string, description: string) => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, projectId: activeProjectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create snapshot");

      showToast({
        type: "success",
        title: "Snapshot Created",
        description: `Snapshot '${data.snapshot.name}' (${data.snapshot.id}) saved to .rewind_store.`,
      });
      await refreshData();
    } catch (err: unknown) {
      showToast({
        type: "error",
        title: "Snapshot Error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row antialiased selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm rounded-xl p-3.5 bg-slate-900 border border-slate-700 shadow-2xl flex items-start gap-3 animate-in fade-in slide-in-from-bottom-3 duration-200 font-mono">
          {toast.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 text-xs">
            <div className="font-bold text-slate-100">{toast.title}</div>
            {toast.description && (
              <div className="text-[11px] text-slate-400 font-sans mt-0.5 leading-snug">
                {toast.description}
              </div>
            )}
          </div>
          <button
            onClick={() => setToast(null)}
            className="text-slate-500 hover:text-slate-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Sidebar Navigation */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        workspaceStatus={validation?.passed === false ? "degraded" : workspace?.status}
        fileCount={files.length}
        snapshotCount={snapshots.length}
        aiConnected={aiStatus?.state === "connected"}
        activeProjectId={activeProjectId}
        onOpenProjectManager={() => setIsProjectModalOpen(true)}
        diagnosticErrorCount={diagnosticsResult?.errorCount ?? 0}
        ragDocsCount={ragDocsCount}
      />

      {/* Main Content Pane */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          status={validation?.passed === false ? "degraded" : workspace?.status || "healthy"}
          validation={validation || undefined}
          activeProjectId={activeProjectId}
          onOpenSnapshotModal={() => setIsModalOpen(true)}
          onRunValidation={handleValidate}
          onRefresh={() => refreshData()}
          isLoading={isLoading}
          onOpenUpload={() => setIsUploadModalOpen(true)}
          onOpenProjectManager={() => setIsProjectModalOpen(true)}
          currentUser={currentUser}
          onOpenAuthModal={() => setIsAuthModalOpen(true)}
          onLogout={handleLogout}
        />

        {currentUser && currentUser.emailVerified === false && (
          <div className="bg-amber-950/60 border-b border-amber-800/80 px-6 py-2.5 flex items-center justify-between text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Your email (<strong>{currentUser.email}</strong>) is not verified. Check your inbox for the verification link.
              </span>
            </div>
            <button
              onClick={handleResendVerificationEmail}
              disabled={isResendingVerification}
              className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-medium transition disabled:opacity-50"
            >
              {isResendingVerification ? "Sending..." : "Resend Verification Email"}
            </button>
          </div>
        )}

        <main className="p-6 max-w-7xl w-full mx-auto space-y-6">
          {/* Invariant Failure Alert if Broken */}
          {validation && !validation.passed && (
            <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in duration-200 font-mono">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
                <div>
                  <h4 className="text-xs font-bold text-rose-200 uppercase tracking-wider">
                    Deterministic Invariant Check Failed
                  </h4>
                  <p className="text-xs text-rose-300 font-sans">
                    {validation.summary}
                  </p>
                </div>
              </div>
              <button
                onClick={handleRestoreLatest}
                disabled={isLoading || snapshots.length === 0}
                className="px-3.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 text-xs font-bold transition shrink-0 shadow-md shadow-rose-500/20"
              >
                Safe Rollback Now
              </button>
            </div>
          )}

          {/* TAB 1: Workspace Files & Overview */}
          {activeTab === "overview" && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <HealthOverview
                workspace={workspace}
                snapshots={snapshots}
                validation={validation}
                actionCount={actions.length}
              />

              <DemoControlBar
                onModifyFile={handleModifyFile}
                onIntroduceFailure={handleIntroduceFailure}
                onValidate={handleValidate}
                onRestoreLatest={handleRestoreLatest}
                onResetWorkspace={handleResetWorkspace}
                hasSnapshots={snapshots.length > 0}
                isLoading={isLoading}
              />

              {/* Workspace Files Explorer with visible Upload Button */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                    Workspace Files ({files.length})
                  </h2>
                  <button
                    onClick={() => setIsUploadModalOpen(true)}
                    className="text-xs text-cyan-400 hover:text-cyan-300 font-mono"
                  >
                    + Upload New Files
                  </button>
                </div>
                <FileExplorer
                  files={files}
                  projectId={activeProjectId}
                  selectedFilePath={selectedFileForExplorer}
                  onSelectFile={(p) => setSelectedFileForExplorer(p)}
                  onDeleteFile={handleDeleteWorkspaceFile}
                  onOpenUpload={() => setIsUploadModalOpen(true)}
                />
              </div>

              {/* Diff Viewer */}
              {snapshots.length > 0 && (
                <div className="space-y-2">
                  <h2 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                    Live Workspace vs. Snapshot Comparison
                  </h2>
                  <DiffViewer
                    snapshots={snapshots}
                    selectedSnapshotId={selectedSnapshotIdForDiff}
                    onSelectSnapshot={(id) => setSelectedSnapshotIdForDiff(id)}
                  />
                </div>
              )}

              {/* Recent Activity Mini-stream */}
              <div className="space-y-2">
                <h2 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                  Recent Audit Actions
                </h2>
                <TimelinePanel actions={actions.slice(0, 5)} />
              </div>
            </div>
          )}

          {/* TAB 2: Real-time Code Diagnostics */}
          {activeTab === "diagnostics" && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <DiagnosticsPanel
                diagnosticsResult={diagnosticsResult}
                isLoading={isLoadingDiagnostics}
                onRerunDiagnostics={handleRerunDiagnostics}
                onSelectFile={(p) => {
                  setSelectedFileForExplorer(p);
                  setActiveTab("overview");
                }}
              />
            </div>
          )}

          {/* TAB 3: RAG Knowledge Base */}
          {activeTab === "rag" && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <RAGPanel
                activeProjectId={activeProjectId}
                onOpenUpload={() => setIsUploadModalOpen(true)}
              />
            </div>
          )}

          {/* TAB 4: AI Proposals (NVIDIA) */}
          {activeTab === "ai" && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <AIAssistantPanel
                aiStatus={aiStatus}
                projectId={activeProjectId}
                onRefreshStatus={async () => {
                  try {
                    const res = await fetch(`/api/ai/status?projectId=${encodeURIComponent(activeProjectId)}`);
                    const data = await res.json();
                    if (data.status) setAiStatus(data.status);
                  } catch {
                    // ignore
                  }
                }}
                onProposalApplied={() => refreshData()}
                onRestoreSnapshot={handleRestoreSnapshot}
              />
            </div>
          )}

          {/* TAB 5: Snapshots Vault */}
          {activeTab === "snapshots" && (
            <div className="space-y-6 animate-in fade-in duration-150">
              <SnapshotHistory
                snapshots={snapshots}
                activeProjectId={activeProjectId}
                onRestoreSnapshot={handleRestoreSnapshot}
                onCompareSnapshot={(id) => {
                  setSelectedSnapshotIdForDiff(id);
                  setActiveTab("overview");
                }}
                isLoading={isLoading}
              />

              {snapshots.length > 0 && (
                <DiffViewer
                  snapshots={snapshots}
                  selectedSnapshotId={selectedSnapshotIdForDiff}
                  onSelectSnapshot={(id) => setSelectedSnapshotIdForDiff(id)}
                />
              )}
            </div>
          )}

          {/* TAB 6: Activity / Audit Timeline */}
          {activeTab === "activity" && (
            <div className="space-y-4 animate-in fade-in duration-150">
              <TimelinePanel actions={actions} />
            </div>
          )}

          {/* TAB 7: Safety & Boundaries / Settings */}
          {activeTab === "settings" && (
            <div className="animate-in fade-in duration-150">
              <SettingsPanel activeProjectId={activeProjectId} />
            </div>
          )}
        </main>
      </div>

      {/* New Snapshot Dialog */}
      <NewSnapshotModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreateSnapshot={handleCreateSnapshot}
        isLoading={isLoading}
      />

      {/* Upload Files Modal */}
      <UploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        activeProjectId={activeProjectId}
        onUploadSuccess={() => refreshData()}
      />

      {/* Project Switcher & Manager Modal */}
      <ProjectManagerModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onRefresh={() => refreshData()}
      />

      {/* User Authentication Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => {
          setIsAuthModalOpen(false);
          setAuthModalMode("login");
          setAuthModalOobCode("");
        }}
        initialMode={authModalMode}
        initialOobCode={authModalOobCode}
        onAuthSuccess={(user) => {
          setCurrentUser(user);
          refreshData();
          showToast({
            type: user.emailVerified === false ? "info" : "success",
            title: user.emailVerified === false ? "Verification Email Sent" : "Welcome to Rewind",
            description: user.emailVerified === false
              ? `Signed in as ${user.email}. Please check your inbox for the verification link.`
              : `Signed in as ${user.email}`,
          });
        }}
      />
    </div>
  );
}

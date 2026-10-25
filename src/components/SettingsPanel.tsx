"use client";

import React, { useState, useEffect } from "react";
import {
  FileCheck,
  Database,
  Cpu,
  HardDrive,
  Cloud,
  CheckCircle2,
  RotateCw,
  Gauge,
  Layers,
  Activity,
  AlertTriangle,
} from "lucide-react";
import type {
  ResourceLimits,
  MemoryMetrics,
  EffectiveResourceLimits,
  RAGProcessingStatus,
} from "../types/limits";
import type { FirebaseConnectionStatus } from "../server/firebaseService";

interface SettingsPanelProps {
  activeProjectId?: string;
}

export function SettingsPanel({ activeProjectId }: SettingsPanelProps) {
  const [limits, setLimits] = useState<ResourceLimits | null>(null);
  const [dynamicLimits, setDynamicLimits] = useState<EffectiveResourceLimits | null>(null);
  const [memoryMetrics, setMemoryMetrics] = useState<MemoryMetrics | null>(null);
  const [ragStatus, setRagStatus] = useState<RAGProcessingStatus | null>(null);
  const [firebaseStatus, setFirebaseStatus] = useState<FirebaseConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const handleManualRefresh = async () => {
    setIsLoading(true);
    try {
      const url = activeProjectId
        ? `/api/system/limits?projectId=${encodeURIComponent(activeProjectId)}`
        : "/api/system/limits";
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setLimits(data.limits);
        setDynamicLimits(data.dynamicLimits);
        setMemoryMetrics(data.memoryMetrics);
        setRagStatus(data.ragStatus);
        setFirebaseStatus(data.firebaseStatus);
        setLastRefreshed(new Date().toLocaleTimeString());
      }
    } catch {
      // Ignore network errors in manual refresh
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const url = activeProjectId
      ? `/api/system/limits?projectId=${encodeURIComponent(activeProjectId)}`
      : "/api/system/limits";

    const fetchLiveLimits = () => {
      fetch(url)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!isMounted || !data) return;
          setLimits(data.limits);
          setDynamicLimits(data.dynamicLimits);
          setMemoryMetrics(data.memoryMetrics);
          setRagStatus(data.ragStatus);
          setFirebaseStatus(data.firebaseStatus);
          setLastRefreshed(new Date().toLocaleTimeString());
        })
        .catch(() => {});
    };

    fetchLiveLimits();

    // Sensible polling interval: refresh every 20 seconds to keep live metrics up-to-date
    const interval = setInterval(fetchLiveLimits, 20000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeProjectId]);

  const pressureLevel = dynamicLimits?.status.pressureLevel || memoryMetrics?.pressureLevel || "low";
  const reasons = dynamicLimits?.reasonsForReduction || [];

  const configured = dynamicLimits?.configured || limits;
  const effective = dynamicLimits?.effective;

  // Storage headroom
  const workspaceBytes = memoryMetrics?.storageMetrics.workspaceDiskUsedBytes ?? 0;
  const maxStorageBytes = configured?.maxProjectStorageBytes ?? 100 * 1024 * 1024;
  const storageUsedPercent = Math.min(100, Math.round((workspaceBytes / maxStorageBytes) * 100));

  // Heap ratio
  const heapUsedMb = memoryMetrics?.serverMemory.heapUsedMb ?? 0;
  const heapLimitMb = memoryMetrics?.serverMemory.heapLimitMb ?? 1024;
  const heapPercent = Math.min(100, Math.round((heapUsedMb / heapLimitMb) * 100));

  // Host RAM ratio
  const systemMemory = memoryMetrics?.systemMemory;

  const pressureBadgeColor = {
    low: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    moderate: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    high: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    critical: "bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse",
  }[pressureLevel];

  return (
    <div className="space-y-6">
      {/* Top Banner: System Health & Persistence */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Gauge className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-semibold text-slate-100">
              Dynamic Resource Intelligence & Limits
            </h2>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider border ${pressureBadgeColor}`}
            >
              Pressure: {pressureLevel}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Active Project: <span className="text-cyan-300">{activeProjectId || "default"}</span>
            {lastRefreshed && (
              <span className="text-slate-500 ml-2">· Synced at {lastRefreshed}</span>
            )}
          </p>
        </div>

        <button
          onClick={handleManualRefresh}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition self-start md:self-auto"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-cyan-400" : ""}`} />
          Refresh Metrics
        </button>
      </div>

      {/* Dynamic Resource Status & Reasons Alert */}
      {reasons.length > 0 ? (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
          <div className="flex items-center gap-2 text-amber-300 font-semibold text-xs">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Dynamic Limit Adjustments Active</span>
          </div>
          <p className="text-[11px] text-amber-200/90 leading-relaxed">
            Effective upload limits have been dynamically reduced below administrator caps to prevent
            memory exhaustion and protect process stability:
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs text-amber-100 font-mono">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Resource Headroom Optimal — Full 100% capacity available across all limits.</span>
          </div>
          <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
            No Reductions Active
          </span>
        </div>
      )}

      {/* Live Resource Gauges: Heap, RAM, Storage Quota */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Storage Quota Gauge */}
        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-teal-400" /> Project Storage
            </span>
            <span className="font-mono text-[11px] text-teal-400 font-bold">{storageUsedPercent}%</span>
          </div>
          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
            <div
              className={`h-full transition-all duration-300 ${
                storageUsedPercent > 90 ? "bg-rose-500" : storageUsedPercent > 70 ? "bg-amber-500" : "bg-teal-400"
              }`}
              style={{ width: `${Math.max(2, storageUsedPercent)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400">
            <span>Used: {(workspaceBytes / 1024).toFixed(1)} KB</span>
            <span>Cap: {(maxStorageBytes / (1024 * 1024)).toFixed(0)} MB</span>
          </div>
        </div>

        {/* V8 Server Heap Gauge */}
        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" /> Server V8 Heap
            </span>
            <span className="font-mono text-[11px] text-cyan-400 font-bold">{heapPercent}%</span>
          </div>
          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
            <div
              className={`h-full transition-all duration-300 ${
                heapPercent > 85 ? "bg-rose-500" : heapPercent > 70 ? "bg-amber-500" : "bg-cyan-400"
              }`}
              style={{ width: `${Math.max(2, heapPercent)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400">
            <span>Used: {heapUsedMb} MB</span>
            <span>Limit: {heapLimitMb} MB</span>
          </div>
        </div>

        {/* Host OS RAM */}
        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-purple-400" /> Host System RAM
            </span>
            <span className="font-mono text-[11px] text-purple-400 font-bold">
              {systemMemory ? `${systemMemory.freePercent}% Free` : "N/A"}
            </span>
          </div>
          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
            <div
              className="h-full bg-purple-400 transition-all duration-300"
              style={{ width: `${systemMemory ? 100 - systemMemory.freePercent : 30}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400">
            <span>Free: {systemMemory ? `${systemMemory.freeMb} MB` : "--"}</span>
            <span>Total: {systemMemory ? `${systemMemory.totalMb} MB` : "--"}</span>
          </div>
        </div>
      </div>

      {/* Configured Hard Caps vs. Effective Dynamic Limits Comparison Table */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <FileCheck className="w-4 h-4 text-cyan-400" />
            Configured Caps vs. Effective Dynamic Limits
          </h3>
          <span className="text-[10px] font-mono text-slate-400">
            Admin Caps = Upper Bounds · Effective = Real-time
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
          {/* Max Code File Size */}
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="text-[10px] text-slate-400 block">Code File Limit</span>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold text-cyan-400">
                {effective
                  ? `${(effective.maxFileSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                  : "1.00 MB"}
              </span>
              <span className="text-[10px] text-slate-500">
                Cap: {configured ? `${(configured.maxFileSizeBytes / (1024 * 1024)).toFixed(1)} MB` : "1.0 MB"}
              </span>
            </div>
            {effective && configured && effective.maxFileSizeBytes < configured.maxFileSizeBytes && (
              <span className="text-[9px] text-amber-400 block font-sans">Scaled under pressure</span>
            )}
          </div>

          {/* Max Document Size (PDF) */}
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="text-[10px] text-slate-400 block">PDF / Doc Limit</span>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold text-purple-400">
                {effective
                  ? `${(effective.maxDocumentSizeBytes / (1024 * 1024)).toFixed(1)} MB`
                  : "10 MB"}
              </span>
              <span className="text-[10px] text-slate-500">
                Cap: {configured ? `${(configured.maxDocumentSizeBytes / (1024 * 1024)).toFixed(0)} MB` : "10 MB"}
              </span>
            </div>
            {effective && configured && effective.maxDocumentSizeBytes < configured.maxDocumentSizeBytes && (
              <span className="text-[9px] text-amber-400 block font-sans">Scaled under pressure</span>
            )}
          </div>

          {/* Max Files Per Upload */}
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="text-[10px] text-slate-400 block">Batch File Count</span>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold text-slate-200">
                {effective?.maxFilesPerUpload ?? configured?.maxFilesPerUpload ?? 10} files
              </span>
              <span className="text-[10px] text-slate-500">
                Cap: {configured?.maxFilesPerUpload ?? 10}
              </span>
            </div>
            {effective && configured && effective.maxFilesPerUpload < configured.maxFilesPerUpload && (
              <span className="text-[9px] text-amber-400 block font-sans">Reduced batch count</span>
            )}
          </div>

          {/* Max Total Upload Batch Size */}
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="text-[10px] text-slate-400 block">Batch Payload Cap</span>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold text-slate-200">
                {effective
                  ? `${(effective.maxTotalUploadSizeBytes / (1024 * 1024)).toFixed(1)} MB`
                  : "25 MB"}
              </span>
              <span className="text-[10px] text-slate-500">
                Cap: {configured ? `${(configured.maxTotalUploadSizeBytes / (1024 * 1024)).toFixed(0)} MB` : "25 MB"}
              </span>
            </div>
            {effective && configured && effective.maxTotalUploadSizeBytes < configured.maxTotalUploadSizeBytes && (
              <span className="text-[9px] text-amber-400 block font-sans">Clamped to headroom</span>
            )}
          </div>
        </div>
      </div>

      {/* RAG Concurrency & Processing Engine */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              RAG Processing & Concurrency Engine
            </h3>
          </div>
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            Bounded Concurrency (Max {ragStatus?.maxConcurrency ?? 4})
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-center text-xs">
          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Active Ingestion Jobs</span>
            <span className="text-sm font-bold text-cyan-400">
              {ragStatus?.activeJobs ?? 0}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Queued Chunks</span>
            <span className="text-sm font-bold text-slate-200">
              {ragStatus?.queuedChunks ?? 0}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Indexed Documents</span>
            <span className="text-sm font-bold text-teal-400">
              {ragStatus?.totalIndexedDocuments ?? 0}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Total Vector Chunks</span>
            <span className="text-sm font-bold text-purple-400">
              {ragStatus?.totalChunks ?? 0}
            </span>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          Vector generation uses bounded concurrency with event-loop backpressure yielding to protect Node.js
          responsiveness and prevent out-of-memory crashes during multi-document ingestion.
        </p>
      </div>

      {/* Persistence & Firebase Status Card */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              Persistence Engine & Firebase Database
            </h3>
          </div>
          {firebaseStatus?.state === "connected" ? (
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Firebase Connected
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center gap-1">
              <Database className="w-3 h-3" /> Local Persistence Active
            </span>
          )}
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {firebaseStatus?.message || "Running in secure local persistence mode (.rewind_store/ on server disk)."}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 font-mono text-xs">
          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Backend</span>
            <span className="font-semibold text-cyan-400">
              {memoryMetrics?.persistenceBackend === "hybrid" ? "Cloud Firestore + Local" : "Local Disk (.rewind_store)"}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Snapshot Storage Path</span>
            <span className="font-semibold text-slate-200 truncate block">
              .rewind_store/snapshots/
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <span className="text-[10px] text-slate-400 block">Snapshot Retention</span>
            <span className="font-semibold text-emerald-400">
              Survives Restarts (Persistent)
            </span>
          </div>
        </div>
      </div>

      {/* Memory & Storage Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Server Memory */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              Node.js Server Process Memory
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-center">
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Heap Used</span>
              <span className="text-sm font-bold text-cyan-400">
                {memoryMetrics?.serverMemory.heapUsedMb ?? "--"} MB
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Heap Total</span>
              <span className="text-sm font-bold text-slate-300">
                {memoryMetrics?.serverMemory.heapTotalMb ?? "--"} MB
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Process RSS</span>
              <span className="text-sm font-bold text-slate-300">
                {memoryMetrics?.serverMemory.rssMb ?? "--"} MB
              </span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400">
            Measured via genuine server <code className="text-cyan-400">process.memoryUsage()</code> and{" "}
            <code className="text-cyan-400">v8.getHeapStatistics()</code>.
          </p>
        </div>

        {/* Disk Storage */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-teal-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              Disk Storage Utilization
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-center">
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Workspace</span>
              <span className="text-sm font-bold text-teal-400">
                {memoryMetrics
                  ? (memoryMetrics.storageMetrics.workspaceDiskUsedBytes / 1024).toFixed(1)
                  : "--"}{" "}
                KB
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Snapshots</span>
              <span className="text-sm font-bold text-slate-300">
                {memoryMetrics
                  ? (memoryMetrics.storageMetrics.snapshotsDiskUsedBytes / 1024).toFixed(1)
                  : "--"}{" "}
                KB
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block">Vector Index</span>
              <span className="text-sm font-bold text-slate-300">
                {memoryMetrics
                  ? (memoryMetrics.storageMetrics.vectorStoreDiskUsedBytes / 1024).toFixed(1)
                  : "--"}{" "}
                KB
              </span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400">
            Physical disk space allocated to mutable workspaces, immutable snapshots, and RAG vectors.
          </p>
        </div>
      </div>

      {/* 5 Memory Boundaries Explanation */}
      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          The 5 Memory & Storage Boundaries Explained
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 space-y-1">
            <span className="font-semibold text-cyan-400 block">1. Browser Client Memory</span>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              V8 heap allocated by Google Chrome/Firefox to run the React client application, virtual DOM trees, Diff viewers, and state stores.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 space-y-1">
            <span className="font-semibold text-cyan-400 block">2. Node.js Server Process Heap</span>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              RAM used by the Next.js API server process for AST compilation with the TypeScript compiler API, file buffers, and JSON validation.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 space-y-1">
            <span className="font-semibold text-teal-400 block">3. Local Filesystem Disk Storage</span>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              Hard disk storage hosting sandboxed workspaces, immutable snapshots in <code className="text-slate-300">.rewind_store/snapshots/</code>, and RAG vector indexes.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 space-y-1">
            <span className="font-semibold text-purple-400 block">4. Firebase Firestore Database</span>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              Cloud document storage maintaining project metadata, snapshot indices, and RAG document status under <code className="text-slate-300">users/{'{userId}'}</code> collections.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 md:col-span-2 space-y-1">
            <span className="font-semibold text-amber-400 block">5. External Model-Provider Usage (NVIDIA / Nebius)</span>
            <p className="text-slate-400 leading-relaxed text-[11px]">
              Remote GPU memory and token context buffers managed by NVIDIA NIM / Nebius Token Factory for Nemotron LLM inference.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

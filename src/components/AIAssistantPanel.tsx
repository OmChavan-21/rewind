"use client";

import React, { useState } from "react";
import {
  Sparkles,
  Bot,
  Send,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Shield,
  FileCode,
  Undo2,
  Key,
} from "lucide-react";
import type {
  AIStatus,
  AIChangeProposal,
  ApplyProposalResult,
} from "@/types/ai";

interface AIAssistantPanelProps {
  aiStatus: AIStatus | null;
  onRefreshStatus: () => Promise<void>;
  onProposalApplied: () => Promise<void>;
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

interface ProposalErrorDetails {
  message: string;
  category?: string;
  suggestion?: string;
}

export function AIAssistantPanel({
  aiStatus,
  onRefreshStatus,
  onProposalApplied,
  onRestoreSnapshot,
}: AIAssistantPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [proposal, setProposal] = useState<AIChangeProposal | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<ProposalErrorDetails | null>(null);

  const [isApplying, setIsApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyProposalResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const isConnected = aiStatus?.state === "connected";
  const isUnconfigured = aiStatus?.state === "unconfigured" || !aiStatus;
  const providerName =
    aiStatus?.provider === "nvidia"
      ? "NVIDIA API (integrate.api.nvidia.com)"
      : "Nebius Token Factory";

  // Suggested demo prompts for the hackathon
  const demoPrompts = [
    {
      title: "Add Automated Recovery Guard",
      text: "Update 'agent-workflow.json' to increment the version to 1.2.0 and add 'automated_recovery_guard' to the permittedTools array and steps.",
    },
    {
      title: "Optimize Safety Policy Threshold",
      text: "Update 'src/evaluator.ts' to raise the minimum safetyScore threshold to 0.85 in evaluateSafetyPolicy while keeping all safety invariants intact.",
    },
    {
      title: "Inject Flawed Policy (Failure Test)",
      text: "Inject a broken syntax error or remove the required evaluateSafetyPolicy export in 'src/evaluator.ts' so we can demonstrate deterministic failure detection and rollback.",
    },
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setIsGenerating(true);
    setGenerationError(null);
    setErrorDetails(null);
    setProposal(null);
    setApplyResult(null);
    setApplyError(null);

    try {
      const res = await fetch("/api/ai/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorDetails({
          message: data.error || "Failed to generate proposal",
          category: data.category,
          suggestion: data.suggestion,
        });
        throw new Error(data.error || "Failed to generate proposal");
      }

      setProposal(data.proposal);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setGenerationError(errMsg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleApply = async () => {
    if (!proposal) return;

    setIsApplying(true);
    setApplyError(null);

    try {
      const res = await fetch("/api/ai/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal: { ...proposal, status: "approved" },
          approved: true,
        }),
      });

      const data = await res.json();
      if (!res.ok && !data.result) {
        throw new Error(data.error || "Failed to apply proposal");
      }

      setApplyResult(data.result);
      await onProposalApplied();
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="space-y-6 font-mono">
      {/* Top Banner: Model Status & Provider Details */}
      <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-tr from-emerald-500/20 via-cyan-500/20 to-purple-500/20 border border-cyan-500/30 text-cyan-400">
            <Bot className="w-5 h-5 stroke-[2.2]" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                {providerName}
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                  isConnected
                    ? "bg-emerald-950/80 text-emerald-400 border-emerald-800"
                    : isUnconfigured
                    ? "bg-amber-950/80 text-amber-400 border-amber-800"
                    : "bg-rose-950/80 text-rose-400 border-rose-800"
                }`}
              >
                {isConnected ? "CONNECTED" : isUnconfigured ? "UNCONFIGURED" : "CONFIG ERROR"}
              </span>

              {aiStatus?.endpointReachable && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Endpoint OK
                </span>
              )}
              {aiStatus?.credentialsAccepted && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Key Valid
                </span>
              )}
              {aiStatus?.modelListed && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                  Catalog Verified
                </span>
              )}
              {aiStatus?.generationVerified && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold">
                  Generation Verified
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 font-mono mt-0.5">
              Model: <code className="text-cyan-300 font-semibold">{aiStatus?.model || "nvidia/nemotron-3.5-lightning-30b-a3b"}</code>
            </p>
            {aiStatus?.message && !isConnected && (
              <p className="text-[10px] text-rose-300 font-sans mt-0.5">
                {aiStatus.message}
              </p>
            )}
          </div>
        </div>

        <button
          onClick={onRefreshStatus}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 border border-slate-700 transition shrink-0"
        >
          Check API Status
        </button>
      </div>

      {/* Unconfigured Setup Instructions Banner */}
      {isUnconfigured && (
        <div className="p-5 rounded-xl bg-slate-900/90 border border-amber-800/80 shadow-xl space-y-3 font-sans">
          <div className="flex items-center gap-2 font-mono">
            <Key className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs font-bold text-amber-300 uppercase tracking-wider">
              Setup Guide: Connect Nebius Token Factory
            </h3>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Rewind uses real open-weights models served through Nebius Token Factory. To enable autonomous AI change proposals, configure your credentials in <code className="text-cyan-300 font-mono">.env.local</code>:
          </p>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
            <p className="text-slate-400"># In C:\Rewind\rewind\.env.local (ignored by git):</p>
            <p className="text-emerald-400">NEBIUS_API_KEY=&quot;your_nebius_token_factory_api_key&quot;</p>
            <p className="text-slate-400">NEBIUS_MODEL=&quot;nvidia/Llama-3.1-Nemotron-70B-Instruct-HF&quot;</p>
            <p className="text-slate-400">NEBIUS_BASE_URL=&quot;https://api.tokenfactory.nebius.com/v1&quot;</p>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <Shield className="w-3.5 h-3.5 text-cyan-400" />
            <span>Credentials are strictly server-only and never exposed to browser bundles or logs.</span>
          </div>
        </div>
      )}

      {/* Main Proposal Generator Form */}
      <div className="p-5 rounded-xl bg-slate-900/90 border border-slate-800 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              Describe Requested Change
            </h3>
          </div>
          <span className="text-[10px] text-slate-400 font-mono">
            AI Proposes → User Inspects → Explicit Approval → Trusted Execution
          </span>
        </div>

        {/* Suggested Prompts */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">
            Quick Demo Prompts:
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {demoPrompts.map((dp, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setPrompt(dp.text)}
                className="p-2.5 rounded-lg bg-slate-950/80 hover:bg-slate-800/80 border border-slate-850 hover:border-cyan-500/40 text-left transition text-xs font-sans group"
              >
                <div className="font-semibold text-slate-200 group-hover:text-cyan-300 font-mono text-[11px]">
                  {dp.title}
                </div>
                <div className="text-[10px] text-slate-400 line-clamp-2 mt-0.5">
                  {dp.text}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Text Area */}
        <div>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Update agent-workflow.json to add a telemetry retry guard and configure maxRetryAttempts to 5..."
            className="w-full p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 text-xs font-mono focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Action Button */}
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-slate-400 font-sans">
            AI changes are strictly isolated to allowlisted files with automatic pre-recovery snapshots.
          </div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 text-xs font-bold shadow-md shadow-cyan-500/20 transition disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isGenerating ? "Consulting NVIDIA Model..." : "Generate AI Proposal"}</span>
          </button>
        </div>

        {/* Generation Error */}
        {generationError && (
          <div className="p-3.5 rounded-lg bg-rose-950/40 border border-rose-800 text-xs text-rose-300 flex items-start gap-2.5">
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-rose-200">Model Request Failed</span>
                {errorDetails?.category && (
                  <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-rose-900/80 text-rose-300 border border-rose-700">
                    {errorDetails.category.replace(/_/g, " ")}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-rose-300 font-sans leading-relaxed">
                {generationError}
              </p>
              {errorDetails?.suggestion && (
                <div className="p-2 rounded bg-rose-900/30 border border-rose-800/60 text-[11px] text-rose-200 font-sans">
                  <span className="font-bold font-mono text-[10px] uppercase block text-cyan-300 mb-0.5">Recommendation:</span>
                  {errorDetails.suggestion}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Proposal Review Card */}
      {proposal && (
        <div className="p-5 rounded-xl bg-slate-900/90 border border-cyan-500/40 shadow-2xl space-y-4 animate-in fade-in duration-200">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-cyan-400" />
              <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                Proposal Preview ({proposal.id})
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                Model: {proposal.model}
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                  proposal.expectedValidationResult === "pass"
                    ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                    : "bg-rose-950 text-rose-400 border-rose-800"
                }`}
              >
                Expected: {proposal.expectedValidationResult.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Proposal Summary & Reasoning */}
          <div className="space-y-2 font-sans text-xs">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono block">
                Summary:
              </span>
              <p className="text-slate-100 font-semibold">{proposal.summary}</p>
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono block">
                Reasoning:
              </span>
              <p className="text-slate-300 leading-relaxed">{proposal.reasoning}</p>
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono block">
                Risk Analysis:
              </span>
              <p className="text-amber-300/90">{proposal.potentialRisks}</p>
            </div>
          </div>

          {/* Proposed Modifications List */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              Proposed File Changes ({proposal.modifications.length} files):
            </div>
            <div className="space-y-2">
              {proposal.modifications.map((mod, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2"
                >
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                      <span className="font-bold text-slate-200">{mod.path}</span>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 uppercase font-mono">
                      {mod.operation}
                    </span>
                  </div>
                  {mod.explanation && (
                    <p className="text-[11px] text-slate-400 font-sans">{mod.explanation}</p>
                  )}
                  <div className="max-h-40 overflow-auto p-2 bg-slate-900/60 rounded text-[11px] text-slate-300 font-mono whitespace-pre">
                    {mod.replacementContent}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Explicit User Approval Actions */}
          <div className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <Shield className="w-3.5 h-3.5 text-cyan-400" />
              <span>Safety checkpoint snapshot will be captured before applying.</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setProposal(null)}
                disabled={isApplying}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition"
              >
                Discard Proposal
              </button>
              <button
                onClick={handleApply}
                disabled={isApplying}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold shadow-md shadow-emerald-500/20 transition disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{isApplying ? "Applying & Validating..." : "Approve & Apply Changes"}</span>
              </button>
            </div>
          </div>

          {applyError && (
            <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-xs text-rose-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Application Refused:</span>
                <p className="text-[11px] text-rose-400 font-sans">{applyError}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Applied Proposal Execution Result */}
      {applyResult && (
        <div
          className={`p-5 rounded-xl border shadow-xl space-y-4 animate-in fade-in duration-200 ${
            applyResult.success
              ? "bg-slate-900/90 border-emerald-500/40"
              : "bg-slate-900/90 border-rose-500/40"
          }`}
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              {applyResult.success ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-rose-400" />
              )}
              <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                {applyResult.success
                  ? "Changes Applied & Invariants Verified"
                  : "Changes Applied — Invariants Failed"}
              </h3>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
              Pre-Snapshot: {applyResult.snapshotBeforeId.slice(0, 16)}...
            </span>
          </div>

          <p className="text-xs text-slate-300 font-sans">{applyResult.message}</p>

          {/* Diffs of applied changes */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              Applied Diffs:
            </div>
            {applyResult.appliedChanges.map((change, idx) => (
              <div key={idx} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px]">
                <div className="text-cyan-300 font-semibold mb-1">{change.path}</div>
                <div className="max-h-36 overflow-auto whitespace-pre text-slate-400">
                  {change.diff}
                </div>
              </div>
            ))}
          </div>

          {/* Deterministic Validation Results */}
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5 text-xs">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono">
              Post-Execution Validation:
            </div>
            {applyResult.validationResult.checks.map((chk, idx) => (
              <div key={idx} className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300">{chk.name}</span>
                <span
                  className={`font-bold ${
                    chk.status === "pass" ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {chk.status.toUpperCase()}
                </span>
              </div>
            ))}
          </div>

          {/* Rollback Action if validation failed */}
          {!applyResult.success && (
            <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800 flex items-center justify-between gap-3">
              <div className="text-[11px] text-rose-300 font-sans">
                Post-execution invariant checks failed. Revert immediately to the pre-change recovery snapshot.
              </div>
              <button
                onClick={() => onRestoreSnapshot(applyResult.snapshotBeforeId)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 text-xs font-bold transition shrink-0"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Rollback to Baseline</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

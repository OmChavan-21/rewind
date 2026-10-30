"use client";

import React, { useState, useEffect } from "react";
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
  Zap,
  Cpu,
  Coins,
  Clock,
  MessageSquare,
  Plus,
  Brain,
  Layers,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type {
  AIStatus,
  AIChangeProposal,
  ApplyProposalResult,
} from "@/types/ai";
import type { ChatSession, ChatMessage } from "@/types/chat";
import type { ProjectMemory } from "@/types/memory";

interface AIAssistantPanelProps {
  aiStatus: AIStatus | null;
  projectId?: string;
  onRefreshStatus: () => Promise<void>;
  onProposalApplied: () => Promise<void>;
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

interface ProposalErrorDetails {
  message: string;
  category?: string;
  suggestion?: string;
}

interface AvailableModelItem {
  id: string;
  name: string;
  tier: string;
  capabilities?: {
    codeGeneration: number;
    instructionFollowing: number;
    securityAwareness: number;
    maxContextTokens: number;
    reasoningSupport: boolean;
  };
  pricing?: {
    isVerified: boolean;
    costStatus: string;
    promptTokenCostUSD: number;
    completionTokenCostUSD: number;
    source?: string;
  } | null;
}

const FALLBACK_NVIDIA_MODELS: AvailableModelItem[] = [
  {
    id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    name: "Nemotron 3 Nano (Nebius)",
    tier: "economy",
    capabilities: {
      codeGeneration: 8,
      instructionFollowing: 9,
      securityAwareness: 8,
      maxContextTokens: 65536,
      reasoningSupport: false,
    },
    pricing: {
      isVerified: true,
      costStatus: "confirmed",
      promptTokenCostUSD: 0.00000015,
      completionTokenCostUSD: 0.00000045,
    },
  },
  {
    id: "nvidia/Nemotron-3_5-Lightning",
    name: "Nemotron 3.5 Lightning (Nebius)",
    tier: "economy",
    capabilities: {
      codeGeneration: 8.5,
      instructionFollowing: 9,
      securityAwareness: 8,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      isVerified: true,
      costStatus: "confirmed",
      promptTokenCostUSD: 0.0000002,
      completionTokenCostUSD: 0.0000006,
    },
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super (120B)",
    tier: "reasoning",
    capabilities: {
      codeGeneration: 9,
      instructionFollowing: 9,
      securityAwareness: 9,
      maxContextTokens: 131072,
      reasoningSupport: true,
    },
    pricing: {
      isVerified: false,
      costStatus: "estimated",
      promptTokenCostUSD: 0.0000008,
      completionTokenCostUSD: 0.0000008,
    },
  },
  {
    id: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
    name: "Llama 3.1 Nemotron (70B)",
    tier: "standard",
    capabilities: {
      codeGeneration: 8,
      instructionFollowing: 8,
      securityAwareness: 8,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      isVerified: false,
      costStatus: "estimated",
      promptTokenCostUSD: 0.0000005,
      completionTokenCostUSD: 0.0000005,
    },
  },
];

export function AIAssistantPanel({
  aiStatus,
  projectId = "demo-workspace",
  onRefreshStatus,
  onProposalApplied,
  onRestoreSnapshot,
}: AIAssistantPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [selectedModel, setSelectedModel] = useState<string>("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
  const [availableModels, setAvailableModels] = useState<AvailableModelItem[]>(FALLBACK_NVIDIA_MODELS);
  const [creditAllowance, setCreditAllowance] = useState<{
    totalAllowance: number;
    remainingCredits: number;
    usedCredits: number;
  } | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [proposal, setProposal] = useState<AIChangeProposal | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<ProposalErrorDetails | null>(null);
  const [isBudgetExceeded, setIsBudgetExceeded] = useState(false);

  const [isApplying, setIsApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyProposalResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const isConnected = aiStatus?.state === "connected";
  const isUnconfigured = aiStatus?.state === "unconfigured" || !aiStatus;
  const providerName =
    aiStatus?.provider === "nvidia"
      ? "NVIDIA API (integrate.api.nvidia.com)"
      : "Nebius Token Factory";

  // Fetch initial models & credit allowance from /api/ai/status
  useEffect(() => {
    let isMounted = true;
    async function loadStatusDetails() {
      try {
        const res = await fetch(`/api/ai/status?projectId=${encodeURIComponent(projectId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!isMounted) return;
        if (Array.isArray(data.availableModels) && data.availableModels.length > 0) {
          setAvailableModels(data.availableModels);
          const defaultModel = data.availableModels.find(
            (m: AvailableModelItem & { isDefault?: boolean }) => m.isDefault
          );
          const preferredId = defaultModel?.id || data.availableModels[0]?.id;
          if (preferredId) {
            setSelectedModel((prev) =>
              data.availableModels.some((m: AvailableModelItem) => m.id === prev)
                ? prev
                : preferredId
            );
          }
        }
        if (data.creditAllowance) {
          setCreditAllowance({
            totalAllowance: data.creditAllowance.totalAllowance,
            remainingCredits: data.creditAllowance.remainingCredits,
            usedCredits: data.creditAllowance.usedCredits,
          });
        }
      } catch {
        // Fallbacks remain active
      }
    }
    loadStatusDetails();
    return () => {
      isMounted = false;
    };
  }, [projectId]);

  // Project-Scoped Chat & Memory Membrane State
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [projectMemories, setProjectMemories] = useState<ProjectMemory[]>([]);
  const [showMemories, setShowMemories] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  // Load project-scoped chat sessions and memory membrane
  useEffect(() => {
    let isMounted = true;
    async function fetchProjectChat() {
      try {
        const [sessRes, memRes] = await Promise.all([
          fetch(`/api/chat/sessions?projectId=${encodeURIComponent(projectId)}`),
          fetch(`/api/projects/${encodeURIComponent(projectId)}/memories`),
        ]);

        if (sessRes.ok) {
          const sessData = await sessRes.json();
          const sessList: ChatSession[] = sessData.sessions || [];
          if (!isMounted) return;
          setSessions(sessList);
          if (sessList.length > 0) {
            setActiveSessionId((prev) => (sessList.some((s) => s.id === prev) ? prev : sessList[0].id));
          } else {
            const createRes = await fetch("/api/chat/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, title: "Initial Project Chat" }),
            });
            if (createRes.ok && isMounted) {
              const createData = await createRes.json();
              if (createData.session) {
                setSessions([createData.session]);
                setActiveSessionId(createData.session.id);
              }
            }
          }
        }

        if (memRes.ok && isMounted) {
          const memData = await memRes.json();
          setProjectMemories(memData.memories || []);
        }
      } catch {
        // Non-fatal
      }
    }
    fetchProjectChat();
    return () => {
      isMounted = false;
    };
  }, [projectId]);

  // Load messages whenever activeSessionId changes
  useEffect(() => {
    let isMounted = true;
    async function loadMessages() {
      if (!activeSessionId) {
        if (isMounted) {
          setSessionMessages([]);
        }
        return;
      }
      try {
        const res = await fetch(
          `/api/chat/sessions/${encodeURIComponent(activeSessionId)}?projectId=${encodeURIComponent(projectId)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (isMounted) {
          setSessionMessages(data.messages || []);
        }
      } catch {
        // Non-fatal
      }
    }
    loadMessages();
    return () => {
      isMounted = false;
    };
  }, [activeSessionId, projectId]);

  const handleCreateSession = async () => {
    setIsCreatingSession(true);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: `Project Chat ${sessions.length + 1}`,
          routingMode: mode,
        }),
      });
      if (!res.ok) throw new Error("Failed to create session");
      const data = await res.json();
      if (data.session) {
        setSessions((prev) => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setSessionMessages([]);
        setProposal(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsCreatingSession(false);
    }
  };

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
    setIsBudgetExceeded(false);
    setProposal(null);
    setApplyResult(null);
    setApplyError(null);

    try {
      const res = await fetch("/api/ai/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          mode,
          selectedModel: mode === "manual" ? selectedModel : undefined,
          projectId,
          sessionId: activeSessionId || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429 || data.budgetExceeded) {
          setIsBudgetExceeded(true);
        }
        setErrorDetails({
          message: data.error || "Failed to generate proposal",
          category: data.category,
          suggestion: data.suggestion,
        });
        throw new Error(data.error || "Failed to generate proposal");
      }

      setProposal(data.proposal);
      if (data.creditAllowance) {
        setCreditAllowance(data.creditAllowance);
      }

      // Reload chat session messages and memory membrane
      if (activeSessionId) {
        try {
          const msgRes = await fetch(
            `/api/chat/sessions/${encodeURIComponent(activeSessionId)}?projectId=${encodeURIComponent(projectId)}`
          );
          if (msgRes.ok) {
            const msgData = await msgRes.json();
            setSessionMessages(msgData.messages || []);
          }
        } catch {
          // Non-fatal
        }
      }
      try {
        const memRes = await fetch(`/api/projects/${encodeURIComponent(projectId)}/memories`);
        if (memRes.ok) {
          const memData = await memRes.json();
          setProjectMemories(memData.memories || []);
        }
      } catch {
        // Non-fatal
      }
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
          projectId,
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
      {/* Top Banner: Model Status, Provider Details & Credit Allowance */}
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
              Active Provider: <code className="text-cyan-300 font-semibold">{aiStatus?.provider || "nvidia"}</code> (developer eval tier)
            </p>
            {aiStatus?.message && !isConnected && (
              <p className="text-[10px] text-rose-300 font-sans mt-0.5">
                {aiStatus.message}
              </p>
            )}
          </div>
        </div>

        {/* Free Allowance Badge & Action */}
        <div className="flex items-center gap-3 self-end md:self-auto flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
            <Coins className="w-4 h-4 text-amber-400" />
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 font-sans leading-none">Free Allowance:</span>
              <span className="font-bold font-mono">
                <span className={creditAllowance && creditAllowance.remainingCredits <= 5 ? "text-rose-400" : "text-emerald-400"}>
                  {creditAllowance ? creditAllowance.remainingCredits : 100}
                </span>
                <span className="text-slate-500 font-normal"> / {creditAllowance ? creditAllowance.totalAllowance : 100} credits</span>
              </span>
            </div>
          </div>

          <button
            onClick={onRefreshStatus}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 border border-slate-700 transition shrink-0"
          >
            Check API Status
          </button>
        </div>
      </div>

      {/* Unconfigured Setup Instructions Banner */}
      {isUnconfigured && (
        <div className="p-5 rounded-xl bg-slate-900/90 border border-amber-800/80 shadow-xl space-y-3 font-sans">
          <div className="flex items-center gap-2 font-mono">
            <Key className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs font-bold text-amber-300 uppercase tracking-wider">
              Setup Guide: Connect NVIDIA API
            </h3>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Rewind uses real open-weights models served through NVIDIA API. To enable autonomous AI change proposals, configure your credentials in <code className="text-cyan-300 font-mono">.env.local</code>:
          </p>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 space-y-1">
            <p className="text-slate-400"># In .env.local (server-side only, ignored by git):</p>
            <p className="text-emerald-400">NVIDIA_API_KEY=&quot;nvapi-your_api_key&quot;</p>
            <p className="text-slate-400">NVIDIA_MODEL=&quot;nvidia/nemotron-3.5-lightning-30b-a3b&quot;</p>
            <p className="text-slate-400">NVIDIA_BASE_URL=&quot;https://integrate.api.nvidia.com/v1&quot;</p>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <Shield className="w-3.5 h-3.5 text-cyan-400" />
            <span>Credentials are strictly server-only and never exposed to browser bundles or logs.</span>
          </div>
        </div>
      )}

      {/* Project Chat Continuity & Memory Membrane Header */}
      <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 shadow-lg space-y-3 font-sans">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Active Project & Session Selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-xs font-mono">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-slate-400 text-[10px]">Project:</span>
              <span className="text-white font-bold">{projectId}</span>
            </div>

            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              <MessageSquare className="w-3.5 h-3.5 text-slate-400 ml-1.5" />
              <select
                value={activeSessionId || ""}
                onChange={(e) => setActiveSessionId(e.target.value)}
                className="bg-transparent text-slate-200 text-xs font-mono font-medium focus:outline-none pr-2 py-0.5"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-900 text-slate-200">
                    {s.title} ({s.messageCount} msgs)
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleCreateSession}
                disabled={isCreatingSession}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-cyan-300 font-mono transition"
                title="Create New Project Chat Session"
              >
                <Plus className="w-3 h-3" />
                <span>New Session</span>
              </button>
            </div>
          </div>

          {/* Memory Membrane Badge & Drawer Toggle */}
          <button
            type="button"
            onClick={() => setShowMemories((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono transition ${
              showMemories
                ? "bg-purple-950/80 border-purple-500/50 text-purple-300"
                : "bg-slate-950 border-slate-800 text-slate-300 hover:border-purple-500/30 hover:text-purple-300"
            }`}
          >
            <Brain className="w-4 h-4 text-purple-400" />
            <span>Memory Membrane ({projectMemories.length})</span>
            {showMemories ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Memory Membrane Drawer */}
        {showMemories && (
          <div className="p-3.5 rounded-lg bg-slate-950 border border-purple-900/40 space-y-2.5 font-mono text-xs animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-1.5 border-b border-slate-800">
              <span className="text-[11px] font-bold text-purple-300 uppercase tracking-wider flex items-center gap-1.5">
                <Brain className="w-3.5 h-3.5 text-purple-400" />
                Project Developer Long-Term Memory (Membrane)
              </span>
              <span className="text-[10px] text-slate-500 font-sans">
                Distilled from project chats • Injected into LLM context
              </span>
            </div>

            {projectMemories.length === 0 ? (
              <p className="text-[11px] text-slate-400 font-sans italic py-1">
                No memories distilled yet. When you chat about project goals, architectural choices, or safety constraints, the engine will automatically distill them into this membrane.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {projectMemories.map((mem) => (
                  <div
                    key={mem.id}
                    className="p-2 rounded bg-slate-900/80 border border-slate-800/80 flex items-start justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                            mem.category === "technical_constraint"
                              ? "bg-rose-950 text-rose-300 border border-rose-800"
                              : mem.category === "architectural_decision"
                              ? "bg-cyan-950 text-cyan-300 border border-cyan-800"
                              : mem.category === "project_intent"
                              ? "bg-purple-950 text-purple-300 border border-purple-800"
                              : "bg-emerald-950 text-emerald-300 border border-emerald-800"
                          }`}
                        >
                          {mem.category.replace("_", " ")}
                        </span>
                        <span className="text-white font-semibold text-[11px]">{mem.title}</span>
                      </div>
                      <p className="text-[11px] text-slate-300 font-sans leading-relaxed">{mem.distilledIntent}</p>
                    </div>
                    <span className="text-[10px] text-slate-500 shrink-0 font-mono">P{mem.importance}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Existing Session Messages Stream */}
        {sessionMessages.length > 0 && (
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2 max-h-56 overflow-y-auto">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 font-mono">
              Session History ({sessionMessages.length} turns)
            </div>
            {sessionMessages.map((msg) => (
              <div
                key={msg.id}
                className={`p-2.5 rounded-lg text-xs font-mono space-y-1 ${
                  msg.role === "user"
                    ? "bg-slate-900 border border-slate-800 text-slate-200"
                    : "bg-cyan-950/30 border border-cyan-900/40 text-cyan-200"
                }`}
              >
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span className="font-bold uppercase tracking-wider text-slate-300">
                    {msg.role === "user" ? "User" : "Project Developer (AI)"}
                  </span>
                  <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="font-sans text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                {msg.proposalId && (
                  <div className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Generated Proposal: {msg.proposalId.slice(0, 16)}...</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Main Proposal Generator Form */}
      <div className="p-5 rounded-xl bg-slate-900/90 border border-slate-800 shadow-xl space-y-4">
        {/* Router Mode Switch & Title */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
              Describe Requested Change
            </h3>
          </div>

          {/* Mode Selector Tabs */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => setMode("auto")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono font-bold transition ${
                mode === "auto"
                  ? "bg-cyan-500 text-slate-950 shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Auto Router</span>
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono font-bold transition ${
                mode === "manual"
                  ? "bg-cyan-500 text-slate-950 shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Manual Model</span>
            </button>
          </div>
        </div>

        {/* Mode Explanation & Model Selection Controls */}
        {mode === "auto" ? (
          <div className="p-3 rounded-lg bg-slate-950/80 border border-cyan-900/40 text-xs text-slate-300 flex items-start gap-2.5">
            <Zap className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-cyan-300 font-mono text-[11px]">
                Deterministic Auto Router Active:
              </span>
              <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                Classifies task complexity and risk deterministically. Automatically selects the least expensive suitable model in the active provider catalog, scaling up to high-capability reasoning models for security-critical tasks.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-slate-300 font-mono uppercase tracking-wider flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                Select Provider Model:
              </label>
              <span className="text-[10px] text-slate-400 font-mono">
                Provider: {aiStatus?.provider || "nvidia"}
              </span>
            </div>

            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full p-2.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 text-xs font-mono focus:outline-none focus:border-cyan-500"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} [{m.tier.toUpperCase()}] — {m.id}
                </option>
              ))}
            </select>

            {/* Display capability pill for chosen model */}
            {(() => {
              const current = availableModels.find((m) => m.id === selectedModel);
              if (!current || !current.capabilities) return null;
              return (
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono flex-wrap">
                  <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">
                    Tier: <strong className="text-cyan-300 uppercase">{current.tier}</strong>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">
                    Code Gen: <strong className="text-slate-200">{current.capabilities.codeGeneration}/10</strong>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">
                    Security: <strong className="text-slate-200">{current.capabilities.securityAwareness}/10</strong>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">
                    Context: <strong className="text-slate-200">{(current.capabilities.maxContextTokens / 1024).toFixed(0)}k</strong>
                  </span>
                  {current.capabilities.reasoningSupport && (
                    <span className="px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 font-bold">
                      Reasoning Enabled
                    </span>
                  )}
                </div>
              );
            })()}

            <p className="text-[10px] text-slate-400 font-sans">
              Auto Router honors your explicit selection. If the task risk exceeds model capabilities, clear warnings will be reported without blocking your execution choice.
            </p>
          </div>
        )}

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

        {/* Action Button & Security Notice */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-[11px] text-slate-400 font-sans">
            AI changes are strictly isolated to allowlisted files with automatic pre-recovery snapshots.
          </div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim() || isBudgetExceeded}
            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 text-xs font-bold shadow-md shadow-cyan-500/20 transition disabled:opacity-50 shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isGenerating ? "Routing & Consulting Model..." : "Generate AI Proposal"}</span>
          </button>
        </div>

        {/* Budget Exceeded Alert */}
        {isBudgetExceeded && (
          <div className="p-3.5 rounded-lg bg-amber-950/50 border border-amber-800 text-xs text-amber-200 flex items-start gap-2.5 animate-in fade-in">
            <Coins className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-amber-300 font-mono uppercase text-[11px] block">
                Free Credit Allowance Exhausted
              </span>
              <p className="text-[11px] text-amber-200 font-sans leading-relaxed">
                This project has used its allocated free testing allowance. To protect against unbounded usage during evaluation, requests are blocked. Allowance resets per project workspace.
              </p>
            </div>
          </div>
        )}

        {/* Generation Error */}
        {generationError && !isBudgetExceeded && (
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
            <div className="flex items-center gap-2 flex-wrap">
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

          {/* Routing Decision & Task Classification Metadata */}
          {proposal.routingMeta && (
            <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-3 font-mono text-xs">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 uppercase font-bold">
                    {proposal.routingMeta.routing.mode === "auto" ? "⚡ Auto Routed" : "⚙️ Manual Mode"}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                    Complexity: <strong className="text-cyan-300">{proposal.routingMeta.routing.taskClassification.complexity}</strong>
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded border uppercase font-bold ${
                      proposal.routingMeta.routing.taskClassification.riskLevel === "high"
                        ? "bg-rose-950 text-rose-400 border-rose-800"
                        : proposal.routingMeta.routing.taskClassification.riskLevel === "medium"
                        ? "bg-amber-950 text-amber-400 border-amber-800"
                        : "bg-emerald-950 text-emerald-400 border-emerald-800"
                    }`}
                  >
                    Risk: {proposal.routingMeta.routing.taskClassification.riskLevel}
                  </span>
                </div>

                {proposal.routingMeta.routing.taskClassification.targetPaths.length > 0 && (
                  <span className="text-[10px] text-slate-400">
                    Targets: <code className="text-slate-300">{proposal.routingMeta.routing.taskClassification.targetPaths.join(", ")}</code>
                  </span>
                )}
              </div>

              {/* Routing Rationale */}
              <div className="p-2 rounded bg-slate-900/60 border border-slate-850 text-[11px] text-slate-300 font-sans">
                <span className="font-bold font-mono text-[10px] uppercase text-cyan-400 mr-1.5">
                  Routing Rationale:
                </span>
                {proposal.routingMeta.routing.routingReason}
              </div>

              {/* Manual Selection Warnings */}
              {proposal.routingMeta.routing.warnings && proposal.routingMeta.routing.warnings.length > 0 && (
                <div className="p-2.5 rounded bg-amber-950/40 border border-amber-800/80 text-[11px] text-amber-300 space-y-1">
                  <div className="font-bold text-[10px] uppercase text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Capability Warning:
                  </div>
                  {proposal.routingMeta.routing.warnings.map((w, idx) => (
                    <p key={idx} className="font-sans leading-relaxed">{w}</p>
                  ))}
                </div>
              )}

              {/* Dual Independent Accounting Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-850">
                {/* 1. AI Provider Cost */}
                <div className="p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Provider API Cost</span>
                    <span
                      className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                        proposal.routingMeta.costMetrics.costStatus === "confirmed"
                          ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                          : proposal.routingMeta.costMetrics.costStatus === "estimated"
                          ? "bg-amber-950 text-amber-400 border border-amber-800"
                          : "bg-slate-800 text-slate-400 border border-slate-700"
                      }`}
                    >
                      {proposal.routingMeta.costMetrics.costStatus}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-white">
                    {proposal.routingMeta.costMetrics.providerCostUSD !== null
                      ? `$${proposal.routingMeta.costMetrics.providerCostUSD.toFixed(6)} USD`
                      : "Unavailable"}
                  </div>
                  <div className="text-[10px] text-slate-400 font-sans">
                    {proposal.routingMeta.costMetrics.costStatus === "estimated"
                      ? "NVIDIA developer eval rate — not commercial charge"
                      : "Tracked from provider usage metrics"}
                  </div>
                </div>

                {/* 2. Rewind Credits (Internal Allowance) */}
                <div className="p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Rewind Credits</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 font-bold uppercase">
                      Free Allowance
                    </span>
                  </div>
                  <div className="text-sm font-bold text-emerald-400">
                    -{proposal.routingMeta.accounting.creditsCharged} Credits
                  </div>
                  <div className="text-[10px] text-slate-400 font-sans">
                    {proposal.routingMeta.creditAllowance
                      ? `${proposal.routingMeta.creditAllowance.remainingCredits} credits remaining`
                      : "Single deduction per completed task"}
                  </div>
                </div>

                {/* 3. Latency & Token Usage */}
                <div className="p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1">
                    <Clock className="w-3 h-3 text-cyan-400" />
                    <span>Execution Metrics</span>
                  </div>
                  <div className="text-sm font-bold text-cyan-300">
                    {proposal.routingMeta.latencyMs} ms
                  </div>
                  <div className="text-[10px] text-slate-400 font-sans">
                    {proposal.routingMeta.usage
                      ? `${proposal.routingMeta.usage.promptTokens} in / ${proposal.routingMeta.usage.completionTokens} out (${proposal.routingMeta.usage.totalTokens} total)`
                      : "Token metrics not returned by provider"}
                  </div>
                </div>
              </div>
            </div>
          )}

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

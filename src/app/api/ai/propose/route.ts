import { NextResponse } from "next/server";
import { getContextRoots } from "@/server/workspaceContext";
import { listPermittedWorkspaceFiles, readPermittedTextFile } from "@/engine/recoveryEngine";
import { generateChangeProposalWithMeta, AIError } from "@/server/nebiusService";
import { classifyTask } from "@/server/ai/taskClassifier";
import { routeTask } from "@/server/ai/autoRouter";
import { getActiveProvider } from "@/server/ai/providerRegistry";
import {
  checkBudgetCaps,
  checkAndReserveCredits,
  releaseCreditReservation,
  commitCreditReservation,
  accountTaskExecution,
  getProjectCreditBalance,
  getCreditSchedule,
  BudgetExceededError,
} from "@/server/ai/dualAccounting";
import { SecurityError } from "@/security/boundaries";
import type { AIProposalRoutingMeta } from "@/types/router";

export async function POST(request: Request) {
  let reservationId: string | undefined;
  let activeProjectId = "demo-workspace";

  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "Please provide a prompt describing your desired change.", category: "invalid_payload" },
        { status: 400 }
      );
    }

    if (prompt.length > 3000) {
      return NextResponse.json(
        { error: "Prompt exceeds maximum allowed length of 3000 characters.", category: "invalid_payload" },
        { status: 400 }
      );
    }

    const projectIdParam = typeof body.projectId === "string" ? body.projectId.trim() : undefined;
    const { workspaceRoot, storeRoot } = getContextRoots(projectIdParam);
    activeProjectId = projectIdParam || "demo-workspace";

    const permittedFiles = listPermittedWorkspaceFiles(workspaceRoot);

    // Enforce AI context limits (max 20 files, max 200KB total)
    const contextFiles: { path: string; content: string }[] = [];
    let totalBytes = 0;
    const maxFiles = 20;
    const maxBytes = 200 * 1024;

    for (const file of permittedFiles.slice(0, maxFiles)) {
      if (file.path.endsWith(".pdf")) continue; // Skip binary PDFs in code change context
      const content = readPermittedTextFile(workspaceRoot, file.path);
      const byteLen = Buffer.byteLength(content, "utf-8");
      if (totalBytes + byteLen > maxBytes) break;
      contextFiles.push({ path: file.path, content });
      totalBytes += byteLen;
    }

    // 1. Deterministic Task Classification (Zero LLM overhead)
    const classification = classifyTask(prompt, contextFiles);

    // 2. Provider-Aware Task Routing (Auto or Manual)
    const mode = body.mode === "manual" ? "manual" : "auto";
    const selectedModel = typeof body.selectedModel === "string" ? body.selectedModel.trim() : undefined;

    const decision = routeTask(classification, contextFiles, {
      mode,
      selectedModel,
      provider: getActiveProvider(),
    });

    // 3. Dual Accounting & Budget Check
    const requiredCredits = getCreditSchedule()[classification.complexity];

    // Check optional request budget constraints
    checkBudgetCaps(decision, {
      maxCredits: typeof body.maxCredits === "number" ? body.maxCredits : undefined,
      maxCostUSD: typeof body.maxCostUSD === "number" ? body.maxCostUSD : undefined,
    });

    // Concurrency reservation: atomic in-memory reservation prevents concurrent race bypass
    const reservation = checkAndReserveCredits(
      activeProjectId,
      requiredCredits,
      undefined,
      storeRoot
    );
    reservationId = reservation.reservationId;

    // 4. Model Proposal Generation via active provider (NVIDIA)
    let result;
    try {
      result = await generateChangeProposalWithMeta(prompt, contextFiles, {
        model: decision.selectedModel.id,
        provider: decision.selectedProvider,
      });
    } catch (genErr) {
      // Provider error, timeout, or network issue: release reservation so user is NOT charged!
      releaseCreditReservation(reservation.reservationId);
      reservationId = undefined;
      throw genErr;
    }

    // 5. Account Task Execution
    const accountingResult = accountTaskExecution({
      taskId: result.proposal.id,
      complexity: classification.complexity,
      model: decision.selectedModel,
      outcome: "success",
      usage: result.usage,
      estimatedPromptTokens: classification.estimatedPromptTokens,
      projectId: activeProjectId,
      storeRoot,
    });

    // Commit credit deduction to project store
    commitCreditReservation(
      reservation.reservationId,
      activeProjectId,
      result.proposal.id,
      accountingResult.creditAccounting.creditsCharged,
      classification.complexity,
      storeRoot
    );
    reservationId = undefined;

    // 6. Assemble Full Routing & Accounting Metadata
    const creditBalance = getProjectCreditBalance(activeProjectId, storeRoot);

    const routingMeta: AIProposalRoutingMeta = {
      routing: decision,
      costMetrics: accountingResult.providerCost,
      accounting: accountingResult.creditAccounting,
      latencyMs: result.latencyMs,
      usage: result.usage,
      creditAllowance: {
        totalAllowance: creditBalance.allowance,
        remainingCredits: creditBalance.remaining,
        usedCredits: creditBalance.used,
      },
    };

    result.proposal.routingMeta = routingMeta;

    return NextResponse.json({
      proposal: result.proposal,
      routingMeta,
      creditAllowance: routingMeta.creditAllowance,
    });
  } catch (err: unknown) {
    if (reservationId) {
      releaseCreditReservation(reservationId);
    }

    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        {
          error: err.message,
          category: "rate_limit",
          budgetExceeded: true,
          budgetType: err.budgetType,
          requested: err.requested,
          limit: err.limit,
          suggestion: "Free credit allowance exhausted for this project. Free allowance resets per project.",
        },
        { status: 429 }
      );
    }

    if (err instanceof SecurityError) {
      return NextResponse.json(
        { error: err.message, category: "invalid_payload" },
        { status: 403 }
      );
    }

    if (err instanceof AIError) {
      return NextResponse.json(
        {
          error: err.message,
          category: err.category,
          provider: err.provider,
          model: err.model,
          suggestion: err.suggestion,
        },
        { status: err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500 }
      );
    }

    const message = err instanceof Error ? err.message : "Error generating AI proposal";
    return NextResponse.json(
      { error: message, category: "provider_error" },
      { status: 500 }
    );
  }
}

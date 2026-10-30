/**
 * Rewind Dual Accounting Engine
 * Independently tracks:
 * 1. AI Provider Cost ($ USD) - Confirmed only with trustworthy usage and pricing, otherwise estimated/unavailable.
 * 2. Rewind Credits - Free user usage allowance with configurable schedule.
 *
 * Guarantees:
 * - Credits represent a free usage allowance, NOT money or commercial billing.
 * - Single charge per completed task; retries do NOT multiply credit deductions.
 * - Prevents duplicate deductions for the same task execution.
 * - Deterministic, testable, and strictly enforces budgets.
 * - Concurrency control via in-memory reservations + persistent project-level JSON store.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ProviderCostRecord,
  CreditAccountingRecord,
  TaskComplexity,
  ModelMetadata,
  RoutingDecision,
} from "../../types/router";
import type { TokenUsage } from "./providerInterface";
import { atomicWriteFileSync } from "../../engine/storage";
import { getDefaultStoreRoot } from "../../engine/recoveryEngine";

export class BudgetExceededError extends Error {
  readonly budgetType: "credits" | "provider_cost";
  readonly requested: number;
  readonly limit: number;

  constructor(budgetType: "credits" | "provider_cost", requested: number, limit: number) {
    super(
      `Budget exceeded for ${budgetType === "credits" ? "Rewind Credits" : "Provider Cost"}: requested ${requested}, limit is ${limit}.`
    );
    this.name = "BudgetExceededError";
    this.budgetType = budgetType;
    this.requested = requested;
    this.limit = limit;
  }
}

function parseEnvInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
}

/**
 * Configurable credit schedule per task complexity.
 * Values are optional illustrative defaults until commercial credit policy is confirmed.
 */
export function getCreditSchedule(): Record<TaskComplexity, number> {
  return {
    simple_explanation: parseEnvInt(process.env.REWIND_CREDITS_SIMPLE, 1),
    lightweight_analysis: parseEnvInt(process.env.REWIND_CREDITS_LIGHTWEIGHT, 1),
    standard_refactor: parseEnvInt(process.env.REWIND_CREDITS_STANDARD, 2),
    complex_code_modification: parseEnvInt(process.env.REWIND_CREDITS_COMPLEX, 4),
    security_sensitive: parseEnvInt(process.env.REWIND_CREDITS_SECURITY, 5),
  };
}

/**
 * Returns default user credit allowance from environment (e.g., 100 free credits).
 */
export function getDefaultCreditAllowance(): number {
  return parseEnvInt(process.env.REWIND_FREE_CREDIT_ALLOWANCE, 100);
}

// In-memory ledger to prevent duplicate deductions for the exact same task/proposal ID
const taskLedger: Map<
  string,
  {
    providerCost: ProviderCostRecord;
    creditAccounting: CreditAccountingRecord;
    timestamp: string;
  }
> = new Map();

export interface ActiveReservation {
  projectId: string;
  amount: number;
  reservedAt: number;
}

const activeReservations: Map<string, ActiveReservation> = new Map();

export function clearTaskLedger() {
  taskLedger.clear();
  activeReservations.clear();
}

export interface ProjectCreditStoreData {
  projectId: string;
  usedCredits: number;
  tasks: Record<
    string,
    {
      credits: number;
      chargedAt: string;
      complexity: string;
      provider?: string;
      model?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      providerCostUSD?: number | null;
    }
  >;
}

export function summarizeProviderUsage(data: ProjectCreditStoreData) {
  const summary = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  for (const task of Object.values(data.tasks)) {
    if (typeof task.totalTokens !== "number") continue;
    summary.requests += 1;
    summary.promptTokens += task.promptTokens || 0;
    summary.completionTokens += task.completionTokens || 0;
    summary.totalTokens += task.totalTokens;
  }
  return summary;
}

function getCreditStorePath(projectId: string, storeRoot?: string): string {
  const root = storeRoot || getDefaultStoreRoot();
  const creditsDir = path.join(root, "credits");
  if (!fs.existsSync(creditsDir)) {
    try {
      fs.mkdirSync(creditsDir, { recursive: true });
    } catch {
      // directory creation handled or already exists
    }
  }
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(creditsDir, `${safeId}.json`);
}

export function readProjectCreditStore(
  projectId: string = "demo-workspace",
  storeRoot?: string
): ProjectCreditStoreData {
  try {
    const filePath = getCreditStorePath(projectId, storeRoot);
    if (!fs.existsSync(filePath)) {
      return { projectId, usedCredits: 0, tasks: {} };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      projectId,
      usedCredits: typeof parsed.usedCredits === "number" ? parsed.usedCredits : 0,
      tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
    };
  } catch {
    return { projectId, usedCredits: 0, tasks: {} };
  }
}

export function writeProjectCreditStore(
  projectId: string = "demo-workspace",
  data: ProjectCreditStoreData,
  storeRoot?: string
): void {
  try {
    const filePath = getCreditStorePath(projectId, storeRoot);
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[Rewind DualAccounting] Failed to persist credit store for ${projectId}:`, err);
  }
}

/**
 * Returns the current credit balance and in-flight reservations for a project.
 */
export function getProjectCreditBalance(
  projectId: string = "demo-workspace",
  storeRoot?: string
): { allowance: number; used: number; remaining: number; inFlightReserved: number } {
  const allowance = getDefaultCreditAllowance();
  const data = readProjectCreditStore(projectId, storeRoot);

  let inFlightReserved = 0;
  for (const res of activeReservations.values()) {
    if (res.projectId === projectId) {
      inFlightReserved += res.amount;
    }
  }

  const remaining = Math.max(0, allowance - data.usedCredits - inFlightReserved);
  return {
    allowance,
    used: data.usedCredits,
    remaining,
    inFlightReserved,
  };
}

/**
 * Synchronously and atomically checks if a project has sufficient remaining credits,
 * reserving them in memory to prevent concurrent requests from bypassing budget caps.
 */
export function checkAndReserveCredits(
  projectId: string = "demo-workspace",
  requiredCredits: number,
  customAllowance?: number,
  storeRoot?: string
): { reservationId: string; remainingAfterReserve: number } {
  const allowance = customAllowance ?? getDefaultCreditAllowance();
  const data = readProjectCreditStore(projectId, storeRoot);

  let inFlightReserved = 0;
  for (const res of activeReservations.values()) {
    if (res.projectId === projectId) {
      inFlightReserved += res.amount;
    }
  }

  const effectiveAvailable = allowance - data.usedCredits - inFlightReserved;
  if (effectiveAvailable < requiredCredits) {
    throw new BudgetExceededError("credits", requiredCredits, Math.max(0, effectiveAvailable));
  }

  const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  activeReservations.set(reservationId, {
    projectId,
    amount: requiredCredits,
    reservedAt: Date.now(),
  });

  return {
    reservationId,
    remainingAfterReserve: effectiveAvailable - requiredCredits,
  };
}

/**
 * Releases an in-flight credit reservation without deducting credits (e.g. on provider error or timeout).
 */
export function releaseCreditReservation(reservationId: string): void {
  activeReservations.delete(reservationId);
}

/**
 * Commits an in-flight credit reservation upon successful task completion.
 * Updates the persistent project credit ledger and releases the reservation.
 */
export function commitCreditReservation(
  reservationId: string,
  projectId: string = "demo-workspace",
  taskId: string,
  actualCreditsCharged: number,
  complexity: string,
  storeRoot?: string
): { totalUsed: number; remaining: number } {
  activeReservations.delete(reservationId);

  const data = readProjectCreditStore(projectId, storeRoot);
  if (!data.tasks[taskId]) {
    data.usedCredits += actualCreditsCharged;
    data.tasks[taskId] = {
      credits: actualCreditsCharged,
      chargedAt: new Date().toISOString(),
      complexity,
    };
    writeProjectCreditStore(projectId, data, storeRoot);
  }

  const allowance = getDefaultCreditAllowance();
  return {
    totalUsed: data.usedCredits,
    remaining: Math.max(0, allowance - data.usedCredits),
  };
}

/**
 * Resets the credit store for a project (useful in tests).
 */
export function resetProjectCreditStore(projectId?: string, storeRoot?: string): void {
  activeReservations.clear();
  taskLedger.clear();
  if (projectId) {
    try {
      const filePath = getCreditStorePath(projectId, storeRoot);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Estimates AI Provider Cost ($ USD) from provider-reported usage and published rates.
 * This is not a provider invoice or account-balance query.
 */
export function calculateProviderCost(
  model: ModelMetadata,
  usage?: TokenUsage,
  estimatedPromptTokens: number = 0
): ProviderCostRecord {
  // If model has no pricing metadata, cost is completely unavailable
  if (!model.pricing) {
    return {
      providerCostUSD: null,
      costStatus: "unavailable",
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
    };
  }

  const { promptTokenCostUSD, completionTokenCostUSD, source, verifiedAt } =
    model.pricing;

  // Case 1: Trustworthy actual usage returned from provider
  if (usage && typeof usage.promptTokens === "number" && typeof usage.completionTokens === "number") {
    const rawCost =
      usage.promptTokens * promptTokenCostUSD + usage.completionTokens * completionTokenCostUSD;
    const roundedCost = Number(rawCost.toFixed(6));

    return {
      providerCostUSD: roundedCost,
      // Token usage is real, but the final provider invoice is not fetched by this app.
      // Keep the amount labelled estimated even when the published rate is verified.
      costStatus: "estimated",
      pricingSource: source,
      pricingVerifiedAt: verifiedAt,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    };
  }

  // Case 2: Usage unavailable, calculated as estimate from estimated prompt tokens + default completion
  if (estimatedPromptTokens > 0) {
    const estimatedCompletion = 500;
    const rawCost =
      estimatedPromptTokens * promptTokenCostUSD + estimatedCompletion * completionTokenCostUSD;
    const roundedCost = Number(rawCost.toFixed(6));

    return {
      providerCostUSD: roundedCost,
      costStatus: "estimated",
      pricingSource: source,
      pricingVerifiedAt: verifiedAt,
      promptTokens: estimatedPromptTokens,
      completionTokens: estimatedCompletion,
      totalTokens: estimatedPromptTokens + estimatedCompletion,
    };
  }

  return {
    providerCostUSD: null,
    costStatus: "unavailable",
    pricingSource: source,
    pricingVerifiedAt: verifiedAt,
  };
}

export type TaskOutcome =
  | "success"
  | "provider_error"
  | "timeout"
  | "validation_failed"
  | "cancelled";

export interface AccountTaskOptions {
  taskId: string;
  complexity: TaskComplexity;
  model: ModelMetadata;
  outcome: TaskOutcome;
  usage?: TokenUsage;
  estimatedPromptTokens?: number;
  retries?: number;
  projectId?: string;
  storeRoot?: string;
  budgetConstraints?: {
    maxCostUSD?: number;
    maxCredits?: number;
  };
}

export interface AccountingResult {
  providerCost: ProviderCostRecord;
  creditAccounting: CreditAccountingRecord;
  isDuplicate: boolean;
}

/**
 * Validates budget caps before executing a task.
 */
export function checkBudgetCaps(
  decision: RoutingDecision,
  budgetConstraints?: { maxCostUSD?: number; maxCredits?: number }
) {
  if (!budgetConstraints) return;

  const schedule = getCreditSchedule();
  const requiredCredits = schedule[decision.taskClassification.complexity];

  if (
    budgetConstraints.maxCredits !== undefined &&
    requiredCredits > budgetConstraints.maxCredits
  ) {
    throw new BudgetExceededError("credits", requiredCredits, budgetConstraints.maxCredits);
  }

  if (budgetConstraints.maxCostUSD !== undefined && decision.selectedModel.pricing) {
    const estimatedCost =
      decision.taskClassification.estimatedPromptTokens *
        decision.selectedModel.pricing.promptTokenCostUSD +
      500 * decision.selectedModel.pricing.completionTokenCostUSD;

    if (estimatedCost > budgetConstraints.maxCostUSD) {
      throw new BudgetExceededError(
        "provider_cost",
        Number(estimatedCost.toFixed(6)),
        budgetConstraints.maxCostUSD
      );
    }
  }
}

/**
 * Accounts for a task execution across both provider cost and Rewind credits.
 */
export function accountTaskExecution(options: AccountTaskOptions): AccountingResult {
  const {
    taskId,
    complexity,
    model,
    outcome,
    usage,
    estimatedPromptTokens,
    retries = 0,
    projectId,
    storeRoot,
  } = options;

  // Deduplication check: Avoid duplicate charges for the exact same task ID
  if (taskLedger.has(taskId)) {
    const existing = taskLedger.get(taskId)!;
    return {
      providerCost: existing.providerCost,
      creditAccounting: existing.creditAccounting,
      isDuplicate: true,
    };
  }

  // 1. Provider Cost Calculation
  const providerCost = calculateProviderCost(model, usage, estimatedPromptTokens);

  // 2. Rewind Credit Accounting
  const schedule = getCreditSchedule();
  let creditsCharged = 0;
  let creditPolicy = "Free user usage allowance";

  if (outcome === "success" || outcome === "validation_failed") {
    // Single charge per completed task; retries do NOT multiply deductions
    creditsCharged = schedule[complexity];
    creditPolicy = `Charged per completed task: ${creditsCharged} credits (${complexity}). Internal retries (${retries}) not charged.`;
  } else if (outcome === "provider_error" || outcome === "timeout" || outcome === "cancelled") {
    // Zero credits charged on provider error or timeout
    creditsCharged = 0;
    creditPolicy = `No credits charged due to task failure (${outcome}).`;
  }

  const creditAccounting: CreditAccountingRecord = {
    creditsCharged,
    creditPolicy,
    isFreeAllowance: true,
    unchargedRetries: retries,
  };

  // Record in memory ledger
  taskLedger.set(taskId, {
    providerCost,
    creditAccounting,
    timestamp: new Date().toISOString(),
  });

  // If projectId is provided and this was a billable outcome, record in persistent project store if not already there
  if (projectId && creditsCharged > 0) {
    try {
      const data = readProjectCreditStore(projectId, storeRoot);
      if (!data.tasks[taskId]) {
        data.usedCredits += creditsCharged;
        data.tasks[taskId] = {
          credits: creditsCharged,
          chargedAt: new Date().toISOString(),
          complexity,
          provider: model.provider,
          model: model.id,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          providerCostUSD: providerCost.providerCostUSD,
        };
        writeProjectCreditStore(projectId, data, storeRoot);
      }
    } catch {
      // non-fatal if store persistence fails
    }
  }

  return {
    providerCost,
    creditAccounting,
    isDuplicate: false,
  };
}

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
 */

import type {
  ProviderCostRecord,
  CreditAccountingRecord,
  TaskComplexity,
  ModelMetadata,
  RoutingDecision,
} from "../../types/router";
import type { TokenUsage } from "./providerInterface";

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

export function clearTaskLedger() {
  taskLedger.clear();
}

/**
 * Computes AI Provider Cost ($ USD) based on actual usage and verified pricing.
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

  const { promptTokenCostUSD, completionTokenCostUSD, isVerified, source, verifiedAt } =
    model.pricing;

  // Case 1: Trustworthy actual usage returned from provider
  if (usage && typeof usage.promptTokens === "number" && typeof usage.completionTokens === "number") {
    const rawCost =
      usage.promptTokens * promptTokenCostUSD + usage.completionTokens * completionTokenCostUSD;
    const roundedCost = Number(rawCost.toFixed(6));

    return {
      providerCostUSD: roundedCost,
      // Confirmed only if pricing is backed by official commercial rates; otherwise estimated (eval tier)
      costStatus: isVerified ? "confirmed" : "estimated",
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
  const { taskId, complexity, model, outcome, usage, estimatedPromptTokens, retries = 0 } = options;

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

  // Record in ledger
  taskLedger.set(taskId, {
    providerCost,
    creditAccounting,
    timestamp: new Date().toISOString(),
  });

  return {
    providerCost,
    creditAccounting,
    isDuplicate: false,
  };
}

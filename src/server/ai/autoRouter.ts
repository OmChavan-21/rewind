/**
 * Rewind AI Auto Router
 * Deterministically routes tasks to the least expensive suitable model within the active provider.
 * Enforces explicit capability thresholds for complex and security-sensitive tasks.
 */

import type { AIProvider } from "../../types/ai";
import type {
  RoutingDecision,
  ModelMetadata,
  TaskComplexity,
  ModelTier,
} from "../../types/router";
import { classifyTask } from "./taskClassifier";
import {
  getModelsForProvider,
  getDefaultModelForProvider,
  getModelMetadata,
} from "./modelCatalog";
import { getActiveProvider } from "./providerRegistry";
import { AIError } from "./aiError";

export interface CapabilityThreshold {
  minCodeGeneration: number;
  minInstructionFollowing: number;
  minSecurityAwareness: number;
  requiresReasoning?: boolean;
}

export const COMPLEXITY_THRESHOLDS: Record<TaskComplexity, CapabilityThreshold> = {
  simple_explanation: {
    minCodeGeneration: 6.0,
    minInstructionFollowing: 7.0,
    minSecurityAwareness: 6.0,
  },
  lightweight_analysis: {
    minCodeGeneration: 7.0,
    minInstructionFollowing: 7.5,
    minSecurityAwareness: 7.0,
  },
  standard_refactor: {
    minCodeGeneration: 8.0,
    minInstructionFollowing: 8.5,
    minSecurityAwareness: 8.0,
  },
  complex_code_modification: {
    minCodeGeneration: 8.5,
    minInstructionFollowing: 9.0,
    minSecurityAwareness: 8.5,
  },
  security_sensitive: {
    minCodeGeneration: 9.0,
    minInstructionFollowing: 9.0,
    minSecurityAwareness: 9.0,
    requiresReasoning: true,
  },
};

const TIER_COST_RANK: Record<ModelTier, number> = {
  economy: 1,
  standard: 2,
  premium: 3,
  reasoning: 4,
};

export interface RouterOptions {
  mode?: "auto" | "manual";
  manualModelId?: string;
  manualProvider?: AIProvider;
}

/**
 * Checks if a model satisfies a capability threshold.
 */
export function meetsCapabilityThreshold(
  model: ModelMetadata,
  threshold: CapabilityThreshold
): boolean {
  const caps = model.capabilities;
  if (caps.codeGeneration < threshold.minCodeGeneration) return false;
  if (caps.instructionFollowing < threshold.minInstructionFollowing) return false;
  if (caps.securityAwareness < threshold.minSecurityAwareness) return false;
  if (threshold.requiresReasoning && !caps.reasoningSupport) {
    // If reasoning is required and model lacks reasoningSupport, check if overall scores are elite
    if (caps.codeGeneration < 9.5 || caps.securityAwareness < 9.5) {
      return false;
    }
  }
  return true;
}

/**
 * Computes an estimated comparative cost score for a model given estimated prompt tokens.
 */
export function estimateComparativeCost(
  model: ModelMetadata,
  estimatedPromptTokens: number
): number {
  if (model.pricing) {
    // Expected cost = prompt tokens * prompt rate + 1000 completion tokens * completion rate
    return (
      estimatedPromptTokens * model.pricing.promptTokenCostUSD +
      1000 * model.pricing.completionTokenCostUSD
    );
  }
  // Fall back to tier cost rank if pricing is unverified/absent
  return TIER_COST_RANK[model.tier] * 0.001;
}

/**
 * Deterministically routes an incoming task to the least expensive suitable model.
 */
export function routeTask(
  userPrompt: string,
  contextFiles: { path: string; content: string }[] = [],
  options?: RouterOptions
): RoutingDecision {
  const activeProvider = getActiveProvider();
  const requestedProvider = options?.manualProvider || activeProvider;
  const warnings: string[] = [];

  // Enforce provider strategy: Never silently switch to an unconfigured provider
  if (requestedProvider !== activeProvider) {
    if (requestedProvider === "nebius" && !process.env.NEBIUS_API_KEY) {
      throw new AIError(
        "authentication_failure",
        "Nebius provider is not configured. NVIDIA is the active testing provider.",
        {
          statusCode: 401,
          provider: "nebius",
          model: options?.manualModelId || "unknown",
          suggestion: "Use NVIDIA provider during development and testing.",
        }
      );
    }
  }

  const provider = requestedProvider;
  const mode = options?.mode || "auto";

  // Step 1: Classify task deterministically
  const taskClassification = classifyTask(userPrompt, contextFiles);
  const threshold = COMPLEXITY_THRESHOLDS[taskClassification.complexity];

  // Step 2: Handle Manual Selection Mode
  if (mode === "manual" && options?.manualModelId) {
    const selectedModel = getModelMetadata(options.manualModelId, provider);

    // Validate capability against threshold and warn if under-dimensioned
    if (!meetsCapabilityThreshold(selectedModel, threshold)) {
      warnings.push(
        `Manually selected model '${selectedModel.name}' (${selectedModel.tier}) has capability score below recommended threshold for ${taskClassification.complexity} tasks.`
      );
    }

    return {
      mode: "manual",
      selectedModel,
      selectedProvider: provider,
      taskClassification,
      routingReason: `Manual selection: User explicitly specified '${selectedModel.name}'.`,
      fallbackOccurred: false,
      attempts: 1,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Step 3: Auto Mode - Select the Least Expensive Suitable Model
  const catalogModels = getModelsForProvider(provider);
  if (catalogModels.length === 0) {
    const defaultModel = getDefaultModelForProvider(provider);
    return {
      mode: "auto",
      selectedModel: defaultModel,
      selectedProvider: provider,
      taskClassification,
      routingReason: `Auto Router defaulted to '${defaultModel.name}' (no catalog models found for provider).`,
      fallbackOccurred: false,
      attempts: 1,
    };
  }

  // Filter models that fit context and meet capability requirements
  const suitableModels = catalogModels.filter((m) => {
    const fitsContext = m.capabilities.maxContextTokens >= taskClassification.estimatedPromptTokens;
    return fitsContext && meetsCapabilityThreshold(m, threshold);
  });

  if (suitableModels.length > 0) {
    // Sort by lowest comparative cost
    suitableModels.sort((a, b) => {
      const costA = estimateComparativeCost(a, taskClassification.estimatedPromptTokens);
      const costB = estimateComparativeCost(b, taskClassification.estimatedPromptTokens);
      if (costA !== costB) return costA - costB;
      // Secondary sort: lower tier rank
      return TIER_COST_RANK[a.tier] - TIER_COST_RANK[b.tier];
    });

    const bestModel = suitableModels[0];
    const routingReason = `Auto Router selected '${bestModel.name}' (${bestModel.tier}) because task is ${taskClassification.complexity} (${taskClassification.riskLevel} risk), minimizing cost while meeting all capability requirements.`;

    return {
      mode: "auto",
      selectedModel: bestModel,
      selectedProvider: provider,
      taskClassification,
      routingReason,
      fallbackOccurred: false,
      attempts: 1,
    };
  }

  // Step 4: Fallback if no model strictly meets high threshold
  // Pick the model with the highest capability score
  catalogModels.sort((a, b) => {
    const scoreA =
      a.capabilities.codeGeneration * 0.4 +
      a.capabilities.instructionFollowing * 0.3 +
      a.capabilities.securityAwareness * 0.3;
    const scoreB =
      b.capabilities.codeGeneration * 0.4 +
      b.capabilities.instructionFollowing * 0.3 +
      b.capabilities.securityAwareness * 0.3;
    return scoreB - scoreA;
  });

  const fallbackModel = catalogModels[0];
  warnings.push(
    `No model in '${provider}' catalog fully satisfied capability requirements for ${taskClassification.complexity}; falling back to highest available capability model '${fallbackModel.name}'.`
  );

  return {
    mode: "auto",
    selectedModel: fallbackModel,
    selectedProvider: provider,
    taskClassification,
    routingReason: `Auto Router fallback: Selected highest available capability model '${fallbackModel.name}' for ${taskClassification.complexity}.`,
    fallbackOccurred: true,
    attempts: 1,
    warnings,
  };
}

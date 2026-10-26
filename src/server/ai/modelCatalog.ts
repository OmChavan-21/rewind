/**
 * Rewind Model Catalog & Pricing Metadata
 * Maintains capability profiles, tier classifications, and documented pricing sources
 * for NVIDIA API and Nebius Token Factory.
 */

import type { AIProvider } from "../../types/ai";
import type { ModelMetadata } from "../../types/router";

export const MODEL_CATALOG: Record<string, ModelMetadata> = {
  // ---------------------------------------------------------------------------
  // NVIDIA API Models (Active Testing & Development Provider)
  // ---------------------------------------------------------------------------
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    name: "Nemotron 3.5 Lightning (30B)",
    provider: "nvidia",
    tier: "economy",
    isDefault: true,
    recommendedComplexity: "lightweight_analysis",
    capabilities: {
      codeGeneration: 8.5,
      instructionFollowing: 9.0,
      securityAwareness: 8.0,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      // Free evaluation tier on integrate.api.nvidia.com
      promptTokenCostUSD: 0.0000002, // $0.20 per 1M tokens (reference NIM estimate)
      completionTokenCostUSD: 0.0000006, // $0.60 per 1M tokens
      source: "NVIDIA NIM Developer Evaluation / Reference Rate",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: false, // Evaluation tier credits; not a confirmed billed commercial invoice
    },
  },
  "nvidia/nemotron-3-super-120b-a12b": {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super (120B)",
    provider: "nvidia",
    tier: "premium",
    recommendedComplexity: "security_sensitive",
    capabilities: {
      codeGeneration: 9.5,
      instructionFollowing: 9.5,
      securityAwareness: 9.5,
      maxContextTokens: 131072,
      reasoningSupport: true,
    },
    pricing: {
      promptTokenCostUSD: 0.0000008, // $0.80 per 1M tokens (reference estimate)
      completionTokenCostUSD: 0.0000024, // $2.40 per 1M tokens
      source: "NVIDIA NIM Developer Evaluation / Reference Rate",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: false,
    },
  },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
    id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    name: "Nemotron 3 Nano (30B)",
    provider: "nvidia",
    tier: "economy",
    recommendedComplexity: "simple_explanation",
    capabilities: {
      codeGeneration: 7.5,
      instructionFollowing: 8.5,
      securityAwareness: 7.5,
      maxContextTokens: 32768,
      reasoningSupport: false,
    },
    pricing: {
      promptTokenCostUSD: 0.00000015,
      completionTokenCostUSD: 0.00000045,
      source: "NVIDIA NIM Developer Evaluation / Reference Rate",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: false,
    },
  },
  "meta/llama-3.1-70b-instruct": {
    id: "meta/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct",
    provider: "nvidia",
    tier: "standard",
    recommendedComplexity: "standard_refactor",
    capabilities: {
      codeGeneration: 8.8,
      instructionFollowing: 9.0,
      securityAwareness: 8.5,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      promptTokenCostUSD: 0.00000035,
      completionTokenCostUSD: 0.0000009,
      source: "NVIDIA NIM Developer Evaluation / Reference Rate",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: false,
    },
  },

  // ---------------------------------------------------------------------------
  // Nebius Token Factory Models (Inactive by Default - Staged for Production)
  // ---------------------------------------------------------------------------
  "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF": {
    id: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
    name: "Llama 3.1 Nemotron 70B (Nebius)",
    provider: "nebius",
    tier: "standard",
    isDefault: true,
    recommendedComplexity: "standard_refactor",
    capabilities: {
      codeGeneration: 9.0,
      instructionFollowing: 9.5,
      securityAwareness: 9.0,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      promptTokenCostUSD: 0.0000006, // $0.60 per 1M tokens
      completionTokenCostUSD: 0.0000018, // $1.80 per 1M tokens
      source: "Nebius Token Factory Published Pricing Schedule",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: true,
    },
  },
  "meta-llama/Meta-Llama-3.1-8B-Instruct": {
    id: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    name: "Llama 3.1 8B Instruct (Nebius)",
    provider: "nebius",
    tier: "economy",
    recommendedComplexity: "simple_explanation",
    capabilities: {
      codeGeneration: 7.5,
      instructionFollowing: 8.5,
      securityAwareness: 7.0,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
    pricing: {
      promptTokenCostUSD: 0.00000015, // $0.15 per 1M tokens
      completionTokenCostUSD: 0.00000045, // $0.45 per 1M tokens
      source: "Nebius Token Factory Published Pricing Schedule",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: true,
    },
  },
  "Qwen/Qwen2.5-Coder-32B-Instruct": {
    id: "Qwen/Qwen2.5-Coder-32B-Instruct",
    name: "Qwen 2.5 Coder 32B (Nebius)",
    provider: "nebius",
    tier: "standard",
    recommendedComplexity: "complex_code_modification",
    capabilities: {
      codeGeneration: 9.4,
      instructionFollowing: 9.0,
      securityAwareness: 8.5,
      maxContextTokens: 32768,
      reasoningSupport: false,
    },
    pricing: {
      promptTokenCostUSD: 0.0000003, // $0.30 per 1M tokens
      completionTokenCostUSD: 0.0000009, // $0.90 per 1M tokens
      source: "Nebius Token Factory Published Pricing Schedule",
      verifiedAt: "2026-10-25T00:00:00.000Z",
      isVerified: true,
    },
  },
};

/**
 * Returns all configured models for a specific provider.
 */
export function getModelsForProvider(provider: AIProvider): ModelMetadata[] {
  return Object.values(MODEL_CATALOG).filter((m) => m.provider === provider);
}

/**
 * Returns the default model metadata for a provider.
 */
export function getDefaultModelForProvider(provider: AIProvider): ModelMetadata {
  const models = getModelsForProvider(provider);
  const def = models.find((m) => m.isDefault);
  if (def) return def;
  if (models.length > 0) return models[0];

  // Fallback synthetic entry if no catalog model matches
  const fallbackId =
    provider === "nvidia"
      ? "nvidia/nemotron-3.5-lightning-30b-a3b"
      : "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF";

  return {
    id: fallbackId,
    name: fallbackId,
    provider,
    tier: "economy",
    isDefault: true,
    capabilities: {
      codeGeneration: 8.0,
      instructionFollowing: 8.5,
      securityAwareness: 8.0,
      maxContextTokens: 131072,
      reasoningSupport: false,
    },
  };
}

/**
 * Retrieves metadata for a model ID, optionally registering an ad-hoc model.
 */
export function getModelMetadata(modelId: string, provider: AIProvider): ModelMetadata {
  if (MODEL_CATALOG[modelId]) {
    return MODEL_CATALOG[modelId];
  }

  // Look up case-insensitively
  const found = Object.values(MODEL_CATALOG).find(
    (m) => m.id.toLowerCase() === modelId.toLowerCase() && m.provider === provider
  );
  if (found) return found;

  // Ad-hoc model entry with safe conservative assumptions
  return {
    id: modelId,
    name: modelId.split("/").pop() || modelId,
    provider,
    tier: "standard",
    capabilities: {
      codeGeneration: 8.0,
      instructionFollowing: 8.0,
      securityAwareness: 8.0,
      maxContextTokens: 65536,
      reasoningSupport: false,
    },
    // Missing pricing metadata forces "estimate unavailable" in dual accounting
  };
}

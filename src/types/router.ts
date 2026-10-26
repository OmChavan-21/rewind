/**
 * Rewind AI Auto Mode - Router & Dual Accounting Types
 * Defines interfaces for task classification, provider-aware routing,
 * model capabilities, verified pricing metadata, and dual metric tracking.
 */

import type { AIProvider } from "./ai";

export type TaskComplexity =
  | "simple_explanation"
  | "lightweight_analysis"
  | "standard_refactor"
  | "complex_code_modification"
  | "security_sensitive";

export type TaskRiskLevel = "low" | "medium" | "high";

export type ModelTier = "economy" | "standard" | "premium" | "reasoning";

export interface ModelCapability {
  /** 1-10 rating for code generation and refactoring quality */
  codeGeneration: number;
  /** 1-10 rating for strict adherence to system prompts and schemas */
  instructionFollowing: number;
  /** 1-10 rating for recognizing security vulnerabilities and invariants */
  securityAwareness: number;
  /** Maximum supported context window in tokens */
  maxContextTokens: number;
  /** Whether model supports deep reasoning / chain-of-thought tokens */
  reasoningSupport: boolean;
}

export interface ModelPricing {
  /** USD cost per prompt (input) token */
  promptTokenCostUSD: number;
  /** USD cost per completion (output) token */
  completionTokenCostUSD: number;
  /** Authoritative documentation or catalog source for pricing */
  source: string;
  /** ISO date when pricing was last verified against provider documentation */
  verifiedAt: string;
  /** True only if pricing is backed by official published commercial rate; false for estimated/eval */
  isVerified: boolean;
}

export interface ModelMetadata {
  /** Provider-specific model ID, e.g. "nvidia/nemotron-3.5-lightning-30b-a3b" */
  id: string;
  /** Friendly display name, e.g. "Nemotron 3.5 Lightning (30B)" */
  name: string;
  /** Hosting provider */
  provider: AIProvider;
  /** Cost/capability tier */
  tier: ModelTier;
  /** Quantitative capability scores */
  capabilities: ModelCapability;
  /** Optional pricing metadata; if absent, cost is marked as unavailable */
  pricing?: ModelPricing;
  /** Whether this is the default baseline model for the provider */
  isDefault?: boolean;
  /** Recommended minimum complexity for this model */
  recommendedComplexity?: TaskComplexity;
}

export interface TaskClassification {
  /** Determined complexity level */
  complexity: TaskComplexity;
  /** Inferred risk level based on files affected and prompt intent */
  riskLevel: TaskRiskLevel;
  /** Target workspace file paths mentioned or implied */
  targetPaths: string[];
  /** Estimated prompt token count (approx. 4 chars per token) */
  estimatedPromptTokens: number;
  /** Brief rationale explaining why this classification was assigned */
  rationale: string;
}

export interface RoutingDecision {
  /** Auto router or manual selection */
  mode: "auto" | "manual";
  /** The selected model's metadata */
  selectedModel: ModelMetadata;
  /** The selected provider */
  selectedProvider: AIProvider;
  /** Task classification results */
  taskClassification: TaskClassification;
  /** Clear human-readable reason why this model was chosen */
  routingReason: string;
  /** Whether a fallback occurred during routing or execution */
  fallbackOccurred: boolean;
  /** Total generation attempts including retries */
  attempts: number;
  /** Optional warnings (e.g. if manual selection is under-dimensioned for task risk) */
  warnings?: string[];
}

export interface ProviderCostRecord {
  /** Computed cost in USD, or null if pricing/usage is unavailable */
  providerCostUSD: number | null;
  /** Confidence status of the cost figure */
  costStatus: "confirmed" | "estimated" | "unavailable";
  /** Pricing source reference */
  pricingSource?: string;
  /** Last verified timestamp of pricing source */
  pricingVerifiedAt?: string;
  /** Input tokens returned by provider usage */
  promptTokens?: number;
  /** Output tokens returned by provider usage */
  completionTokens?: number;
  /** Total tokens returned by provider usage */
  totalTokens?: number;
}

export interface CreditAccountingRecord {
  /** Rewind-defined credits charged for this operation */
  creditsCharged: number;
  /** Explanatory policy note (e.g., "Charged per completed task (Free usage allowance)") */
  creditPolicy: string;
  /** Whether credits represent a free usage allowance rather than commercial billing */
  isFreeAllowance: boolean;
  /** Number of retries that were NOT charged */
  unchargedRetries: number;
}

export interface AIProposalRoutingMeta {
  routing: RoutingDecision;
  costMetrics: ProviderCostRecord;
  accounting: CreditAccountingRecord;
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

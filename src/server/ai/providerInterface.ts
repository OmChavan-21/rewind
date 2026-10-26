/**
 * Shared AI Provider Interface
 * Standardizes chat completions, model listing, status verification, and token metrics
 * across NVIDIA API (integrate.api.nvidia.com) and Nebius Token Factory (api.tokenfactory.nebius.com).
 */

import type { AIProvider, AIStatus } from "../../types/ai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  signal?: AbortSignal;
  enableThinking?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderCompletionResponse {
  rawContent: string;
  usage?: TokenUsage;
  model: string;
  finishReason?: string;
  latencyMs: number;
}

export interface AIProviderClient {
  readonly provider: AIProvider;
  readonly baseUrl: string;
  readonly isConfigured: boolean;

  /** Checks connection status, credentials, and catalog presence */
  checkStatus(modelName?: string): Promise<AIStatus>;

  /** Retrieves the account catalog of available model IDs */
  listAvailableModels(): Promise<string[]>;

  /** Executes a chat completion returning raw text and token usage */
  generateCompletion(request: ProviderCompletionRequest): Promise<ProviderCompletionResponse>;
}

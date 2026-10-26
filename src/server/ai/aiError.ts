/**
 * AI Error Classification and Diagnostics
 */

import type { AIErrorCategory, AIProvider } from "../../types/ai";

export class AIError extends Error {
  readonly category: AIErrorCategory;
  readonly statusCode: number;
  readonly provider: AIProvider;
  readonly model: string;
  readonly suggestion?: string;

  constructor(
    category: AIErrorCategory,
    message: string,
    options: {
      statusCode?: number;
      provider: AIProvider;
      model: string;
      suggestion?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "AIError";
    this.category = category;
    this.statusCode = options.statusCode ?? 500;
    this.provider = options.provider;
    this.model = options.model;
    this.suggestion = options.suggestion;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export function parseFetchError(
  error: unknown,
  provider: AIProvider,
  model: string,
  targetUrl: string,
  timeoutSeconds: number = 60
): AIError {
  const providerName = provider === "nvidia" ? "NVIDIA API" : "Nebius Token Factory";

  if (error instanceof AIError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new AIError(
      "timeout",
      `${providerName} request timed out after ${timeoutSeconds} seconds.`,
      { statusCode: 504, provider, model }
    );
  }

  if (error instanceof Error && error.message.includes("fetch failed")) {
    const cause = (error as { cause?: unknown }).cause;
    let causeDetail = "";
    if (cause && typeof cause === "object") {
      const c = cause as { code?: string; message?: string };
      causeDetail = c.code || c.message || "";
    } else if (cause) {
      causeDetail = String(cause);
    }

    return new AIError(
      "network_error",
      `Network connection failure reaching ${providerName} (${targetUrl})${
        causeDetail ? `: ${causeDetail}` : ""
      }. Check network connectivity and DNS resolution.`,
      { statusCode: 502, provider, model, cause }
    );
  }

  const rawMessage = error instanceof Error ? error.message : "Unknown error";
  return new AIError("provider_error", `${providerName} error: ${rawMessage}`, {
    statusCode: 500,
    provider,
    model,
    cause: error,
  });
}

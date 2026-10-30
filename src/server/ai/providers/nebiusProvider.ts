/**
 * Nebius Token Factory Provider Client Adapter
 * Integrates with Nebius Token Factory (api.tokenfactory.nebius.com)
 * Architecture adapter prepared for production rollout; kept inactive during NVIDIA test phase.
 */

import type { AIStatus, AIErrorCategory } from "../../../types/ai";
import type {
  AIProviderClient,
  ProviderCompletionRequest,
  ProviderCompletionResponse,
} from "../providerInterface";
import { AIError, parseFetchError } from "../aiError";

export const DEFAULT_NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
export const DEFAULT_NEBIUS_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

function sanitizeEnvVal(val?: string): string {
  if (!val) return "";
  let cleaned = val.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

interface GenerationState {
  verified: boolean;
  timestamp?: string;
  lastError?: {
    category: AIErrorCategory;
    message: string;
  };
}

const nebiusGenerationStateMap: Record<string, GenerationState> = {};

export function setNebiusGenerationResult(
  model: string,
  success: boolean,
  error?: { category: AIErrorCategory; message: string }
) {
  nebiusGenerationStateMap[`nebius:${model}`] = {
    verified: success,
    timestamp: new Date().toISOString(),
    lastError: success ? undefined : error,
  };
}

export function getNebiusGenerationResult(model: string): GenerationState | undefined {
  return nebiusGenerationStateMap[`nebius:${model}`];
}

export function clearNebiusGenerationResults() {
  for (const k of Object.keys(nebiusGenerationStateMap)) {
    delete nebiusGenerationStateMap[k];
  }
}

export class NebiusProviderClient implements AIProviderClient {
  readonly provider = "nebius" as const;

  get baseUrl(): string {
    return trimBaseUrl(
      sanitizeEnvVal(process.env.NEBIUS_BASE_URL) || DEFAULT_NEBIUS_BASE_URL
    );
  }

  get apiKey(): string {
    return sanitizeEnvVal(process.env.NEBIUS_API_KEY);
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  get defaultModel(): string {
    return sanitizeEnvVal(process.env.NEBIUS_MODEL) || DEFAULT_NEBIUS_MODEL;
  }

  async checkStatus(modelName?: string): Promise<AIStatus> {
    const targetModel = modelName || this.defaultModel;
    const apiKey = this.apiKey;
    const baseUrl = this.baseUrl;

    if (!apiKey) {
      return {
        state: "unconfigured",
        provider: "nebius",
        model: targetModel,
        baseUrl,
        endpointReachable: false,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: "NEBIUS_API_KEY is not set. Configure it in .env.local to enable AI proposals.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      if (response.ok) {
        let catalogModels: string[] = [];
        try {
          const data = (await response.json()) as { data?: Array<{ id?: string }> };
          catalogModels = Array.isArray(data.data)
            ? data.data
                .map((item) => item.id)
                .filter((id): id is string => typeof id === "string")
            : [];
        } catch {
          // Handled gracefully
        }

        const modelListed = catalogModels.includes(targetModel);
        const genState = getNebiusGenerationResult(targetModel);
        const generationVerified = !!genState?.verified;

        if (!modelListed) {
          return {
            state: "failed",
            provider: "nebius",
            model: targetModel,
            baseUrl,
            endpointReachable: true,
            credentialsAccepted: true,
            modelListed: false,
            generationVerified: false,
            availableModels: catalogModels.slice(0, 10),
            message: `Connected to Nebius Token Factory, but configured model '${targetModel}' is not in the account catalog. Available models include: ${catalogModels.slice(0, 5).join(", ")}. Set NEBIUS_MODEL in .env.local to a supported model.`,
          };
        }

        if (genState && !genState.verified && genState.lastError) {
          return {
            state: "failed",
            provider: "nebius",
            model: targetModel,
            baseUrl,
            endpointReachable: true,
            credentialsAccepted: true,
            modelListed: true,
            generationVerified: false,
            availableModels: catalogModels.slice(0, 10),
            message: `Connected to Nebius Token Factory (${targetModel}), but last proposal generation failed: ${genState.lastError.message}`,
          };
        }

        return {
          state: "connected",
          provider: "nebius",
          model: targetModel,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: true,
          modelListed: true,
          generationVerified,
          availableModels: catalogModels.slice(0, 10),
          message: generationVerified
            ? `Successfully connected to Nebius Token Factory (${targetModel}) — Generation verified.`
            : `Connected to Nebius Token Factory (${targetModel}) — Credentials accepted, model in catalog. Ready to generate proposals.`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          state: "failed",
          provider: "nebius",
          model: targetModel,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: false,
          modelListed: false,
          generationVerified: false,
          message: `Authentication failed (HTTP ${response.status}). Verify NEBIUS_API_KEY in .env.local.`,
        };
      }

      return {
        state: "failed",
        provider: "nebius",
        model: targetModel,
        baseUrl,
        endpointReachable: true,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: `Nebius Token Factory endpoint returned HTTP ${response.status}.`,
      };
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        state: "failed",
        provider: "nebius",
        model: targetModel,
        baseUrl,
        endpointReachable: false,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: timedOut
          ? "Connection to Nebius Token Factory timed out after 12 seconds."
          : `Unable to reach Nebius Token Factory (${baseUrl}/models). Check the endpoint and network connection.`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAvailableModels(): Promise<string[]> {
    const apiKey = this.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      return Array.isArray(data.data)
        ? data.data
            .map((item) => item.id)
            .filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  }

  async generateCompletion(
    request: ProviderCompletionRequest
  ): Promise<ProviderCompletionResponse> {
    const apiKey = this.apiKey;
    const model = request.model || this.defaultModel;
    const baseUrl = this.baseUrl;

    if (!apiKey) {
      const err = new AIError(
        "authentication_failure",
        "NEBIUS_API_KEY is not configured. Add it to .env.local to generate AI proposals.",
        {
          statusCode: 401,
          provider: "nebius",
          model,
          suggestion: 'Open .env.local and set NEBIUS_API_KEY="your_api_key".',
        }
      );
      setNebiusGenerationResult(model, false, {
        category: err.category,
        message: err.message,
      });
      throw err;
    }

    const completionEndpoint = `${baseUrl}/chat/completions`;
    const timeoutSec = 90;
    const startTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

    try {
      const payload: Record<string, unknown> = {
        model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 2048,
      };

      if (request.responseFormat) {
        payload.response_format = request.responseFormat;
      }

      let response: Response;
      try {
        response = await fetch(completionEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: request.signal || controller.signal,
        });
      } catch (fetchErr: unknown) {
        throw parseFetchError(fetchErr, "nebius", model, completionEndpoint, timeoutSec);
      }

      if (!response.ok && response.status === 400) {
        const errText = await response.text().catch(() => "");
        if (errText.includes("response_format") || errText.includes("json_object")) {
          const fallbackPayload = {
            model,
            messages: request.messages,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 2048,
          };
          try {
            response = await fetch(completionEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                Accept: "application/json",
              },
              body: JSON.stringify(fallbackPayload),
              signal: request.signal || controller.signal,
            });
          } catch (retryErr: unknown) {
            throw parseFetchError(retryErr, "nebius", model, completionEndpoint, timeoutSec);
          }
        } else {
          throw new AIError(
            "invalid_payload",
            `Invalid request payload sent to Nebius Token Factory (HTTP 400): ${errText.slice(0, 200)}`,
            { statusCode: 400, provider: "nebius", model }
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        if (response.status === 401 || response.status === 403) {
          throw new AIError(
            "authentication_failure",
            `Nebius Token Factory authentication failed (HTTP ${response.status}). Please verify NEBIUS_API_KEY in .env.local.`,
            { statusCode: response.status, provider: "nebius", model }
          );
        }

        if (response.status === 404) {
          throw new AIError(
            "invalid_model",
            `The configured model '${model}' does not exist or is not enabled for your account on Nebius Token Factory (HTTP 404).`,
            {
              statusCode: 404,
              provider: "nebius",
              model,
              suggestion: "Update NEBIUS_MODEL in .env.local to a supported active model.",
            }
          );
        }

        if (response.status === 429) {
          throw new AIError(
            "rate_limit",
            "Nebius Token Factory rate limit or quota exceeded (HTTP 429). Please retry in a few moments.",
            { statusCode: 429, provider: "nebius", model }
          );
        }

        throw new AIError(
          "provider_error",
          `Nebius Token Factory returned HTTP ${response.status}: ${errorText.slice(0, 200)}`,
          { statusCode: response.status, provider: "nebius", model }
        );
      }

      const latencyMs = Date.now() - startTime;
      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
          };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const choice = data.choices?.[0];
      const message = choice?.message;

      let rawContent: string | null | undefined = message?.content;
      if (
        (!rawContent || typeof rawContent !== "string" || !rawContent.trim()) &&
        message?.reasoning_content
      ) {
        rawContent = message.reasoning_content;
      }

      if (typeof rawContent !== "string" || !rawContent.trim()) {
        if (choice?.finish_reason === "length") {
          throw new AIError(
            "provider_error",
            "Nebius Token Factory reached its maximum token limit while reasoning before completing the proposal. Please make your prompt more specific.",
            { statusCode: 502, provider: "nebius", model }
          );
        }

        throw new AIError(
          "invalid_response",
          `Nebius Token Factory returned an empty response choice (finish reason: ${
            choice?.finish_reason || "unknown"
          }).`,
          { statusCode: 502, provider: "nebius", model }
        );
      }

      setNebiusGenerationResult(model, true);

      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined;

      return {
        rawContent,
        usage,
        model,
        finishReason: choice?.finish_reason,
        latencyMs,
      };
    } catch (error: unknown) {
      const aiErr =
        error instanceof AIError
          ? error
          : parseFetchError(error, "nebius", model, completionEndpoint);

      setNebiusGenerationResult(model, false, {
        category: aiErr.category,
        message: aiErr.message,
      });

      throw aiErr;
    } finally {
      clearTimeout(timeout);
    }
  }
}

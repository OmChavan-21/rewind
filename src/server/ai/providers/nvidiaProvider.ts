/**
 * NVIDIA API Provider Client Adapter
 * Integrates with NVIDIA NIM API (integrate.api.nvidia.com)
 * Active testing & development provider for Rewind AI.
 */

import type { AIStatus, AIErrorCategory } from "../../../types/ai";
import type {
  AIProviderClient,
  ProviderCompletionRequest,
  ProviderCompletionResponse,
} from "../providerInterface";
import { AIError, parseFetchError } from "../aiError";

export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

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

const generationStateMap: Record<string, GenerationState> = {};

export function setNvidiaGenerationResult(
  model: string,
  success: boolean,
  error?: { category: AIErrorCategory; message: string }
) {
  generationStateMap[`nvidia:${model}`] = {
    verified: success,
    timestamp: new Date().toISOString(),
    lastError: success ? undefined : error,
  };
}

export function getNvidiaGenerationResult(model: string): GenerationState | undefined {
  return generationStateMap[`nvidia:${model}`];
}

export function clearNvidiaGenerationResults() {
  for (const k of Object.keys(generationStateMap)) {
    delete generationStateMap[k];
  }
}

export class NvidiaProviderClient implements AIProviderClient {
  readonly provider = "nvidia" as const;

  get baseUrl(): string {
    return trimBaseUrl(
      sanitizeEnvVal(process.env.NVIDIA_BASE_URL) || DEFAULT_NVIDIA_BASE_URL
    );
  }

  get apiKey(): string {
    return sanitizeEnvVal(process.env.NVIDIA_API_KEY);
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  get defaultModel(): string {
    return sanitizeEnvVal(process.env.NVIDIA_MODEL) || DEFAULT_NVIDIA_MODEL;
  }

  async checkStatus(modelName?: string): Promise<AIStatus> {
    const targetModel = modelName || this.defaultModel;
    const apiKey = this.apiKey;
    const baseUrl = this.baseUrl;

    if (!apiKey) {
      return {
        state: "unconfigured",
        provider: "nvidia",
        model: targetModel,
        baseUrl,
        endpointReachable: false,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: "NVIDIA_API_KEY is not set. Configure it in .env.local to enable AI proposals.",
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
        const genState = getNvidiaGenerationResult(targetModel);
        const generationVerified = !!genState?.verified;

        const recommendedModels = catalogModels
          .filter((id) => id.toLowerCase().includes("nemotron"))
          .slice(0, 6);

        if (!modelListed) {
          return {
            state: "failed",
            provider: "nvidia",
            model: targetModel,
            baseUrl,
            endpointReachable: true,
            credentialsAccepted: true,
            modelListed: false,
            generationVerified: false,
            availableModels: catalogModels.slice(0, 10),
            message: `Connected to NVIDIA API, but configured model '${targetModel}' is not in the account catalog. Available models include: ${
              recommendedModels.length > 0
                ? recommendedModels.join(", ")
                : catalogModels.slice(0, 5).join(", ")
            }. Set NVIDIA_MODEL in .env.local to a supported model.`,
          };
        }

        if (genState && !genState.verified && genState.lastError) {
          return {
            state: "failed",
            provider: "nvidia",
            model: targetModel,
            baseUrl,
            endpointReachable: true,
            credentialsAccepted: true,
            modelListed: true,
            generationVerified: false,
            availableModels: catalogModels.slice(0, 10),
            message: `Connected to NVIDIA API (${targetModel}), but last proposal generation failed: ${genState.lastError.message}`,
          };
        }

        return {
          state: "connected",
          provider: "nvidia",
          model: targetModel,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: true,
          modelListed: true,
          generationVerified,
          availableModels: catalogModels.slice(0, 10),
          message: generationVerified
            ? `Successfully connected to NVIDIA API (${targetModel}) — Generation verified.`
            : `Connected to NVIDIA API (${targetModel}) — Credentials accepted, model in catalog. Ready to generate proposals.`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          state: "failed",
          provider: "nvidia",
          model: targetModel,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: false,
          modelListed: false,
          generationVerified: false,
          message: `Authentication failed (HTTP ${response.status}). Verify NVIDIA_API_KEY in .env.local.`,
        };
      }

      return {
        state: "failed",
        provider: "nvidia",
        model: targetModel,
        baseUrl,
        endpointReachable: true,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: `NVIDIA API endpoint returned HTTP ${response.status}.`,
      };
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        state: "failed",
        provider: "nvidia",
        model: targetModel,
        baseUrl,
        endpointReachable: false,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: timedOut
          ? "Connection to NVIDIA API timed out after 12 seconds."
          : `Unable to reach NVIDIA API (${baseUrl}/models). Check the endpoint and network connection.`,
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
        "NVIDIA_API_KEY is not configured. Add it to .env.local to generate AI proposals.",
        {
          statusCode: 401,
          provider: "nvidia",
          model,
          suggestion: 'Open .env.local and set NVIDIA_API_KEY="your_api_key".',
        }
      );
      setNvidiaGenerationResult(model, false, {
        category: err.category,
        message: err.message,
      });
      throw err;
    }

    const completionEndpoint = `${baseUrl}/chat/completions`;
    const timeoutSec = 60;
    const startTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

    try {
      const payload: Record<string, unknown> = {
        model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 4096,
      };

      if (request.responseFormat) {
        payload.response_format = request.responseFormat;
      }

      // Nemotron sub-3s optimization: disable reasoning loop on NVIDIA integrate
      if (request.enableThinking !== true) {
        payload.chat_template_kwargs = { enable_thinking: false };
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
        throw parseFetchError(fetchErr, "nvidia", model, completionEndpoint, timeoutSec);
      }

      // Handle fallback if chat_template_kwargs or response_format returns 400
      if (!response.ok && response.status === 400) {
        const errText = await response.text().catch(() => "");
        if (
          errText.includes("response_format") ||
          errText.includes("json_object") ||
          errText.includes("chat_template_kwargs")
        ) {
          const fallbackPayload = {
            model,
            messages: request.messages,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 4096,
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
            throw parseFetchError(retryErr, "nvidia", model, completionEndpoint, timeoutSec);
          }
        } else {
          throw new AIError(
            "invalid_payload",
            `Invalid request payload sent to NVIDIA API (HTTP 400): ${errText.slice(0, 200)}`,
            { statusCode: 400, provider: "nvidia", model }
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        if (response.status === 401 || response.status === 403) {
          throw new AIError(
            "authentication_failure",
            `NVIDIA API authentication failed (HTTP ${response.status}). Please verify NVIDIA_API_KEY in .env.local.`,
            { statusCode: response.status, provider: "nvidia", model }
          );
        }

        if (response.status === 404) {
          const isModelError =
            errorText.includes("does not exist") ||
            errorText.includes("Not found for account") ||
            errorText.includes("Function") ||
            errorText.includes("page not found") ||
            errorText.includes("not found");

          const message = isModelError
            ? `The configured model '${model}' does not exist or is not enabled for your account on NVIDIA API (HTTP 404). Supported models include 'nvidia/nemotron-3.5-lightning-30b-a3b' or 'nvidia/nemotron-3-super-120b-a12b'.`
            : `NVIDIA API completion endpoint was not found (HTTP 404): ${completionEndpoint}`;

          throw new AIError("invalid_model", message, {
            statusCode: 404,
            provider: "nvidia",
            model,
            suggestion: "Update NVIDIA_MODEL in .env.local to a supported active model.",
          });
        }

        if (response.status === 429) {
          throw new AIError(
            "rate_limit",
            "NVIDIA API rate limit or quota exceeded (HTTP 429). Please retry in a few moments.",
            { statusCode: 429, provider: "nvidia", model }
          );
        }

        throw new AIError(
          "provider_error",
          `NVIDIA API returned HTTP ${response.status}: ${errorText.slice(0, 200)}`,
          { statusCode: response.status, provider: "nvidia", model }
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
            "NVIDIA API reached its maximum token limit while reasoning before completing the proposal. Please make your prompt more specific.",
            { statusCode: 502, provider: "nvidia", model }
          );
        }

        throw new AIError(
          "invalid_response",
          `NVIDIA API returned an empty response choice (finish reason: ${
            choice?.finish_reason || "unknown"
          }).`,
          { statusCode: 502, provider: "nvidia", model }
        );
      }

      setNvidiaGenerationResult(model, true);

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
          : parseFetchError(error, "nvidia", model, completionEndpoint);

      setNvidiaGenerationResult(model, false, {
        category: aiErr.category,
        message: aiErr.message,
      });

      throw aiErr;
    } finally {
      clearTimeout(timeout);
    }
  }
}

import crypto from "node:crypto";
import type {
  AIStatus,
  AIChangeProposal,
  ProposedFileModification,
  AIErrorCategory,
} from "../types/ai";
import {
  isPermittedFile,
  sanitizeRelativePath,
  MAX_FILE_SIZE_BYTES,
  SecurityError,
} from "../security/boundaries";

export const DEFAULT_NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
export const DEFAULT_NEBIUS_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

// Maximum model response size: 500 KiB.
export const MAX_MODEL_OUTPUT_BYTES = 500 * 1024;

export type AIProvider = "nebius" | "nvidia";

export type AIConfig = {
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  keyName: string;
};

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

interface GenerationVerificationState {
  verified: boolean;
  timestamp?: string;
  lastError?: {
    category: AIErrorCategory;
    message: string;
  };
}

const generationState: Record<string, GenerationVerificationState> = {};

export function setGenerationResult(
  provider: AIProvider,
  model: string,
  success: boolean,
  error?: { category: AIErrorCategory; message: string }
) {
  generationState[`${provider}:${model}`] = {
    verified: success,
    timestamp: new Date().toISOString(),
    lastError: success ? undefined : error,
  };
}

export function getGenerationResult(
  provider: AIProvider,
  model: string
): GenerationVerificationState | undefined {
  return generationState[`${provider}:${model}`];
}

export function clearGenerationResults() {
  for (const k of Object.keys(generationState)) {
    delete generationState[k];
  }
}

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

/**
 * Reads the currently selected provider's server-side configuration.
 *
 * Automatically detects whether NVIDIA API or Nebius Token Factory is configured.
 * Never returns or logs secrets.
 */
export function getAIConfig(): AIConfig {
  const explicitProvider = sanitizeEnvVal(process.env.AI_PROVIDER).toLowerCase();

  let provider: AIProvider;
  if (explicitProvider === "nvidia") {
    provider = "nvidia";
  } else if (explicitProvider === "nebius") {
    provider = "nebius";
  } else if (
    sanitizeEnvVal(process.env.NVIDIA_API_KEY) &&
    !sanitizeEnvVal(process.env.NEBIUS_API_KEY)
  ) {
    provider = "nvidia";
  } else {
    provider = "nebius";
  }

  if (provider === "nvidia") {
    return {
      provider,
      apiKey: sanitizeEnvVal(process.env.NVIDIA_API_KEY),
      model:
        sanitizeEnvVal(process.env.NVIDIA_MODEL) || DEFAULT_NVIDIA_MODEL,
      baseUrl: trimBaseUrl(
        sanitizeEnvVal(process.env.NVIDIA_BASE_URL) ||
          DEFAULT_NVIDIA_BASE_URL
      ),
      keyName: "NVIDIA_API_KEY",
    };
  }

  return {
    provider,
    apiKey: sanitizeEnvVal(process.env.NEBIUS_API_KEY),
    model:
      sanitizeEnvVal(process.env.NEBIUS_MODEL) || DEFAULT_NEBIUS_MODEL,
    baseUrl: trimBaseUrl(
      sanitizeEnvVal(process.env.NEBIUS_BASE_URL) ||
        DEFAULT_NEBIUS_BASE_URL
    ),
    keyName: "NEBIUS_API_KEY",
  };
}

/**
 * Backwards-compatible configuration function.
 */
export function getNebiusConfig() {
  const config = getAIConfig();
  return {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

/**
 * Formats low-level errors (including Node fetch/undici errors) into safe diagnostics.
 */
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

/**
 * Checks the selected provider's connectivity.
 * Distinguishes between:
 * 1. Endpoint reachable
 * 2. Credentials accepted
 * 3. Configured model listed in account catalog
 * 4. Actual text-generation verified
 */
export async function checkNebiusStatus(): Promise<AIStatus> {
  const config = getAIConfig();
  const { apiKey, model, baseUrl, provider, keyName } = config;
  const providerName =
    provider === "nvidia" ? "NVIDIA API" : "Nebius Token Factory";

  if (!apiKey) {
    return {
      state: "unconfigured",
      provider,
      model,
      baseUrl,
      endpointReachable: false,
      credentialsAccepted: false,
      modelListed: false,
      generationVerified: false,
      message: `${keyName} is not set. Configure it in .env.local to enable AI proposals.`,
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
        const data = (await response.json()) as {
          data?: Array<{ id?: string }>;
        };

        catalogModels = Array.isArray(data.data)
          ? data.data
              .map((item) => item.id)
              .filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        // Successful response without parseable models array
      }

      const modelListed = catalogModels.includes(model);
      const genState = getGenerationResult(provider, model);
      const generationVerified = !!genState?.verified;

      // Extract recommended Nemotron models from catalog
      const recommendedModels = catalogModels
        .filter((id) => id.toLowerCase().includes("nemotron"))
        .slice(0, 6);

      if (!modelListed) {
        return {
          state: "failed",
          provider,
          model,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: true,
          modelListed: false,
          generationVerified: false,
          availableModels: catalogModels.slice(0, 10),
          message: `Connected to ${providerName}, but configured model '${model}' is not in the account catalog. Available models include: ${
            recommendedModels.length > 0
              ? recommendedModels.join(", ")
              : catalogModels.slice(0, 5).join(", ")
          }. Set NVIDIA_MODEL in .env.local to a supported model.`,
        };
      }

      if (genState && !genState.verified && genState.lastError) {
        return {
          state: "failed",
          provider,
          model,
          baseUrl,
          endpointReachable: true,
          credentialsAccepted: true,
          modelListed: true,
          generationVerified: false,
          availableModels: catalogModels.slice(0, 10),
          message: `Connected to ${providerName} (${model}), but last proposal generation failed: ${genState.lastError.message}`,
        };
      }

      return {
        state: "connected",
        provider,
        model,
        baseUrl,
        endpointReachable: true,
        credentialsAccepted: true,
        modelListed: true,
        generationVerified,
        availableModels: catalogModels.slice(0, 10),
        message: generationVerified
          ? `Successfully connected to ${providerName} (${model}) — Generation verified.`
          : `Connected to ${providerName} (${model}) — Credentials accepted, model in catalog. Ready to generate proposals.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        state: "failed",
        provider,
        model,
        baseUrl,
        endpointReachable: true,
        credentialsAccepted: false,
        modelListed: false,
        generationVerified: false,
        message: `Authentication failed (HTTP ${response.status}). Verify ${keyName} in .env.local.`,
      };
    }

    return {
      state: "failed",
      provider,
      model,
      baseUrl,
      endpointReachable: true,
      credentialsAccepted: false,
      modelListed: false,
      generationVerified: false,
      message: `${providerName} endpoint returned HTTP ${response.status}.`,
    };
  } catch (error: unknown) {
    const timedOut = error instanceof Error && error.name === "AbortError";

    return {
      state: "failed",
      provider,
      model,
      baseUrl,
      endpointReachable: false,
      credentialsAccepted: false,
      modelListed: false,
      generationVerified: false,
      message: timedOut
        ? `Connection to ${providerName} timed out after 12 seconds.`
        : `Unable to reach ${providerName} (${baseUrl}/models). Check the endpoint and network connection.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parses and validates a model-generated change proposal.
 * This function makes no network requests.
 */
export function parseAndValidateProposal(
  rawContent: string,
  userPrompt: string,
  modelName: string
): AIChangeProposal {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    throw new AIError(
      "invalid_response",
      "Model returned empty or non-string response.",
      { statusCode: 502, provider: "nvidia", model: modelName }
    );
  }

  const byteLength = Buffer.byteLength(rawContent, "utf-8");

  if (byteLength > MAX_MODEL_OUTPUT_BYTES) {
    throw new AIError(
      "invalid_response",
      `Model output exceeds maximum limit of ${MAX_MODEL_OUTPUT_BYTES} bytes.`,
      { statusCode: 502, provider: "nvidia", model: modelName }
    );
  }

  let cleanJson = rawContent.trim();

  // Accept JSON enclosed in a Markdown code block.
  const fencedMatch = cleanJson.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedMatch) {
    cleanJson = fencedMatch[1].trim();
  } else {
    // Tolerate surrounding text only when a JSON object is present.
    const firstBrace = cleanJson.indexOf("{");
    const lastBrace = cleanJson.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleanJson = cleanJson.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: Record<string, unknown>;

  try {
    const value: unknown = JSON.parse(cleanJson);

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Expected a JSON object.");
    }

    parsed = value as Record<string, unknown>;
  } catch {
    throw new AIError(
      "invalid_response",
      "Failed to parse model output as valid JSON proposal.",
      { statusCode: 502, provider: "nvidia", model: modelName }
    );
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
  const potentialRisks =
    typeof parsed.potentialRisks === "string" ? parsed.potentialRisks.trim() : "None noted.";

  const rawExpected =
    typeof parsed.expectedValidationResult === "string"
      ? parsed.expectedValidationResult.toLowerCase()
      : "pass";

  const expectedValidationResult =
    rawExpected === "fail" ? "fail" : rawExpected === "warn" ? "warn" : "pass";

  if (!summary) {
    throw new AIError("invalid_response", "Proposal missing required 'summary' field.", {
      statusCode: 502,
      provider: "nvidia",
      model: modelName,
    });
  }

  if (!reasoning) {
    throw new AIError("invalid_response", "Proposal missing required 'reasoning' field.", {
      statusCode: 502,
      provider: "nvidia",
      model: modelName,
    });
  }

  if (!Array.isArray(parsed.modifications) || parsed.modifications.length === 0) {
    throw new AIError(
      "invalid_response",
      "Model proposal must include at least one modification in 'modifications' array.",
      { statusCode: 502, provider: "nvidia", model: modelName }
    );
  }

  const validatedModifications: ProposedFileModification[] = [];

  for (const entry of parsed.modifications) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AIError("invalid_response", "Invalid modification entry in proposal.", {
        statusCode: 502,
        provider: "nvidia",
        model: modelName,
      });
    }

    const mod = entry as Record<string, unknown>;

    const rawPath = typeof mod.path === "string" ? mod.path.trim() : "";

    if (!rawPath) {
      throw new AIError("invalid_response", "Modification entry missing required 'path'.", {
        statusCode: 502,
        provider: "nvidia",
        model: modelName,
      });
    }

    // Reject traversal and unsafe paths before considering the proposal.
    const safeRelPath = sanitizeRelativePath(rawPath);

    if (!isPermittedFile(safeRelPath)) {
      throw new SecurityError(
        `Proposed path '${safeRelPath}' is prohibited or unsupported by security allowlist.`
      );
    }

    const rawOperation =
      typeof mod.operation === "string" ? mod.operation.toLowerCase() : "modify";

    if (!["create", "modify", "delete"].includes(rawOperation)) {
      throw new AIError("invalid_response", `Unsupported operation for '${safeRelPath}'.`, {
        statusCode: 502,
        provider: "nvidia",
        model: modelName,
      });
    }

    const operation: ProposedFileModification["operation"] =
      rawOperation as ProposedFileModification["operation"];

    const replacementContent =
      typeof mod.replacementContent === "string" ? mod.replacementContent : "";

    if (
      operation !== "delete" &&
      Buffer.byteLength(replacementContent, "utf-8") > MAX_FILE_SIZE_BYTES
    ) {
      throw new AIError(
        "invalid_response",
        `Proposed replacement content for '${safeRelPath}' exceeds maximum file size limit (1MB).`,
        { statusCode: 502, provider: "nvidia", model: modelName }
      );
    }

    const expectedCurrentHash =
      typeof mod.expectedCurrentHash === "string" ? mod.expectedCurrentHash.trim() : undefined;

    const explanation = typeof mod.explanation === "string" ? mod.explanation.trim() : undefined;

    validatedModifications.push({
      path: safeRelPath,
      operation,
      expectedCurrentHash,
      replacementContent,
      explanation,
    });
  }

  return {
    id: `prop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    model: modelName,
    createdAt: new Date().toISOString(),
    userPrompt: userPrompt.trim(),
    summary,
    reasoning,
    modifications: validatedModifications,
    potentialRisks,
    expectedValidationResult,
    status: "pending_approval",
  };
}

/**
 * Generates a proposed change using the configured NVIDIA/Nebius model.
 * Explicitly separates proposal from execution.
 */
export async function generateChangeProposal(
  userPrompt: string,
  contextFiles: { path: string; content: string }[]
): Promise<AIChangeProposal> {
  const config = getAIConfig();
  const { apiKey, model, baseUrl, provider, keyName } = config;

  const providerName = provider === "nvidia" ? "NVIDIA API" : "Nebius Token Factory";

  if (!apiKey) {
    const err = new AIError(
      "authentication_failure",
      `${keyName} is not configured. Add it to .env.local to generate AI proposals.`,
      {
        statusCode: 401,
        provider,
        model,
        suggestion: `Open .env.local and set ${keyName}="your_api_key".`,
      }
    );
    setGenerationResult(provider, model, false, {
      category: err.category,
      message: err.message,
    });
    throw err;
  }

  const systemPrompt = `You are Rewind AI, a software reliability assistant.

Analyze the user's request and propose exact, structured file changes for a sandboxed project.

SECURITY RULES:
1. Only propose changes to these approved paths:
   - agent-workflow.json
   - src/evaluator.ts
   - config/runtime.json
   - README.md
2. Never propose .env files, secrets, credentials, executable binaries, shell scripts, or paths outside the approved list.
3. Never claim that a change was applied. You only propose changes.
4. replacementContent must contain the complete new file content, not a partial diff.
5. Return a single JSON object matching this schema:
{
  "summary": "One-sentence description",
  "reasoning": "Technical rationale",
  "modifications": [
    {
      "path": "approved/relative/path",
      "operation": "modify",
      "replacementContent": "Complete file content",
      "explanation": "What changed"
    }
  ],
  "potentialRisks": "Risk analysis",
  "expectedValidationResult": "pass"
}
6. Return only JSON, without Markdown fences or conversational text.
7. Keep internal reasoning concise. Proceed immediately to generating the complete JSON proposal.`;

  const filesContext = contextFiles
    .map(
      (file) =>
        `--- File: ${file.path} ---\n${file.content}\n--- End of ${file.path} ---`
    )
    .join("\n\n");

  const userMessage = `USER REQUEST:
${userPrompt}

CURRENT WORKSPACE FILES:
${filesContext}

Return the proposed modifications as the exact JSON schema requested.`;

  const completionEndpoint = `${baseUrl}/chat/completions`;
  const timeoutSec = 60;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const payload: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    };

    // For Nemotron models on NVIDIA API, disable thinking loop to achieve sub-3s response time
    if (provider === "nvidia") {
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
        signal: controller.signal,
      });
    } catch (fetchErr: unknown) {
      throw parseFetchError(fetchErr, provider, model, completionEndpoint, timeoutSec);
    }

    // Handle payload format retry if response_format or chat_template_kwargs is unsupported by the model
    if (!response.ok && response.status === 400) {
      const errText = await response.text().catch(() => "");
      if (
        errText.includes("response_format") ||
        errText.includes("json_object") ||
        errText.includes("chat_template_kwargs")
      ) {
        const fallbackPayload = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: 4096,
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
            signal: controller.signal,
          });
        } catch (retryErr: unknown) {
          throw parseFetchError(retryErr, provider, model, completionEndpoint, timeoutSec);
        }
      } else {
        throw new AIError(
          "invalid_payload",
          `Invalid request payload sent to ${providerName} (HTTP 400): ${errText.slice(0, 200)}`,
          { statusCode: 400, provider, model }
        );
      }
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");

      if (response.status === 401 || response.status === 403) {
        throw new AIError(
          "authentication_failure",
          `${providerName} authentication failed (HTTP ${response.status}). Please verify ${keyName} in .env.local.`,
          { statusCode: response.status, provider, model }
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
          ? `The configured model '${model}' does not exist or is not enabled for your account on ${providerName} (HTTP 404). Supported models include 'nvidia/nemotron-3.5-lightning-30b-a3b' or 'nvidia/nemotron-3-super-120b-a12b'.`
          : `${providerName} completion endpoint was not found (HTTP 404): ${completionEndpoint}`;

        throw new AIError("invalid_model", message, {
          statusCode: 404,
          provider,
          model,
          suggestion: `Update ${
            provider === "nvidia" ? "NVIDIA_MODEL" : "NEBIUS_MODEL"
          } in .env.local to a supported active model.`,
        });
      }

      if (response.status === 429) {
        throw new AIError(
          "rate_limit",
          `${providerName} rate limit or quota exceeded (HTTP 429). Please retry in a few moments.`,
          { statusCode: 429, provider, model }
        );
      }

      throw new AIError(
        "provider_error",
        `${providerName} returned HTTP ${response.status}: ${errorText.slice(0, 200)}`,
        { statusCode: response.status, provider, model }
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
        };
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    const message = choice?.message;

    // Handle reasoning models where output may be in content or reasoning_content
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
          `${providerName} reached its maximum token limit while reasoning before completing the proposal. Please make your prompt more specific.`,
          { statusCode: 502, provider, model }
        );
      }

      throw new AIError(
        "invalid_response",
        `${providerName} returned an empty response choice (finish reason: ${
          choice?.finish_reason || "unknown"
        }).`,
        { statusCode: 502, provider, model }
      );
    }

    const proposal = parseAndValidateProposal(rawContent, userPrompt, model);

    // Record verified generation in memory
    setGenerationResult(provider, model, true);

    return proposal;
  } catch (error: unknown) {
    const aiErr =
      error instanceof AIError
        ? error
        : parseFetchError(error, provider, model, completionEndpoint);

    // Record failure in memory
    setGenerationResult(provider, model, false, {
      category: aiErr.category,
      message: aiErr.message,
    });

    throw aiErr;
  } finally {
    clearTimeout(timeout);
  }
}

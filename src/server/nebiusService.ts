import crypto from "node:crypto";
import type {
  AIStatus,
  AIChangeProposal,
  ProposedFileModification,
  AIErrorCategory,
  AIProvider,
} from "../types/ai";
import {
  isPermittedFile,
  sanitizeRelativePath,
  MAX_FILE_SIZE_BYTES,
  SecurityError,
} from "../security/boundaries";
import { AIError, parseFetchError } from "./ai/aiError";
import {
  DEFAULT_NVIDIA_BASE_URL,
  DEFAULT_NVIDIA_MODEL,
  setNvidiaGenerationResult,
  getNvidiaGenerationResult,
  clearNvidiaGenerationResults,
} from "./ai/providers/nvidiaProvider";
import {
  DEFAULT_NEBIUS_BASE_URL,
  DEFAULT_NEBIUS_MODEL,
  setNebiusGenerationResult,
  getNebiusGenerationResult,
  clearNebiusGenerationResults,
} from "./ai/providers/nebiusProvider";
import { getProviderClient, getActiveProvider } from "./ai/providerRegistry";
import type { TokenUsage } from "./ai/providerInterface";

export {
  DEFAULT_NVIDIA_BASE_URL,
  DEFAULT_NVIDIA_MODEL,
  DEFAULT_NEBIUS_BASE_URL,
  DEFAULT_NEBIUS_MODEL,
  AIError,
  parseFetchError,
};
export type { AIProvider };

// Maximum model response size: 500 KiB.
export const MAX_MODEL_OUTPUT_BYTES = 500 * 1024;

export type AIConfig = {
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  keyName: string;
};

export function setGenerationResult(
  provider: AIProvider,
  model: string,
  success: boolean,
  error?: { category: AIErrorCategory; message: string }
) {
  if (provider === "nvidia") {
    setNvidiaGenerationResult(model, success, error);
  } else {
    setNebiusGenerationResult(model, success, error);
  }
}

export function getGenerationResult(
  provider: AIProvider,
  model: string
) {
  if (provider === "nvidia") {
    return getNvidiaGenerationResult(model);
  }
  return getNebiusGenerationResult(model);
}

export function clearGenerationResults() {
  clearNvidiaGenerationResults();
  clearNebiusGenerationResults();
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
  } else if (
    sanitizeEnvVal(process.env.NEBIUS_API_KEY) &&
    !sanitizeEnvVal(process.env.NVIDIA_API_KEY)
  ) {
    provider = "nebius";
  } else {
    provider = "nebius";
  }

  if (provider === "nvidia") {
    return {
      provider,
      apiKey: sanitizeEnvVal(process.env.NVIDIA_API_KEY),
      model: sanitizeEnvVal(process.env.NVIDIA_MODEL) || DEFAULT_NVIDIA_MODEL,
      baseUrl: trimBaseUrl(
        sanitizeEnvVal(process.env.NVIDIA_BASE_URL) || DEFAULT_NVIDIA_BASE_URL
      ),
      keyName: "NVIDIA_API_KEY",
    };
  }

  return {
    provider,
    apiKey: sanitizeEnvVal(process.env.NEBIUS_API_KEY),
    model: sanitizeEnvVal(process.env.NEBIUS_MODEL) || DEFAULT_NEBIUS_MODEL,
    baseUrl: trimBaseUrl(
      sanitizeEnvVal(process.env.NEBIUS_BASE_URL) || DEFAULT_NEBIUS_BASE_URL
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
 * Checks the selected provider's connectivity.
 * Distinguishes between endpoint reachability, credentials, and catalog presence.
 */
export async function checkNebiusStatus(modelName?: string): Promise<AIStatus> {
  const config = getAIConfig();
  const client = getProviderClient(config.provider);
  return client.checkStatus(modelName || config.model);
}

/**
 * Parses and validates a model-generated change proposal.
 * Pure deterministic validation without network requests.
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
      { statusCode: 502, provider: getActiveProvider(), model: modelName }
    );
  }

  const byteLength = Buffer.byteLength(rawContent, "utf-8");

  if (byteLength > MAX_MODEL_OUTPUT_BYTES) {
    throw new AIError(
      "invalid_response",
      `Model output exceeds maximum limit of ${MAX_MODEL_OUTPUT_BYTES} bytes.`,
      { statusCode: 502, provider: getActiveProvider(), model: modelName }
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
      { statusCode: 502, provider: getActiveProvider(), model: modelName }
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
      provider: getActiveProvider(),
      model: modelName,
    });
  }

  if (!reasoning) {
    throw new AIError("invalid_response", "Proposal missing required 'reasoning' field.", {
      statusCode: 502,
      provider: getActiveProvider(),
      model: modelName,
    });
  }

  if (!Array.isArray(parsed.modifications) || parsed.modifications.length === 0) {
    throw new AIError(
      "invalid_response",
      "Model proposal must include at least one modification in 'modifications' array.",
      { statusCode: 502, provider: getActiveProvider(), model: modelName }
    );
  }

  const validatedModifications: ProposedFileModification[] = [];

  for (const entry of parsed.modifications) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AIError("invalid_response", "Invalid modification entry in proposal.", {
        statusCode: 502,
        provider: getActiveProvider(),
        model: modelName,
      });
    }

    const mod = entry as Record<string, unknown>;
    const rawPath = typeof mod.path === "string" ? mod.path.trim() : "";

    if (!rawPath) {
      throw new AIError("invalid_response", "Modification entry missing required 'path'.", {
        statusCode: 502,
        provider: getActiveProvider(),
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
        provider: getActiveProvider(),
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
        { statusCode: 502, provider: getActiveProvider(), model: modelName }
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

export interface ProposalGenerationMeta {
  proposal: AIChangeProposal;
  usage?: TokenUsage;
  latencyMs: number;
  model: string;
  provider: AIProvider;
}

/**
 * Core proposal generation engine with full metadata extraction.
 */
export async function generateChangeProposalWithMeta(
  userPrompt: string,
  contextFiles: { path: string; content: string }[],
  options?: {
    model?: string;
    provider?: AIProvider;
    enableThinking?: boolean;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<ProposalGenerationMeta> {
  const provider = options?.provider || getActiveProvider();
  const client = getProviderClient(provider);
  const model = options?.model || (provider === "nvidia" ? DEFAULT_NVIDIA_MODEL : DEFAULT_NEBIUS_MODEL);

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

  const completion = await client.generateCompletion({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: options?.temperature ?? 0.2,
    maxTokens: options?.maxTokens ?? 4096,
    responseFormat: { type: "json_object" },
    enableThinking: options?.enableThinking,
  });

  const proposal = parseAndValidateProposal(completion.rawContent, userPrompt, completion.model);

  return {
    proposal,
    usage: completion.usage,
    latencyMs: completion.latencyMs,
    model: completion.model,
    provider: client.provider,
  };
}

/**
 * Generates a proposed change using the configured NVIDIA/Nebius model.
 * 100% backward-compatible signature.
 */
export async function generateChangeProposal(
  userPrompt: string,
  contextFiles: { path: string; content: string }[],
  options?: {
    model?: string;
    provider?: AIProvider;
    enableThinking?: boolean;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<AIChangeProposal> {
  const result = await generateChangeProposalWithMeta(userPrompt, contextFiles, options);
  return result.proposal;
}

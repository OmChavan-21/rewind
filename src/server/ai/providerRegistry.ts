/**
 * Provider Registry
 * Provides access to configured AIProviderClient adapters.
 * Determines active provider while maintaining backward compatibility with existing tests.
 */

import type { AIProvider } from "../../types/ai";
import type { AIProviderClient } from "./providerInterface";
import { NvidiaProviderClient } from "./providers/nvidiaProvider";
import { NebiusProviderClient } from "./providers/nebiusProvider";

const nvidiaClient = new NvidiaProviderClient();
const nebiusClient = new NebiusProviderClient();

const disabledClient: AIProviderClient = {
  provider: "disabled",
  baseUrl: "",
  isConfigured: false,
  checkStatus: async () => ({
    state: "unconfigured",
    provider: "disabled",
    model: "disabled",
    baseUrl: "",
    endpointReachable: false,
    credentialsAccepted: false,
    modelListed: false,
    generationVerified: false,
    message: "AI provider is disabled by configuration (AI_PROVIDER=disabled).",
  }),
  listAvailableModels: async () => [],
  generateCompletion: async () => {
    throw new Error("AI provider is disabled by configuration (AI_PROVIDER=disabled). Outbound AI calls are prohibited.");
  },
};

function sanitizeEnv(val?: string): string {
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

/**
 * Checks whether AI capabilities are explicitly disabled.
 */
export function isAIDisabled(): boolean {
  const explicit = sanitizeEnv(process.env.AI_PROVIDER).toLowerCase();
  return explicit === "disabled" || explicit === "none" || explicit === "off";
}

/**
 * Determines the currently active AI provider based on environment configuration.
 * Respects explicit AI_PROVIDER if set, otherwise chooses based on available keys.
 */
export function getActiveProvider(): AIProvider {
  if (isAIDisabled()) {
    return "disabled";
  }

  const explicit = sanitizeEnv(process.env.AI_PROVIDER).toLowerCase();
  if (explicit === "nvidia") {
    return "nvidia";
  }
  if (explicit === "nebius") {
    return "nebius";
  }

  const hasNvidiaKey = Boolean(sanitizeEnv(process.env.NVIDIA_API_KEY));
  const hasNebiusKey = Boolean(sanitizeEnv(process.env.NEBIUS_API_KEY));

  if (hasNvidiaKey && !hasNebiusKey) {
    return "nvidia";
  }
  if (hasNebiusKey && !hasNvidiaKey) {
    return "nebius";
  }

  // If neither key is set, default to nebius for legacy test parity
  return "nebius";
}

/**
 * Returns the client adapter for the requested or currently active provider.
 */
export function getProviderClient(provider?: AIProvider): AIProviderClient {
  const target = provider || getActiveProvider();
  if (target === "disabled") {
    return disabledClient;
  }
  if (target === "nebius") {
    return nebiusClient;
  }
  return nvidiaClient;
}

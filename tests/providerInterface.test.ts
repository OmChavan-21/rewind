import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import { NvidiaProviderClient } from "../src/server/ai/providers/nvidiaProvider";
import { NebiusProviderClient } from "../src/server/ai/providers/nebiusProvider";
import { getActiveProvider, getProviderClient } from "../src/server/ai/providerRegistry";
import {
  MODEL_CATALOG,
  getModelsForProvider,
  getDefaultModelForProvider,
  getModelMetadata,
} from "../src/server/ai/modelCatalog";
import { AIError } from "../src/server/ai/aiError";

describe("Phase 1 & 2 - Shared Provider Interface & Model Catalog Test Suite", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  // ---------------------------------------------------------------------------
  // 1. Model Catalog & Pricing Metadata
  // ---------------------------------------------------------------------------
  it("1. retrieves configured models for NVIDIA and Nebius with capability ratings", () => {
    assert.ok(Object.keys(MODEL_CATALOG).length >= 5);
    const nvidiaModels = getModelsForProvider("nvidia");
    assert.ok(nvidiaModels.length >= 3);
    assert.ok(nvidiaModels.some((m) => m.id === "nvidia/nemotron-3.5-lightning-30b-a3b"));

    const defaultNvidia = getDefaultModelForProvider("nvidia");
    assert.strictEqual(defaultNvidia.id, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.strictEqual(defaultNvidia.tier, "economy");
    assert.strictEqual(defaultNvidia.capabilities.codeGeneration, 8.5);
    assert.strictEqual(defaultNvidia.capabilities.instructionFollowing, 9.0);

    const nebiusModels = getModelsForProvider("nebius");
    assert.ok(nebiusModels.length >= 2);
    assert.ok(nebiusModels.some((m) => m.id === "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF"));
  });

  it("2. marks NVIDIA evaluation rates as unverified and Nebius published rates as verified", () => {
    const nvidiaModel = getModelMetadata("nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia");
    assert.ok(nvidiaModel.pricing);
    // NVIDIA Developer evaluation credits are free/eval, so isVerified is false
    assert.strictEqual(nvidiaModel.pricing.isVerified, false);
    assert.ok(nvidiaModel.pricing.source.includes("NVIDIA NIM"));

    const nebiusModel = getModelMetadata("nvidia/Llama-3.1-Nemotron-70B-Instruct-HF", "nebius");
    assert.ok(nebiusModel.pricing);
    assert.strictEqual(nebiusModel.pricing.isVerified, true);
    assert.ok(nebiusModel.pricing.source.includes("Nebius Token Factory"));
    assert.strictEqual(nebiusModel.pricing.promptTokenCostUSD, 0.0000006);
    assert.strictEqual(nebiusModel.pricing.completionTokenCostUSD, 0.0000018);
  });

  it("3. returns ad-hoc metadata with undefined pricing for unknown models to prevent fabricated costs", () => {
    const adhoc = getModelMetadata("custom/unknown-model-v1", "nvidia");
    assert.strictEqual(adhoc.id, "custom/unknown-model-v1");
    assert.strictEqual(adhoc.pricing, undefined);
  });

  // ---------------------------------------------------------------------------
  // 2. Active Provider Resolution & Inactive Nebius Safety
  // ---------------------------------------------------------------------------
  it("4. defaults to NVIDIA as the active testing provider when NVIDIA_API_KEY is present", () => {
    process.env.NVIDIA_API_KEY = "nv_test_key";
    delete process.env.NEBIUS_API_KEY;
    delete process.env.AI_PROVIDER;

    assert.strictEqual(getActiveProvider(), "nvidia");
    const client = getProviderClient();
    assert.strictEqual(client.provider, "nvidia");
  });

  it("5. keeps Nebius provider client inactive and unconfigured when NEBIUS_API_KEY is absent", async () => {
    delete process.env.NEBIUS_API_KEY;
    const nebius = new NebiusProviderClient();
    assert.strictEqual(nebius.isConfigured, false);

    const status = await nebius.checkStatus();
    assert.strictEqual(status.state, "unconfigured");
    assert.ok(status.message?.includes("NEBIUS_API_KEY is not set"));

    await assert.rejects(
      async () => {
        await nebius.generateCompletion({
          model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
          messages: [{ role: "user", content: "Test" }],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "authentication_failure");
        assert.strictEqual(err.provider, "nebius");
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 3. NVIDIA Client Execution & Token Extraction
  // ---------------------------------------------------------------------------
  it("6. NVIDIA client executes completion and extracts token usage metrics", async () => {
    process.env.NVIDIA_API_KEY = "nv_test_key";
    const client = new NvidiaProviderClient();

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "{\"summary\":\"Test proposal\",\"reasoning\":\"Valid reasoning\",\"modifications\":[{\"path\":\"README.md\",\"operation\":\"modify\",\"replacementContent\":\"# Test\"}]}",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 142,
            completion_tokens: 88,
            total_tokens: 230,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const res = await client.generateCompletion({
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      messages: [{ role: "user", content: "Update readme" }],
    });

    assert.ok(res.rawContent.includes("Test proposal"));
    assert.ok(res.usage !== undefined);
    assert.strictEqual(res.usage?.promptTokens, 142);
    assert.strictEqual(res.usage?.completionTokens, 88);
    assert.strictEqual(res.usage?.totalTokens, 230);
    assert.ok(typeof res.latencyMs === "number" && res.latencyMs >= 0);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import {
  getAIConfig,
  checkNebiusStatus,
  generateChangeProposal,
  AIError,
  setGenerationResult,
  clearGenerationResults,
} from "../src/server/nebiusService";

describe("NVIDIA API Integration & Diagnostics Test Suite", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearGenerationResults();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    clearGenerationResults();
  });

  // Test 1: Provider auto-detection & configuration
  it("1. correctly auto-detects NVIDIA provider and default model", () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key_123";
    delete process.env.NVIDIA_MODEL;
    delete process.env.NVIDIA_BASE_URL;

    const config = getAIConfig();
    assert.strictEqual(config.provider, "nvidia");
    assert.strictEqual(config.apiKey, "test_key_123");
    assert.strictEqual(config.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.strictEqual(config.baseUrl, "https://integrate.api.nvidia.com/v1");
  });

  // Test 2: Status check distinguishes endpoint, credentials, and catalog presence
  it("2. marks status as failed when configured model is missing from account catalog", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key_123";
    process.env.NVIDIA_MODEL = "nvidia/non-existent-model";

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: "nvidia/nemotron-3.5-lightning-30b-a3b" },
            { id: "nvidia/nemotron-3-super-120b-a12b" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const status = await checkNebiusStatus();
    assert.strictEqual(status.endpointReachable, true);
    assert.strictEqual(status.credentialsAccepted, true);
    assert.strictEqual(status.modelListed, false);
    assert.strictEqual(status.state, "failed");
    assert.ok(status.message?.includes("is not in the account catalog"));
    assert.ok(status.message?.includes("nvidia/nemotron-3.5-lightning-30b-a3b"));
  });

  // Test 3: Status check marks connected and tracks generationVerified
  it("3. marks status connected when model is in catalog and tracks generationVerified", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key_123";
    process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    // Before generation
    const statusBefore = await checkNebiusStatus();
    assert.strictEqual(statusBefore.state, "connected");
    assert.strictEqual(statusBefore.modelListed, true);
    assert.strictEqual(statusBefore.generationVerified, false);

    // Record verified generation
    setGenerationResult("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b", true);

    const statusAfter = await checkNebiusStatus();
    assert.strictEqual(statusAfter.state, "connected");
    assert.strictEqual(statusAfter.generationVerified, true);
    assert.ok(statusAfter.message?.includes("Generation verified"));
  });

  // Test 4: Handles 404 model not found as invalid_model with recommendation
  it("4. handles 404 model error with categorized invalid_model AIError", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key_123";
    process.env.NVIDIA_MODEL = "nvidia/obsolete-model";

    globalThis.fetch = async () => {
      return new Response("404 page not found\n", { status: 404 });
    };

    await assert.rejects(
      async () => {
        await generateChangeProposal("Add recovery tool", [
          { path: "agent-workflow.json", content: "{}" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "invalid_model");
        assert.strictEqual(err.statusCode, 404);
        assert.ok(err.suggestion?.includes("Update NVIDIA_MODEL"));
        return true;
      }
    );
  });

  // Test 5: Handles 401 authentication failure with authentication_failure category
  it("5. handles 401 authentication failure with authentication_failure AIError", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "invalid_key";

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
      });
    };

    await assert.rejects(
      async () => {
        await generateChangeProposal("Add recovery tool", [
          { path: "agent-workflow.json", content: "{}" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "authentication_failure");
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );
  });

  // Test 6: Handles 429 rate limit with rate_limit category
  it("6. handles 429 rate limit with rate_limit AIError", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key";

    globalThis.fetch = async () => {
      return new Response("Rate limit exceeded", { status: 429 });
    };

    await assert.rejects(
      async () => {
        await generateChangeProposal("Add recovery tool", [
          { path: "agent-workflow.json", content: "{}" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "rate_limit");
        assert.strictEqual(err.statusCode, 429);
        return true;
      }
    );
  });

  // Test 7: Extracts network error details instead of generic 'fetch failed'
  it("7. extracts network failure cause when fetch throws TypeError", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key";

    globalThis.fetch = async () => {
      const err = new TypeError("fetch failed");
      (err as unknown as { cause: { code: string } }).cause = {
        code: "ECONNREFUSED",
      };
      throw err;
    };

    await assert.rejects(
      async () => {
        await generateChangeProposal("Add recovery tool", [
          { path: "agent-workflow.json", content: "{}" },
        ]);
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "network_error");
        assert.ok(err.message.includes("ECONNREFUSED"));
        assert.strictEqual(err.statusCode, 502);
        return true;
      }
    );
  });

  // Test 8: Successfully parses proposal from reasoning model format
  it("8. successfully parses proposal from reasoning model format", async () => {
    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_key";
    process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

    const mockProposalJson = JSON.stringify({
      summary: "Add telemetry tool to permittedTools",
      reasoning: "Enables telemetry evaluation in the workflow",
      modifications: [
        {
          path: "agent-workflow.json",
          operation: "modify",
          replacementContent: "{\n  \"agentName\": \"TestAgent\"\n}",
          explanation: "Added telemetry tool",
        },
      ],
      potentialRisks: "Low risk",
      expectedValidationResult: "pass",
    });

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: mockProposalJson,
                reasoning_content: "Thinking process: user wants telemetry tool...",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const proposal = await generateChangeProposal("Add telemetry tool", [
      { path: "agent-workflow.json", content: "{}" },
    ]);

    assert.ok(proposal.id.startsWith("prop_"));
    assert.strictEqual(proposal.summary, "Add telemetry tool to permittedTools");
    assert.strictEqual(proposal.modifications.length, 1);
    assert.strictEqual(proposal.modifications[0].path, "agent-workflow.json");
    assert.strictEqual(proposal.expectedValidationResult, "pass");
  });
});

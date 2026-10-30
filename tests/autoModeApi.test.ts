import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { POST as proposeRouteHandler } from "../src/app/api/ai/propose/route";
import { GET as statusRouteHandler } from "../src/app/api/ai/status/route";
import {
  getProjectCreditBalance,
  resetProjectCreditStore,
  checkAndReserveCredits,
  releaseCreditReservation,
  BudgetExceededError,
} from "../src/server/ai/dualAccounting";

describe("Phase 5 & 6: Rewind AI Auto Mode API & Accounting Integration", () => {
  let tempBaseDir: string;
  let testStore: string;
  let originalStoreDir: string | undefined;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof globalThis.fetch;

  const validMockProposal = {
    summary: "Add telemetry tool to permittedTools",
    reasoning: "Improves automated observability",
    modifications: [
      {
        path: "agent-workflow.json",
        operation: "modify",
        replacementContent: "{\n  \"version\": \"1.1.0\"\n}",
        explanation: "Increment version",
      },
    ],
    potentialRisks: "None noted.",
    expectedValidationResult: "pass",
  };

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-automode-test-"));
    testStore = path.join(tempBaseDir, "store");
    fs.mkdirSync(testStore, { recursive: true });

    originalStoreDir = process.env.REWIND_STORE_DIR;
    process.env.REWIND_STORE_DIR = testStore;

    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;

    process.env.AI_PROVIDER = "nvidia";
    process.env.NVIDIA_API_KEY = "test_nvapi_key";
    process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
    process.env.REWIND_FREE_CREDIT_ALLOWANCE = "100";

    resetProjectCreditStore("demo-workspace", testStore);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (originalStoreDir !== undefined) {
      process.env.REWIND_STORE_DIR = originalStoreDir;
    } else {
      delete process.env.REWIND_STORE_DIR;
    }
    globalThis.fetch = originalFetch;

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. Auto mode routes security-sensitive task to high-capability reasoning model
  it("1. Auto mode deterministically routes security-sensitive prompt to reasoning model", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockProposal),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 250, completion_tokens: 120, total_tokens: 370 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update evaluateSafetyPolicy in src/evaluator.ts to raise safetyScore threshold to 0.85",
        mode: "auto",
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(data.proposal);
    assert.strictEqual(data.proposal.summary, validMockProposal.summary);

    // Verify routing metadata
    assert.ok(data.routingMeta);
    assert.strictEqual(data.routingMeta.routing.mode, "auto");
    assert.strictEqual(data.routingMeta.routing.taskClassification.complexity, "security_sensitive");
    assert.strictEqual(data.routingMeta.routing.taskClassification.riskLevel, "high");
    assert.strictEqual(data.routingMeta.routing.selectedModel.id, "nvidia/nemotron-3-super-120b-a12b");
    assert.strictEqual(data.routingMeta.accounting.creditsCharged, 5);

    // Credit allowance was deducted
    assert.strictEqual(data.creditAllowance.usedCredits, 5);
    assert.strictEqual(data.creditAllowance.remainingCredits, 95);
  });

  // 2. Manual mode honors explicit model selection and emits warnings when under-dimensioned
  it("2. Manual mode honors explicit model selection and reports capability warnings", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockProposal),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 90, total_tokens: 270 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Refactor evaluator.ts with safety invariants and permissions boundary overhaul",
        mode: "manual",
        selectedModel: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", // economy model for high-risk task
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.routingMeta.routing.mode, "manual");
    assert.strictEqual(data.routingMeta.routing.selectedModel.id, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");

    // Must include explicit capability warnings
    assert.ok(data.routingMeta.routing.warnings);
    assert.ok(data.routingMeta.routing.warnings.length > 0);
    assert.ok(data.routingMeta.routing.warnings.some((w: string) => w.includes("below recommended threshold")));
  });

  // 3. Manual mode with invalid model returns 400 invalid_model
  it("3. Manual mode with invalid or unconfigured model returns 400 invalid_model", async () => {
    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update README.md",
        mode: "manual",
        selectedModel: "nonexistent/unsupported-model-999",
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 404);

    const data = await res.json();
    assert.strictEqual(data.category, "invalid_model");
    assert.ok(data.error.includes("does not exist or is not enabled"));
  });

  // 4. Backward compatibility with legacy callers passing only { prompt }
  it("4. Backward compatibility: default to auto mode when mode is omitted", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockProposal),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update README.md with license info",
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.routingMeta.routing.mode, "auto");
    assert.strictEqual(data.routingMeta.routing.taskClassification.complexity, "lightweight_analysis");
  });

  // 5. Dual accounting tracks provider cost as estimated for eval tier and notes source
  it("5. Dual accounting tracks provider cost status as estimated for eval tier and separates credits", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockProposal),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update config/runtime.json with cache timeout 30000",
        mode: "auto",
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    const cost = data.routingMeta.costMetrics;
    const credits = data.routingMeta.accounting;

    // Provider cost
    assert.strictEqual(cost.costStatus, "estimated");
    assert.ok(typeof cost.providerCostUSD === "number" && cost.providerCostUSD > 0);
    assert.strictEqual(cost.promptTokens, 1000);
    assert.strictEqual(cost.completionTokens, 500);

    // Rewind Credits (completely separate metric)
    assert.strictEqual(credits.isFreeAllowance, true);
    assert.strictEqual(credits.creditsCharged, 2); // standard_refactor
    assert.strictEqual(credits.unchargedRetries, 0);
  });

  // 6. Credit exhaustion blocks request with 429
  it("6. Credit exhaustion blocks requests with 429 rate_limit when allowance is depleted", async () => {
    // Configure project allowance to 3 credits
    process.env.REWIND_FREE_CREDIT_ALLOWANCE = "3";

    // First request charges 2 credits
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockProposal),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req1 = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update config/runtime.json",
        mode: "auto",
      }),
    });
    const res1 = await proposeRouteHandler(req1);
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    assert.strictEqual(data1.creditAllowance.remainingCredits, 1);

    // Second request requires 2 credits for standard refactor, but only 1 remains -> 429!
    const req2 = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update config/runtime.json again",
        mode: "auto",
      }),
    });
    const res2 = await proposeRouteHandler(req2);
    assert.strictEqual(res2.status, 429);

    const data2 = await res2.json();
    assert.strictEqual(data2.budgetExceeded, true);
    assert.strictEqual(data2.category, "rate_limit");
    assert.ok(data2.error.includes("Budget exceeded for Rewind Credits"));
  });

  // 7. Failed requests charge 0 credits and release reservations
  it("7. Failed provider request charges zero credits and releases in-flight reservation", async () => {
    const balanceBefore = getProjectCreditBalance("demo-workspace", testStore);

    // Mock provider failure (500)
    globalThis.fetch = async () => {
      return new Response("Internal Server Error in NVIDIA Model", { status: 500 });
    };

    const req = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Update agent-workflow.json",
        mode: "auto",
      }),
    });

    const res = await proposeRouteHandler(req);
    assert.strictEqual(res.status, 500);

    const balanceAfter = getProjectCreditBalance("demo-workspace", testStore);
    // Zero credits were deducted
    assert.strictEqual(balanceAfter.used, balanceBefore.used);
    assert.strictEqual(balanceAfter.remaining, balanceBefore.remaining);
    assert.strictEqual(balanceAfter.inFlightReserved, 0);
  });

  // 8. In-flight credit reservations prevent concurrent requests from exceeding allowance
  it("8. In-flight credit reservation prevents concurrent requests from bypassing budget caps", () => {
    const allowance = 5;
    // Request 1 reserves 4 credits -> 1 remaining
    const res1 = checkAndReserveCredits("demo-workspace", 4, allowance, testStore);
    assert.ok(res1.reservationId);
    assert.strictEqual(res1.remainingAfterReserve, 1);

    // Request 2 arrives concurrently and requires 2 credits -> fails immediately!
    assert.throws(
      () => checkAndReserveCredits("demo-workspace", 2, allowance, testStore),
      (err: unknown) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.strictEqual(err.budgetType, "credits");
        return true;
      }
    );

    // Release Request 1 (e.g. failure)
    releaseCreditReservation(res1.reservationId);

    // Now Request 2 can succeed
    const res2 = checkAndReserveCredits("demo-workspace", 2, allowance, testStore);
    assert.ok(res2.reservationId);
    releaseCreditReservation(res2.reservationId);
  });

  // 9. Validation & input limits: rejects prompt exceeding 3000 chars or empty prompt
  it("9. Rejects empty prompts and prompts exceeding 3000 character limit", async () => {
    // Empty prompt
    const reqEmpty = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    const resEmpty = await proposeRouteHandler(reqEmpty);
    assert.strictEqual(resEmpty.status, 400);

    // Oversized prompt (>3000 chars)
    const longPrompt = "a".repeat(3001);
    const reqLong = new Request("http://localhost:3000/api/ai/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: longPrompt }),
    });
    const resLong = await proposeRouteHandler(reqLong);
    assert.strictEqual(resLong.status, 400);
    const dataLong = await resLong.json();
    assert.strictEqual(dataLong.category, "invalid_payload");
    assert.ok(dataLong.error.includes("3000 characters"));
  });

  // 10. GET /api/ai/status exposes provider, models, supported modes, and credit allowance
  it("10. GET /api/ai/status returns available models, provider, modes, and credit allowance without secrets", async () => {
    // Mock status endpoint models check
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

    const req = new Request("http://localhost:3000/api/ai/status?projectId=demo-workspace");
    const res = await statusRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.provider, "nvidia");
    assert.ok(Array.isArray(data.availableModels));
    assert.ok(data.availableModels.length >= 3);
    assert.deepStrictEqual(data.supportedModes, ["auto", "manual"]);

    // Credit allowance
    assert.ok(data.creditAllowance);
    assert.strictEqual(data.creditAllowance.totalAllowance, 100);
    assert.strictEqual(typeof data.creditAllowance.remainingCredits, "number");
    assert.ok(data.creditAllowance.schedule);

    // Verify secrets are NOT exposed
    const rawJson = JSON.stringify(data);
    assert.strictEqual(rawJson.includes("test_nvapi_key"), false);
    assert.strictEqual(rawJson.includes("apiKey"), false);
  });

  it("11. Nebius health check uses the catalog default instead of a stale configured model", async () => {
    process.env.AI_PROVIDER = "nebius";
    process.env.NEBIUS_API_KEY = "test_nebius_key";
    process.env.NEBIUS_MODEL = "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF";
    globalThis.fetch = async () => new Response(
      JSON.stringify({ data: [{ id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    const req = new Request("http://localhost:3000/api/ai/status?projectId=demo-workspace");
    const res = await statusRouteHandler(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.provider, "nebius");
    assert.strictEqual(data.status.model, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    assert.strictEqual(data.status.state, "connected");
  });
});

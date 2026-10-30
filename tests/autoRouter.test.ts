import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import { classifyTask } from "../src/server/ai/taskClassifier";
import { routeTask } from "../src/server/ai/autoRouter";
import {
  calculateProviderCost,
  accountTaskExecution,
  checkBudgetCaps,
  BudgetExceededError,
  clearTaskLedger,
  getCreditSchedule,
} from "../src/server/ai/dualAccounting";
import { getModelMetadata } from "../src/server/ai/modelCatalog";
import { AIError } from "../src/server/ai/aiError";

describe("Phase 3 & 4 - Task Classifier, Auto Router & Dual Accounting Test Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearTaskLedger();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearTaskLedger();
  });

  // ---------------------------------------------------------------------------
  // 1. Task Classifier Tests (Deterministic Heuristics)
  // ---------------------------------------------------------------------------
  it("1. classifies security-sensitive tasks targeting evaluator or safety invariants as high risk", () => {
    const classification = classifyTask(
      "Update 'src/evaluator.ts' to raise the minimum safetyScore threshold to 0.85 in evaluateSafetyPolicy.",
      [{ path: "src/evaluator.ts", content: "export function evaluateSafetyPolicy() {}" }]
    );

    assert.strictEqual(classification.complexity, "security_sensitive");
    assert.strictEqual(classification.riskLevel, "high");
    assert.ok(classification.targetPaths.includes("src/evaluator.ts"));
    assert.ok(classification.rationale.includes("evaluator.ts"));
  });

  it("2. classifies complex multi-file or architectural refactoring tasks as complex_code_modification", () => {
    const classification = classifyTask(
      "Refactor state machine and overhaul the pipeline in agent-workflow.json and config/runtime.json",
      [
        { path: "agent-workflow.json", content: "{}" },
        { path: "config/runtime.json", content: "{}" },
      ]
    );

    assert.strictEqual(classification.complexity, "complex_code_modification");
    assert.strictEqual(classification.riskLevel, "medium");
    assert.ok(classification.targetPaths.length >= 2);
  });

  it("3. classifies standard single-file tool/version modifications as standard_refactor", () => {
    const classification = classifyTask(
      "Update 'agent-workflow.json' to increment version to 1.2.0 and add 'telemetry' to permittedTools.",
      [{ path: "agent-workflow.json", content: "{}" }]
    );

    assert.strictEqual(classification.complexity, "standard_refactor");
    assert.strictEqual(classification.riskLevel, "medium");
    assert.ok(classification.targetPaths.includes("agent-workflow.json"));
  });

  it("4. classifies pure conceptual queries as simple_explanation with low risk", () => {
    const classification = classifyTask(
      "Explain how the Rewind deterministic recovery snapshot mechanism works.",
      []
    );

    assert.strictEqual(classification.complexity, "simple_explanation");
    assert.strictEqual(classification.riskLevel, "low");
    assert.strictEqual(classification.targetPaths.length, 0);
  });

  it("5. classifies README documentation changes as lightweight_analysis with low risk", () => {
    const classification = classifyTask(
      "Update README.md to fix a typo and add documentation for the new CLI command.",
      [{ path: "README.md", content: "# Rewind" }]
    );

    assert.strictEqual(classification.complexity, "lightweight_analysis");
    assert.strictEqual(classification.riskLevel, "low");
    assert.ok(classification.targetPaths.includes("README.md"));
  });

  // ---------------------------------------------------------------------------
  // 2. Auto Router Model Selection & Provider Safety
  // ---------------------------------------------------------------------------
  it("6. routes simple explanation and lightweight analysis to least expensive economy model", () => {
    process.env.NVIDIA_API_KEY = "test_key";
    delete process.env.AI_PROVIDER;

    const decision = routeTask("What is the system design of the recovery engine?", []);

    assert.strictEqual(decision.mode, "auto");
    assert.strictEqual(decision.selectedProvider, "nvidia");
    assert.strictEqual(decision.selectedModel.tier, "economy");
    assert.strictEqual(decision.selectedModel.id, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    assert.ok(decision.routingReason.includes("minimizing cost"));
  });

  it("7. routes security-sensitive task to high-capability reasoning model", () => {
    process.env.NVIDIA_API_KEY = "test_key";
    delete process.env.AI_PROVIDER;

    const decision = routeTask(
      "Modify src/evaluator.ts to adjust invariant securityScore policy.",
      [{ path: "src/evaluator.ts", content: "code" }]
    );

    assert.strictEqual(decision.mode, "auto");
    assert.strictEqual(decision.selectedProvider, "nvidia");
    // Should select Nemotron 3 Super (premium/reasoning capability score >= 9.0)
    assert.strictEqual(decision.selectedModel.id, "nvidia/nemotron-3-super-120b-a12b");
    assert.strictEqual(decision.selectedModel.tier, "premium");
    assert.ok(decision.routingReason.includes("security_sensitive"));
  });

  it("8. supports manual model selection and warns if manually chosen model is under-dimensioned", () => {
    process.env.NVIDIA_API_KEY = "test_key";

    // Manually picking economy model for security-sensitive task
    const decision = routeTask(
      "Modify src/evaluator.ts to change security threshold.",
      [{ path: "src/evaluator.ts", content: "code" }],
      {
        mode: "manual",
        manualModelId: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      }
    );

    assert.strictEqual(decision.mode, "manual");
    assert.strictEqual(decision.selectedModel.id, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    assert.ok(decision.warnings && decision.warnings.length > 0);
    assert.ok(decision.warnings[0].includes("below recommended threshold"));
  });

  it("9. prevents unapproved provider switching when manual provider is unconfigured", () => {
    process.env.NVIDIA_API_KEY = "test_nv_key";
    delete process.env.NEBIUS_API_KEY;

    assert.throws(
      () => {
        routeTask("Test task", [], {
          mode: "manual",
          manualProvider: "nebius",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AIError);
        assert.strictEqual(err.category, "authentication_failure");
        assert.ok(err.message.includes("Nebius provider is not configured"));
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Dual Accounting: Provider Cost vs Rewind Credits
  // ---------------------------------------------------------------------------
  it("10. estimates provider cost from reported usage and verified published pricing", () => {
    const nebiusModel = getModelMetadata("nvidia/Llama-3.1-Nemotron-70B-Instruct-HF", "nebius");
    const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };

    const costRecord = calculateProviderCost(nebiusModel, usage);
    assert.strictEqual(costRecord.costStatus, "estimated");
    // (1000 * 0.0000006) + (500 * 0.0000018) = 0.0006 + 0.0009 = 0.0015 USD
    assert.strictEqual(costRecord.providerCostUSD, 0.0015);
    assert.strictEqual(costRecord.promptTokens, 1000);
    assert.strictEqual(costRecord.completionTokens, 500);
  });

  it("11. marks evaluation tier rates as estimated and missing pricing as unavailable", () => {
    const nvidiaModel = getModelMetadata("nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia");
    const usage = { promptTokens: 500, completionTokens: 200, totalTokens: 700 };

    // NVIDIA free developer evaluation tier -> estimated
    const evalCost = calculateProviderCost(nvidiaModel, usage);
    assert.strictEqual(evalCost.costStatus, "estimated");
    assert.ok(evalCost.providerCostUSD !== null && evalCost.providerCostUSD > 0);

    // Ad-hoc model without pricing metadata -> unavailable
    const unpricedModel = getModelMetadata("custom/unpriced", "nvidia");
    const unpricedCost = calculateProviderCost(unpricedModel, usage);
    assert.strictEqual(unpricedCost.costStatus, "unavailable");
    assert.strictEqual(unpricedCost.providerCostUSD, null);
  });

  it("12. accounts Rewind credits per completed task and never double-charges for retries", () => {
    const model = getModelMetadata("nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia");
    const schedule = getCreditSchedule();

    const res = accountTaskExecution({
      taskId: "task_123",
      complexity: "standard_refactor",
      model,
      outcome: "success",
      usage: { promptTokens: 400, completionTokens: 250, totalTokens: 650 },
      retries: 2, // 2 internal retries were performed
    });

    assert.strictEqual(res.isDuplicate, false);
    // Standard refactor is 2 credits; retries do NOT multiply charge
    assert.strictEqual(res.creditAccounting.creditsCharged, schedule.standard_refactor);
    assert.strictEqual(res.creditAccounting.unchargedRetries, 2);
    assert.ok(res.creditAccounting.creditPolicy.includes("Internal retries (2) not charged"));
  });

  it("13. charges zero credits for provider errors or timeouts", () => {
    const model = getModelMetadata("nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia");

    const res = accountTaskExecution({
      taskId: "task_err_1",
      complexity: "security_sensitive",
      model,
      outcome: "provider_error",
    });

    assert.strictEqual(res.creditAccounting.creditsCharged, 0);
    assert.ok(res.creditAccounting.creditPolicy.includes("No credits charged"));
  });

  it("14. avoids duplicate credit deductions when accounting identical task ID", () => {
    const model = getModelMetadata("nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia");

    const first = accountTaskExecution({
      taskId: "task_dup_1",
      complexity: "lightweight_analysis",
      model,
      outcome: "success",
    });
    assert.strictEqual(first.isDuplicate, false);
    assert.strictEqual(first.creditAccounting.creditsCharged, 1);

    const second = accountTaskExecution({
      taskId: "task_dup_1",
      complexity: "lightweight_analysis",
      model,
      outcome: "success",
    });
    assert.strictEqual(second.isDuplicate, true);
    assert.strictEqual(second.creditAccounting.creditsCharged, 1);
  });

  // ---------------------------------------------------------------------------
  // 4. Budget Cap Enforcement
  // ---------------------------------------------------------------------------
  it("15. rejects task if required credits exceed configured credit budget", () => {
    process.env.NVIDIA_API_KEY = "test_key";
    const decision = routeTask("Update evaluator to raise security threshold", [
      { path: "src/evaluator.ts", content: "code" },
    ]);

    // Security sensitive requires 5 credits; budget limit is 3
    assert.throws(
      () => {
        checkBudgetCaps(decision, { maxCredits: 3 });
      },
      (err: unknown) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.strictEqual(err.budgetType, "credits");
        assert.strictEqual(err.limit, 3);
        return true;
      }
    );
  });
});

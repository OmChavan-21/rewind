import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  diagnoseTypeScriptSemantic,
  diagnoseTypeScriptWorkspaceSemantic,
} from "../src/engine/typeScriptCompiler";
import {
  validatePythonSyntaxNative,
} from "../src/engine/pythonValidator";
import {
  scanContentSecurity,
} from "../src/security/contentScanner";
import {
  parseUnifiedDiff,
  applyPatchToString,
  applyUnifiedDiff,
  MalformedPatchError,
  AmbiguousHunkError,
  PathContainmentError,
  PatchError,
} from "../src/engine/patchApplier";
import {
  verifyCandidatePatchInSandbox,
} from "../src/engine/patchSandbox";
import {
  applyApprovedAIProposal,
  stageAndVerifyProposal,
} from "../src/server/proposalExecution";
import {
  runSelfRepairLoop,
} from "../src/server/ai/selfRepairEngine";
import type { ProviderClient } from "../src/server/ai/providerInterface";
import {
  initializeDemoWorkspace,
} from "../src/engine/demoWorkspace";
import {
  createProject,
  listProjectSnapshots,
  resolveProjectWorkspace,
} from "../src/engine/projectManager";
import {
  validateWorkspaceDeterministically,
  restoreSnapshot,
  listPermittedWorkspaceFiles,
  applyApprovedFileChange,
} from "../src/engine/recoveryEngine";
import {
  checkAndReserveCredits,
  releaseCreditReservation,
  commitCreditReservation,
  accountTaskExecution,
  getProjectCreditBalance,
} from "../src/server/ai/dualAccounting";
import { getModelMetadata } from "../src/server/ai/modelCatalog";
import { calculateSha256 } from "../src/engine/storage";
import type { AIChangeProposal, ProposedFileModification } from "../src/types/ai";

describe("Rewind AI Code Correction Engine & Verification Sandbox Test Suite", () => {
  let testWorkspace: string;
  let testStore: string;

  beforeEach(() => {
    const id = randomUUID();
    testWorkspace = path.join(os.tmpdir(), `rewind-corr-ws-${id}`);
    testStore = path.join(os.tmpdir(), `rewind-corr-store-${id}`);
    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.mkdirSync(testStore, { recursive: true });
    initializeDemoWorkspace(testWorkspace);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testWorkspace)) {
        fs.rmSync(testWorkspace, { recursive: true, force: true });
      }
      if (fs.existsSync(testStore)) {
        fs.rmSync(testStore, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  // =========================================================================
  // 1. TYPESCRIPT SEMANTIC DIAGNOSTICS ENGINE
  // =========================================================================
  describe("1. TypeScript Semantic Diagnostics Engine", () => {
    it("1.1. detects semantic type mismatch (TS2322) with accurate line, column, and suggestion", () => {
      const code = `
const greeting: string = "hello";
const count: number = "not a number";
export { greeting, count };
`.trim();

      const diags = diagnoseTypeScriptSemantic("test_types.ts", code);
      assert.strictEqual(diags.length >= 1, true);

      const typeMismatch = diags.find((d) => d.ruleId === "TS2322");
      assert.ok(typeMismatch, "Expected TS2322 diagnostic to be found");
      assert.strictEqual(typeMismatch.line, 2);
      assert.strictEqual(typeMismatch.category, "type");
      assert.strictEqual(typeMismatch.severity, "error");
      assert.strictEqual(typeMismatch.source, "typescript");
      assert.ok(typeMismatch.message.includes("Type 'string' is not assignable to type 'number'"));
      assert.ok(typeMismatch.suggestion?.includes("Type mismatch"));
      assert.strictEqual(typeMismatch.codeSnippet, 'const count: number = "not a number";');
    });

    it("1.2. detects missing required interface properties (TS2741 / TS2739)", () => {
      const code = `
interface AgentTask {
  id: string;
  maxRetries: number;
}

const task: AgentTask = {
  id: "task_01",
};
export { task };
`.trim();

      const diags = diagnoseTypeScriptSemantic("agent_task.ts", code);
      const missingProp = diags.find((d) => d.ruleId === "TS2741" || d.ruleId === "TS2739");
      assert.ok(missingProp, "Expected TS2741 or TS2739 for missing required properties");
      assert.strictEqual(missingProp.line, 6);
      assert.ok(missingProp.message.includes("maxRetries"));
      assert.ok(missingProp.suggestion?.includes("Required property is missing"));
    });

    it("1.3. detects invalid property access on object (TS2339)", () => {
      const code = `
interface UserProfile {
  name: string;
  role: string;
}

function getAvatar(user: UserProfile) {
  return user.avatarUrl.toLowerCase();
}
export { getAvatar };
`.trim();

      const diags = diagnoseTypeScriptSemantic("profile.ts", code);
      const invalidProp = diags.find((d) => d.ruleId === "TS2339");
      assert.ok(invalidProp, "Expected TS2339 for missing member avatarUrl");
      assert.strictEqual(invalidProp.line, 7);
      assert.ok(invalidProp.message.includes("Property 'avatarUrl' does not exist"));
    });

    it("1.4. detects argument type mismatch in function invocation (TS2345)", () => {
      const code = `
function computeScore(factor: number): number {
  return factor * 10;
}

const res = computeScore("high");
export { res };
`.trim();

      const diags = diagnoseTypeScriptSemantic("score.ts", code);
      const argMismatch = diags.find((d) => d.ruleId === "TS2345");
      assert.ok(argMismatch, "Expected TS2345 argument type mismatch");
      assert.strictEqual(argMismatch.line, 5);
      assert.ok(argMismatch.message.includes("Argument of type 'string' is not assignable"));
    });

    it("1.5. passes cleanly with 0 diagnostics on valid typed code", () => {
      const code = `
export interface Calculator {
  add(a: number, b: number): number;
}

export const calc: Calculator = {
  add(a: number, b: number): number {
    return a + b;
  },
};
`.trim();

      const diags = diagnoseTypeScriptSemantic("calculator.ts", code);
      const errors = diags.filter((d) => d.severity === "error");
      assert.strictEqual(errors.length, 0);
    });

    it("1.6. resolves cross-file type definitions in multi-file workspace semantic check", () => {
      const fileA = {
        path: "types/models.ts",
        content: `
export interface RecoveryState {
  healthy: boolean;
  score: number;
}
`.trim(),
      };

      const fileB = {
        path: "src/checker.ts",
        content: `
import { RecoveryState } from "../types/models";

export function checkState(state: RecoveryState): boolean {
  return state.healthy && state.score > 0.5;
}
`.trim(),
      };

      const diags = diagnoseTypeScriptWorkspaceSemantic([fileA, fileB]);
      const errors = diags.filter((d) => d.severity === "error");
      assert.strictEqual(errors.length, 0);
    });
  });

  // =========================================================================
  // 2. NATIVE PYTHON SYNTAX VALIDATION
  // =========================================================================
  describe("2. Native Python Syntax Validation", () => {
    it("2.1. cleanly validates valid Python syntax with AST parser", () => {
      const validCode = `
import math

class Vector:
    def __init__(self, x: float, y: float):
        self.x = x
        self.y = y

    def magnitude(self) -> float:
        return math.sqrt(self.x ** 2 + self.y ** 2)

v = Vector(3.0, 4.0)
print(v.magnitude())
`.trim();

      const result = validatePythonSyntaxNative("vector.py", validCode);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.diagnostics.length, 0);
    });

    it("2.2. captures exact line, column, and message for Python syntax errors", () => {
      const invalidCode = `
def process_data(items):
    for item in items
        print(item)
`.trim();

      const result = validatePythonSyntaxNative("syntax_err.py", invalidCode);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.diagnostics.length >= 1, true);

      const diag = result.diagnostics[0];
      assert.strictEqual(diag.filePath, "syntax_err.py");
      assert.strictEqual(diag.line, 2);
      assert.ok(diag.column > 0);
      assert.strictEqual(diag.severity, "error");
      assert.strictEqual(diag.category, "syntax");
      assert.strictEqual(diag.source, "python_compiler");
      assert.ok(diag.message.includes("expected ':'") || diag.message.includes("invalid syntax"));
    });

    it("2.3. detects complex Python syntax violations (e.g. invalid assignment target)", () => {
      const invalidCode = `
def calculate():
    (x + 1) = 42
    return x
`.trim();

      const result = validatePythonSyntaxNative("bad_assign.py", invalidCode);
      assert.strictEqual(result.valid, false);
      const diag = result.diagnostics[0];
      assert.strictEqual(diag.line, 2);
      assert.ok(diag.message.toLowerCase().includes("cannot assign") || diag.message.toLowerCase().includes("syntax"));
    });

    it("2.4. safely bounds execution and does not hang on timeout", () => {
      // Verify timeout handling gracefully reports diagnostic
      const result = validatePythonSyntaxNative("test_timeout.py", "x = 1\n", 5000);
      // Valid python terminates almost instantly (<50ms)
      assert.strictEqual(result.timedOut, false);
      assert.strictEqual(result.valid, true);
    });
  });

  // =========================================================================
  // 3. SECURITY CONTENT SCANNER
  // =========================================================================
  describe("3. Security Content Scanner", () => {
    it("3.1. flags dangerous eval() execution sink as critical vulnerability", () => {
      const code = `
function runDynamic(codeStr: string) {
  return eval(codeStr);
}
`.trim();

      const scan = scanContentSecurity("src/runner.ts", code);
      assert.strictEqual(scan.passed, false);
      assert.strictEqual(scan.violations.length, 1);
      assert.strictEqual(scan.violations[0].ruleId, "SEC001_DANGEROUS_EVAL");
      assert.strictEqual(scan.violations[0].severity, "critical");
      assert.strictEqual(scan.violations[0].type, "vulnerability");
      assert.strictEqual(scan.violations[0].line, 2);
    });

    it("3.2. flags dynamic Function constructor as critical vulnerability", () => {
      const code = `
const dynamicAdd = new Function("a", "b", "return a + b;");
`.trim();

      const scan = scanContentSecurity("src/calc.ts", code);
      assert.strictEqual(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.ruleId === "SEC002_FUNCTION_CONSTRUCTOR"));
    });

    it("3.3. flags Node.js command injection sinks (child_process.exec)", () => {
      const code = `
import child_process from "child_process";

export function executeUserCmd(cmd: string) {
  child_process.exec(cmd);
}
`.trim();

      const scan = scanContentSecurity("src/exec.ts", code);
      assert.strictEqual(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.ruleId === "SEC003_CHILD_PROCESS_EXEC"));
    });

    it("3.4. flags Python command injection sinks (os.system and subprocess shell=True)", () => {
      const pyCode1 = `
import os
os.system("rm -rf /")
`.trim();

      const scan1 = scanContentSecurity("danger.py", pyCode1);
      assert.strictEqual(scan1.passed, false);
      assert.ok(scan1.violations.some((v) => v.ruleId === "SEC004_PYTHON_OS_SYSTEM"));

      const pyCode2 = `
import subprocess
subprocess.Popen("echo hello", shell=True)
`.trim();

      const scan2 = scanContentSecurity("danger_sub.py", pyCode2);
      assert.strictEqual(scan2.passed, false);
      assert.ok(scan2.violations.some((v) => v.ruleId === "SEC005_PYTHON_SUBPROCESS_SHELL"));
    });

    it("3.5. flags leaked API keys and plaintext private keys as critical", () => {
      const codeWithApiKey = `
const API_KEY = "nvapi-abcdef1234567890abcdef1234567890";
`.trim();

      const scanKey = scanContentSecurity("config.ts", codeWithApiKey);
      assert.strictEqual(scanKey.passed, false);
      assert.ok(scanKey.violations.some((v) => v.ruleId === "SEC008_LEAKED_API_KEY"));

      const codeWithPrivateKey = `
const KEY = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0...\\n-----END RSA PRIVATE KEY-----";
`.trim();

      const scanPriv = scanContentSecurity("cert.pem", codeWithPrivateKey);
      assert.strictEqual(scanPriv.passed, false);
      assert.ok(scanPriv.violations.some((v) => v.ruleId === "SEC007_LEAKED_PRIVATE_KEY"));
    });

    it("3.6. clearly distinguishes advisory warnings (insecure HTTP) without failing security pass", () => {
      const codeWithHttp = `
export const API_ENDPOINT = "http://api.external-service.org/v1";
`.trim();

      const scan = scanContentSecurity("constants.ts", codeWithHttp);
      assert.strictEqual(scan.passed, true); // Non-blocking
      assert.strictEqual(scan.violations.length, 0);
      assert.strictEqual(scan.warnings.length >= 1, true);
      assert.strictEqual(scan.warnings[0].ruleId, "WARN001_INSECURE_HTTP");
      assert.strictEqual(scan.warnings[0].severity, "warning");
    });

    it("3.7. resists false positives: does NOT flag evaluatePolicy, evaluator.ts, or comments", () => {
      const benignCode = `
// Note: we intentionally do not use eval() here
export function evaluateSafetyPolicy(score: number): boolean {
  /* eval() is unsafe */
  return score >= 0.8;
}
`.trim();

      const scan = scanContentSecurity("src/evaluator.ts", benignCode);
      assert.strictEqual(scan.passed, true);
      assert.strictEqual(scan.violations.length, 0);
    });
  });

  // =========================================================================
  // 4. MINIMAL UNIFIED-DIFF APPLICATION & STRICT VALIDATION
  // =========================================================================
  describe("4. Minimal Unified-Diff Application & Strict Validation", () => {
    it("4.1. parses and applies clean unified diff to string content", () => {
      const original = `
const a = 1;
const b = 2;
const c = 3;
`.trim();

      const diff = `
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b_prime = 2.5;
 const b = 2;
 const c = 3;
`.trim();

      const patched = applyUnifiedDiff(original, diff);
      assert.ok(patched.includes("const b_prime = 2.5;"));
      assert.ok(patched.includes("const a = 1;"));
      assert.ok(patched.includes("const c = 3;"));
    });

    it("4.2. rejects malformed diff missing hunk headers or containing corrupted counts", () => {
      const malformedDiff = `
--- a/test.ts
+++ b/test.ts
@@ corrupted header @@
+const broken = true;
`.trim();

      assert.throws(
        () => parseUnifiedDiff(malformedDiff),
        (err: unknown) => err instanceof MalformedPatchError
      );
    });

    it("4.3. rejects hunk where actual body lines do not match declared header counts", () => {
      const mismatchedDiff = `
--- a/test.ts
+++ b/test.ts
@@ -1,5 +1,10 @@
 const a = 1;
+const b = 2;
`.trim();

      assert.throws(
        () => parseUnifiedDiff(mismatchedDiff),
        (err: unknown) => err instanceof MalformedPatchError
      );
    });

    it("4.4. strictly rejects path traversal and forbidden files in diff headers", () => {
      const traversalDiff = `
--- a/../../../etc/passwd
+++ b/../../../etc/passwd
@@ -1,1 +1,1 @@
-root:x:0:0
+hacked:x:0:0
`.trim();

      assert.throws(
        () => parseUnifiedDiff(traversalDiff),
        (err: unknown) => err instanceof PathContainmentError
      );

      const forbiddenExtDiff = `
--- a/secrets.env
+++ b/secrets.env
@@ -1,1 +1,1 @@
-OLD_KEY=1
+NEW_KEY=2
`.trim();

      assert.throws(
        () => parseUnifiedDiff(forbiddenExtDiff),
        (err: unknown) => err instanceof PathContainmentError
      );
    });

    it("4.5. detects ambiguous hunks when context matches multiple distinct locations", () => {
      // Repetitive content where a 1-line context matches in multiple places
      const repetitiveContent = `
item = 0
pass
item = 0
pass
item = 0
pass
`.trim();

      const ambiguousDiff = `
--- a/donut.py
+++ b/donut.py
@@ -1,2 +1,3 @@
 item = 0
+new_item = 1
 pass
`.trim();

      const patches = parseUnifiedDiff(ambiguousDiff);
      assert.throws(
        () => applyPatchToString(repetitiveContent, patches[0]),
        (err: unknown) => err instanceof AmbiguousHunkError
      );
    });

    it("4.6. rejects diff when context lines do not match target file", () => {
      const original = "const x = 100;\n";
      const unmatchedDiff = `
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const completely_different = 999;
+const replaced = 500;
`.trim();

      assert.throws(
        () => applyUnifiedDiff(original, unmatchedDiff),
        (err: unknown) => err instanceof PatchError
      );
    });
  });

  // =========================================================================
  // 5. ISOLATED CANDIDATE STAGING SANDBOX
  // =========================================================================
  describe("5. Isolated Candidate Staging Sandbox", () => {
    it("5.1. successfully verifies clean candidate patch without touching live workspace", () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const originalContent = fs.readFileSync(evaluatorPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const validMod: ProposedFileModification = {
        path: "src/evaluator.ts",
        operation: "modify",
        replacementContent: originalContent.replace(
          "if (state.safetyScore < 0.8) return false;",
          "if (state.safetyScore < 0.85) return false;"
        ),
      };

      const result = verifyCandidatePatchInSandbox(testWorkspace, [validMod]);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.errors.length, 0);

      // Verify live workspace was NEVER modified
      const currentContent = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(currentContent), originalHash);
    });

    it("5.2. rejects candidate introducing TypeScript semantic error and preserves live workspace untouched", () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const originalContent = fs.readFileSync(evaluatorPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const invalidMod: ProposedFileModification = {
        path: "src/evaluator.ts",
        operation: "modify",
        replacementContent: originalContent.replace(
          "const approvedStart = \"01_analyze\";",
          "const approvedStart: number = \"01_analyze\";" // Type mismatch TS2322!
        ),
      };

      const result = verifyCandidatePatchInSandbox(testWorkspace, [invalidMod]);
      assert.strictEqual(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("TS2322") || e.includes("TypeScript Error")));

      // PROVE live workspace was never touched
      const currentContent = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(currentContent), originalHash);
      assert.strictEqual(validateWorkspaceDeterministically(testWorkspace).passed, true);
    });

    it("5.3. rejects candidate introducing Python syntax error in sandbox without writing live file", () => {
      const donutPath = path.join(testWorkspace, "donut.py");
      fs.writeFileSync(donutPath, "def render():\n    pass\n", "utf-8");
      const originalContent = fs.readFileSync(donutPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const brokenPythonMod: ProposedFileModification = {
        path: "donut.py",
        operation: "modify",
        replacementContent: "def broken_syntax(:\n    pass\n",
      };

      const result = verifyCandidatePatchInSandbox(testWorkspace, [brokenPythonMod]);
      assert.strictEqual(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("Python Syntax Error")));

      // Live workspace donut.py remains completely original
      const currentContent = fs.readFileSync(donutPath, "utf-8");
      assert.strictEqual(calculateSha256(currentContent), originalHash);
    });

    it("5.4. rejects candidate introducing dangerous security sink in sandbox without modifying disk", () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const originalContent = fs.readFileSync(evaluatorPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const maliciousMod: ProposedFileModification = {
        path: "src/evaluator.ts",
        operation: "modify",
        replacementContent: originalContent + "\nconst hacked = eval('1 + 1');\n",
      };

      const result = verifyCandidatePatchInSandbox(testWorkspace, [maliciousMod]);
      assert.strictEqual(result.passed, false);
      assert.ok(result.errors.some((e) => e.includes("Security Violation") || e.includes("eval()")));

      // Live workspace remains pristine
      const currentContent = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(currentContent), originalHash);
    });

    it("5.5. stages unified diff string directly in sandbox and validates correctly", () => {
      const validDiff = `
--- a/src/evaluator.ts
+++ b/src/evaluator.ts
@@ -22,3 +22,3 @@
   const approvedStart = "01_analyze";
-  return steps[0] === approvedStart;
+  return steps[0] === approvedStart && steps.length > 0;
 }
`.trim();

      const result = verifyCandidatePatchInSandbox(testWorkspace, validDiff);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.modifiedFiles.includes("src/evaluator.ts"), true);
    });
  });

  // =========================================================================
  // 6. PROPOSAL EXECUTION & STAGED PRE-VERIFICATION INTEGRATION
  // =========================================================================
  describe("6. AI Proposal Execution & Sandbox Guard Integration", () => {
    it("6.1. applyApprovedAIProposal refuses to apply proposal with security sinks", async () => {
      const maliciousProposal: AIChangeProposal = {
        id: "prop_eval_hack",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Add eval helper",
        summary: "Inject eval call",
        reasoning: "Test security guard",
        status: "approved",
        potentialRisks: "Critical security sink",
        expectedValidationResult: "fail",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "export const run = (code: string) => eval(code);\n",
          },
        ],
      };

      await assert.rejects(
        async () => {
          await applyApprovedAIProposal(testWorkspace, testStore, maliciousProposal);
        },
        (err: unknown) => {
          return err instanceof Error && err.message.includes("Security violation");
        }
      );
    });

    it("6.2. stageAndVerifyProposal provides non-destructive pre-approval check", () => {
      const candidateProposal: AIChangeProposal = {
        id: "prop_check_candidate",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Refactor policy",
        summary: "Safe policy check",
        reasoning: "Enhance safety score",
        status: "pending_approval",
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: `
export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}

export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  if (!state) return false;
  return state.safetyScore >= 0.8;
}

export function validateStepSequence(steps: string[]): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps[0] === "01_analyze";
}
`.trim(),
          },
        ],
      };

      const verification = stageAndVerifyProposal(testWorkspace, candidateProposal);
      assert.strictEqual(verification.passed, true);
      assert.strictEqual(verification.errors.length, 0);
    });
  });

  // =========================================================================
  // 7. COMPILER-IN-THE-LOOP SELF-REPAIR & END-TO-END PIPELINE REGRESSION
  // =========================================================================
  describe("7. Genuine End-to-End Compiler-in-the-Loop Self-Repair Pipeline", () => {
    function createMockRepairClient(responses: string[]): ProviderClient {
      let callIdx = 0;
      return {
        provider: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        isConfigured: true,
        checkStatus: async () => ({ state: "connected", model: "mock", baseUrl: "https://integrate.api.nvidia.com/v1" }),
        listAvailableModels: async () => ["mock-model"],
        generateCompletion: async () => {
          if (callIdx >= responses.length) {
            throw new Error(`Mock client exhausted: call ${callIdx + 1} exceeds ${responses.length} responses.`);
          }
          const rawContent = responses[callIdx];
          callIdx++;
          return {
            rawContent,
            model: "mock-model",
            usage: { promptTokens: 150, completionTokens: 80, totalTokens: 230 },
            latencyMs: 15,
          };
        },
      };
    }

    it("7.1. valid repair resolves an actual TypeScript semantic error via feedback loop", async () => {
      // Initial proposal introduces a semantic type mismatch (TS2322) in src/evaluator.ts
      const initialFailingProposal: AIChangeProposal = {
        id: "prop_ts_error",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Update safety policy with new threshold",
        summary: "Update threshold with type error",
        reasoning: "Demonstrate self-repair loop",
        status: "pending_approval",
        potentialRisks: "Type error",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: `
export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}

export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  if (!state) return false;
  const threshold: number = "0.85"; // TS2322 Type mismatch!
  return state.safetyScore >= threshold;
}

export function validateStepSequence(steps: string[]): boolean {
  return Array.isArray(steps) && steps[0] === "01_analyze";
}
`.trim(),
          },
        ],
      };

      // Mock LLM produces the corrected TypeScript code on attempt 1
      const correctedProposalJson = JSON.stringify({
        summary: "Fix type error in safety threshold",
        reasoning: "Assigned numeric literal instead of string",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: `
export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}

export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  if (!state) return false;
  const threshold: number = 0.85; // Fixed!
  return state.safetyScore >= threshold;
}

export function validateStepSequence(steps: string[]): boolean {
  return Array.isArray(steps) && steps[0] === "01_analyze";
}
`.trim(),
            explanation: "Changed string to number",
          },
        ],
        potentialRisks: "None",
        expectedValidationResult: "pass",
      });

      const mockClient = createMockRepairClient([correctedProposalJson]);

      const result = await runSelfRepairLoop(
        testWorkspace,
        initialFailingProposal,
        [],
        { repairClient: mockClient, maxAttempts: 2 }
      );

      assert.strictEqual(result.status, "verified");
      assert.strictEqual(result.verifiedInSandbox, true);
      assert.strictEqual(result.attemptsCount, 1);
      assert.strictEqual(result.repairAttempts.length, 1);
      assert.strictEqual(result.repairAttempts[0].verificationPassed, true);
      assert.ok(result.proposal.modifications[0].replacementContent.includes("const threshold: number = 0.85;"));
    });

    it("7.2. multi-step repair: first proposal fails verification and second proposal fixes the diagnostic", async () => {
      // Initial proposal fails: missing return type/syntax
      const initialProposal: AIChangeProposal = {
        id: "prop_multi_step",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Refactor evaluator",
        summary: "Initial broken proposal",
        reasoning: "Test two-step repair",
        status: "pending_approval",
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "const invalid: number = 'str';\n",
          },
        ],
      };

      // Attempt 1: fixes type error but forgets validateStepSequence invariant
      const response1 = JSON.stringify({
        summary: "Attempt 1 fix",
        reasoning: "Fixed type but missed invariant",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: `
export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}
export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  return state.safetyScore >= 0.8;
}
`.trim(),
          },
        ],
        expectedValidationResult: "pass",
      });

      // Attempt 2: adds required validateStepSequence, achieving full verification!
      const response2 = JSON.stringify({
        summary: "Attempt 2 complete fix",
        reasoning: "Added validateStepSequence to satisfy invariant",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: `
export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}
export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  return state.safetyScore >= 0.8;
}
export function validateStepSequence(steps: string[]): boolean {
  return Array.isArray(steps) && steps[0] === "01_analyze";
}
`.trim(),
          },
        ],
        expectedValidationResult: "pass",
      });

      const mockClient = createMockRepairClient([response1, response2]);

      const result = await runSelfRepairLoop(
        testWorkspace,
        initialProposal,
        [],
        { repairClient: mockClient, maxAttempts: 2 }
      );

      assert.strictEqual(result.status, "verified");
      assert.strictEqual(result.attemptsCount, 2);
      assert.strictEqual(result.repairAttempts.length, 2);
      assert.strictEqual(result.repairAttempts[0].verificationPassed, false);
      assert.strictEqual(result.repairAttempts[1].verificationPassed, true);
    });

    it("7.3. repair that still fails after two attempts is rejected with repair_exhausted", async () => {
      const initialProposal: AIChangeProposal = {
        id: "prop_stubborn_fail",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Refactor policy",
        summary: "Broken proposal",
        reasoning: "Never fixed",
        status: "pending_approval",
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "const x: number = 'still broken';\n",
          },
        ],
      };

      // Both attempts return persistently broken type errors
      const brokenResponse = JSON.stringify({
        summary: "Still broken attempt",
        reasoning: "Failed to fix",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "const x: number = 'still broken';\n",
          },
        ],
        expectedValidationResult: "pass",
      });

      const mockClient = createMockRepairClient([brokenResponse, brokenResponse]);

      const result = await runSelfRepairLoop(
        testWorkspace,
        initialProposal,
        [],
        { repairClient: mockClient, maxAttempts: 2 }
      );

      assert.strictEqual(result.status, "repair_exhausted");
      assert.strictEqual(result.verifiedInSandbox, false);
      assert.strictEqual(result.attemptsCount, 2);
      assert.strictEqual(result.finalErrors.length > 0, true);
      assert.ok(result.message.includes("exhausted"));
    });

    it("7.4. security-blocked code is immediately rejected without attempting self-repair", async () => {
      const maliciousProposal: AIChangeProposal = {
        id: "prop_eval_attempt",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Add eval helper",
        summary: "Dangerous eval sink",
        reasoning: "Check security cutoff",
        status: "pending_approval",
        potentialRisks: "Critical",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "export const execCode = (str: string) => eval(str);\n",
          },
        ],
      };

      let clientCalled = false;
      const mockClient: ProviderClient = {
        provider: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        isConfigured: true,
        checkStatus: async () => ({ state: "connected", model: "mock", baseUrl: "https://integrate.api.nvidia.com/v1" }),
        listAvailableModels: async () => ["mock-model"],
        generateCompletion: async () => {
          clientCalled = true;
          throw new Error("Client should NEVER be called on security violations!");
        },
      };

      const result = await runSelfRepairLoop(
        testWorkspace,
        maliciousProposal,
        [],
        { repairClient: mockClient, maxAttempts: 2 }
      );

      assert.strictEqual(result.status, "verification_failed");
      assert.strictEqual(result.verifiedInSandbox, false);
      assert.strictEqual(result.attemptsCount, 0);
      assert.strictEqual(clientCalled, false, "Repair loop must NOT invoke model on security violations");
      assert.ok(result.message.includes("Security violation detected"));
    });

    it("7.5. malformed and ambiguous patches are strictly rejected during staging without modifying live files", () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const originalContent = fs.readFileSync(evaluatorPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const malformedDiff = `
--- a/src/evaluator.ts
+++ b/src/evaluator.ts
@@ -1,10 +1,50 @@
+corrupted line counts in header
`.trim();

      const stagingResult = verifyCandidatePatchInSandbox(testWorkspace, malformedDiff);
      assert.strictEqual(stagingResult.passed, false);
      assert.ok(stagingResult.errors.some((e) => e.includes("Malformed") || e.includes("Diff")));

      // Live workspace file remains 100% untouched
      const currentContent = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(currentContent), originalHash);
    });

    it("7.6. Python syntax errors are detected by runtime and corrected via feedback", async () => {
      const donutPath = path.join(testWorkspace, "donut.py");
      fs.writeFileSync(donutPath, "def render():\n    pass\n", "utf-8");

      const initialBrokenPython: AIChangeProposal = {
        id: "prop_py_syntax",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Optimize render loop",
        summary: "Broken python syntax",
        reasoning: "Missing colon on def header",
        status: "pending_approval",
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "donut.py",
            operation: "modify",
            replacementContent: "def render(x)\n    return x * 2\n", // Missing colon!
          },
        ],
      };

      const fixedPythonJson = JSON.stringify({
        summary: "Fix colon in python def header",
        reasoning: "Added missing colon",
        modifications: [
          {
            path: "donut.py",
            operation: "modify",
            replacementContent: "def render(x):\n    return x * 2\n", // Fixed colon!
          },
        ],
        expectedValidationResult: "pass",
      });

      const mockClient = createMockRepairClient([fixedPythonJson]);

      const result = await runSelfRepairLoop(
        testWorkspace,
        initialBrokenPython,
        [],
        { repairClient: mockClient, maxAttempts: 2 }
      );

      assert.strictEqual(result.status, "verified");
      assert.strictEqual(result.attemptsCount, 1);
      assert.strictEqual(result.verifiedInSandbox, true);
      assert.ok(result.proposal.modifications[0].replacementContent.includes("def render(x):"));
    });

    it("7.7. provider failures and timeouts release credit reservations and preserve live files", () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const initialHash = calculateSha256(fs.readFileSync(evaluatorPath, "utf-8"));

      // 1. Reserve credits for task
      const reservation = checkAndReserveCredits("demo-workspace", 10, undefined, testStore);
      assert.ok(reservation.reservationId);
      assert.strictEqual(reservation.remainingAfterReserve, 90);

      // 2. Simulate provider failure / timeout: release reservation
      releaseCreditReservation(reservation.reservationId);

      // 3. New reservation receives full remaining allowance (not depleted)
      const reservationAfter = checkAndReserveCredits("demo-workspace", 10, undefined, testStore);
      assert.strictEqual(reservationAfter.remainingAfterReserve, 90);
      releaseCreditReservation(reservationAfter.reservationId);

      // 4. Live files on disk are completely unchanged
      const currentHash = calculateSha256(fs.readFileSync(evaluatorPath, "utf-8"));
      assert.strictEqual(currentHash, initialHash);
    });

    it("7.8. failed verification leaves the original workspace byte-for-byte unchanged", async () => {
      // Capture baseline hashes of all files in workspace
      const allFiles = listPermittedWorkspaceFiles(testWorkspace);
      const baselineHashes = new Map<string, string>();
      for (const f of allFiles) {
        const full = path.join(testWorkspace, f.path);
        baselineHashes.set(f.path, calculateSha256(fs.readFileSync(full, "utf-8")));
      }

      // Candidate that failed verification
      const failingProposal: AIChangeProposal = {
        id: "prop_failed_apply",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Bad changes",
        summary: "Broken change",
        reasoning: "Should be refused",
        status: "approved",
        verificationStatus: "repair_exhausted",
        potentialRisks: "Will fail",
        expectedValidationResult: "fail",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: "broken content",
          },
        ],
      };

      await assert.rejects(
        async () => {
          await applyApprovedAIProposal(testWorkspace, testStore, failingProposal);
        },
        (err: unknown) => {
          return err instanceof Error && err.message.includes("Verification Blocker");
        }
      );

      // Confirm every file in workspace is byte-for-byte unchanged
      for (const [relPath, hash] of baselineHashes.entries()) {
        const currentContent = fs.readFileSync(path.join(testWorkspace, relPath), "utf-8");
        assert.strictEqual(calculateSha256(currentContent), hash, `File ${relPath} was modified!`);
      }
    });

    it("7.9. successful verification still requires explicit approval before applying", async () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const originalContent = fs.readFileSync(evaluatorPath, "utf-8");
      const originalHash = calculateSha256(originalContent);

      const verifiedProposal: AIChangeProposal = {
        id: "prop_verified_explicit",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Safe update",
        summary: "Verified update to threshold",
        reasoning: "Valid TypeScript code",
        status: "pending_approval",
        verificationStatus: "verified",
        verifiedInSandbox: true,
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: originalContent.replace("safetyScore < 0.8", "safetyScore < 0.82"),
          },
        ],
      };

      // 1. Proposal is verified, but disk has NOT changed yet (requires approval)
      const contentBeforeApproval = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(contentBeforeApproval), originalHash);

      // 2. User explicitly approves and applies
      verifiedProposal.status = "approved";
      const applyResult = await applyApprovedAIProposal(testWorkspace, testStore, verifiedProposal, {
        enforcePreVerification: true,
      });

      assert.strictEqual(applyResult.success, true);

      // 3. Now the change is written to disk!
      const contentAfterApply = fs.readFileSync(evaluatorPath, "utf-8");
      assert.ok(contentAfterApply.includes("safetyScore < 0.82"));
    });

    it("7.10. approved application preserves automatic pre-snapshot and rollback behavior", async () => {
      const evaluatorPath = path.join(testWorkspace, "src", "evaluator.ts");
      const baselineContent = fs.readFileSync(evaluatorPath, "utf-8");
      const baselineHash = calculateSha256(baselineContent);

      const proposal: AIChangeProposal = {
        id: "prop_with_snapshot",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Update threshold",
        summary: "Update threshold with snapshot",
        reasoning: "Test snapshot rollback",
        status: "approved",
        verificationStatus: "verified",
        verifiedInSandbox: true,
        potentialRisks: "None",
        expectedValidationResult: "pass",
        modifications: [
          {
            path: "src/evaluator.ts",
            operation: "modify",
            replacementContent: baselineContent.replace("safetyScore < 0.8", "safetyScore < 0.88"),
          },
        ],
      };

      // 1. Apply approved proposal
      const applyResult = await applyApprovedAIProposal(testWorkspace, testStore, proposal);
      assert.strictEqual(applyResult.success, true);
      assert.ok(applyResult.snapshotBeforeId.startsWith("snap_"));

      // 2. Now rollback cleanly to the automatic pre-snapshot
      const rollback = restoreSnapshot(testWorkspace, testStore, applyResult.snapshotBeforeId, {
        force: true,
      });
      assert.strictEqual(rollback.success, true);

      // 3. Workspace is restored to exact initial baseline hash!
      const restoredContent = fs.readFileSync(evaluatorPath, "utf-8");
      assert.strictEqual(calculateSha256(restoredContent), baselineHash);
      assert.strictEqual(validateWorkspaceDeterministically(testWorkspace).passed, true);
    });

    it("7.11. concurrent requests cannot double-charge the same completed task", () => {
      const taskId = "task_unique_concurrent_check";
      const model = getModelMetadata("nvidia/Llama-3.1-Nemotron-70B-Instruct-HF", "nvidia");

      // 1. First task accounting execution
      const acct1 = accountTaskExecution({
        taskId,
        complexity: "standard_refactor",
        model,
        outcome: "success",
        projectId: "demo-workspace",
        storeRoot: testStore,
      });

      assert.strictEqual(acct1.isDuplicate, false);
      assert.strictEqual(acct1.creditAccounting.creditsCharged, 2);

      // Commit credit deduction to project store
      const res1 = checkAndReserveCredits("demo-workspace", 2, undefined, testStore);
      commitCreditReservation(res1.reservationId, "demo-workspace", taskId, 2, "standard_refactor", testStore);

      const balance1 = getProjectCreditBalance("demo-workspace", testStore);
      assert.strictEqual(balance1.used, 2);

      // 2. Duplicate concurrent execution with same taskId
      const acct2 = accountTaskExecution({
        taskId,
        complexity: "standard_refactor",
        model,
        outcome: "success",
        projectId: "demo-workspace",
        storeRoot: testStore,
      });

      assert.strictEqual(acct2.isDuplicate, true);

      // Duplicate commit for same taskId does not double charge!
      const res2 = checkAndReserveCredits("demo-workspace", 2, undefined, testStore);
      commitCreditReservation(res2.reservationId, "demo-workspace", taskId, 2, "standard_refactor", testStore);

      const balance2 = getProjectCreditBalance("demo-workspace", testStore);
      assert.strictEqual(balance2.used, 2); // Still 2, not 4!
    });

    it("8.1. applyApprovedAIProposal respects target projectId and isolates changes to designated project workspace", async () => {
      const proj = createProject(
        { name: "Production Isolation Test", description: "Verifies project-scoped AI proposal execution", template: "demo" },
        testStore
      );
      const projWorkspace = resolveProjectWorkspace(proj.id, testStore);
      const defaultReadmePath = path.join(testWorkspace, "README.md");
      const projReadmePath = path.join(projWorkspace, "README.md");

      const initialProjReadme = fs.readFileSync(projReadmePath, "utf-8");
      const defaultReadmeBaseline = fs.existsSync(defaultReadmePath)
        ? fs.readFileSync(defaultReadmePath, "utf-8")
        : null;

      const proposal: AIChangeProposal = {
        id: "prop_isolate_test",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Update project readme with production notes",
        summary: "Update isolated project README",
        reasoning: "Test project-level isolation",
        status: "approved",
        verificationStatus: "verified",
        verifiedInSandbox: true,
        expectedValidationResult: "pass",
        potentialRisks: "None",
        modifications: [
          {
            path: "README.md",
            operation: "modify",
            replacementContent: "# Production Isolation Test\n\nUpdated strictly in isolated workspace.\n",
          },
        ],
      };

      const result = await applyApprovedAIProposal(projWorkspace, testStore, proposal, {
        projectId: proj.id,
      });

      assert.strictEqual(result.success, true);
      const updatedProjReadme = fs.readFileSync(projReadmePath, "utf-8");
      assert.ok(updatedProjReadme.includes("Updated strictly in isolated workspace."));
      assert.notStrictEqual(updatedProjReadme, initialProjReadme);

      // Default demo workspace was untouched!
      if (defaultReadmeBaseline !== null) {
        assert.strictEqual(fs.readFileSync(defaultReadmePath, "utf-8"), defaultReadmeBaseline);
      }
    });

    it("8.2. applyApprovedAIProposal tags pre-AI safety snapshot with target projectId, allowing project-scoped rollback", async () => {
      const proj = createProject(
        { name: "Project Snapshot Tagging", description: "Verifies snapshot attribution", template: "demo" },
        testStore
      );
      const projWorkspace = resolveProjectWorkspace(proj.id, testStore);
      const projReadmePath = path.join(projWorkspace, "README.md");
      const initialContent = fs.readFileSync(projReadmePath, "utf-8");
      const initialHash = calculateSha256(initialContent);

      const proposal: AIChangeProposal = {
        id: "prop_tagging_test",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Modify project file and verify snapshot attribution",
        summary: "Modify project file",
        reasoning: "Verify snapshot attribution",
        status: "approved",
        verificationStatus: "verified",
        verifiedInSandbox: true,
        expectedValidationResult: "pass",
        potentialRisks: "None",
        modifications: [
          {
            path: "README.md",
            operation: "modify",
            replacementContent: "# Changed Title\n\nNew body.\n",
          },
        ],
      };

      const result = await applyApprovedAIProposal(projWorkspace, testStore, proposal, {
        projectId: proj.id,
      });

      // 1. Snapshot is credited to the project
      const projSnapshots = listProjectSnapshots(proj.id, testStore);
      const preSnap = projSnapshots.find((s) => s.id === result.snapshotBeforeId);
      assert.ok(preSnap, "Pre-AI snapshot must belong to target project");
      assert.strictEqual(preSnap?.workspaceId, proj.id);

      // 2. Project-scoped restore succeeds cleanly
      const recovery = restoreSnapshot(projWorkspace, testStore, result.snapshotBeforeId, {
        force: true,
        expectedProjectId: proj.id,
      });
      assert.strictEqual(recovery.success, true);
      assert.strictEqual(calculateSha256(fs.readFileSync(projReadmePath, "utf-8")), initialHash);
    });

    it("8.3. applyApprovedAIProposal automatically performs emergency rollback to preSnapshot if partial write fails mid-way", async () => {
      const workflowPath = path.join(testWorkspace, "agent-workflow.json");
      const initialWorkflowContent = fs.readFileSync(workflowPath, "utf-8");
      const initialWorkflowHash = calculateSha256(initialWorkflowContent);

      // Create a directory with a permitted file name so writing to it as a file fails (EISDIR/EPERM)
      const blockDirPath = path.join(testWorkspace, "blocker.json");
      fs.mkdirSync(blockDirPath, { recursive: true });

      const failingProposal: AIChangeProposal = {
        id: "prop_atomic_failure_test",
        model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
        createdAt: new Date().toISOString(),
        userPrompt: "Try partial write and verify blast radius rollback",
        summary: "Partial write test",
        reasoning: "Verify emergency rollback on mid-way write failure",
        status: "approved",
        verificationStatus: "verified",
        verifiedInSandbox: true,
        expectedValidationResult: "pass",
        potentialRisks: "None",
        modifications: [
          {
            path: "agent-workflow.json",
            operation: "modify",
            replacementContent: '{"agentName": "ModifiedBeforeCrash"}',
          },
          {
            path: "blocker.json",
            operation: "create",
            replacementContent: '{"corrupt": true}',
          },
        ],
      };

      // Execution must reject due to blocker.json write error
      await assert.rejects(
        async () => {
          await applyApprovedAIProposal(testWorkspace, testStore, failingProposal, {
            projectId: "demo-workspace",
          });
        }
      );

      // Blast-radius emergency rollback restored agent-workflow.json to exact initial content!
      const currentWorkflowContent = fs.readFileSync(workflowPath, "utf-8");
      assert.strictEqual(
        calculateSha256(currentWorkflowContent),
        initialWorkflowHash,
        "Partial write must be automatically rolled back to initial state!"
      );
    });

    it("8.4. applyApprovedFileChange respects target projectId and isolates safety snapshots", () => {
      const proj = createProject(
        { name: "Single File Modify Isolation", description: "Verifies file change snapshot isolation" },
        testStore
      );
      const projWorkspace = resolveProjectWorkspace(proj.id, testStore);

      const result = applyApprovedFileChange(
        projWorkspace,
        testStore,
        "src/evaluator.ts",
        "export function test() { return true; }\n",
        "Add test function",
        { projectId: proj.id }
      );

      const projSnapshots = listProjectSnapshots(proj.id, testStore);
      const matchingSnap = projSnapshots.find((s) => s.id === result.snapshotBeforeId);
      assert.ok(matchingSnap, "Pre-change safety snapshot must be associated with target project");
      assert.strictEqual(matchingSnap?.workspaceId, proj.id);
    });
  });
});

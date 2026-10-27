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
  initializeDemoWorkspace,
} from "../src/engine/demoWorkspace";
import {
  validateWorkspaceDeterministically,
} from "../src/engine/recoveryEngine";
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
});

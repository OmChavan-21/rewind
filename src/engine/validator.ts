import fs from "node:fs";
import path from "node:path";
import type { ValidationCheck, ValidationResult } from "../types/recovery";

/**
 * Runs a deterministic validation suite against the workspace.
 * Returns structured results with pass/fail status per check.
 */
export function validateWorkspaceDeterministically(workspaceRoot: string): ValidationResult {
  const startTime = Date.now();
  const checks: ValidationCheck[] = [];
  let allPassed = true;

  // Check 1: Core Files Existence
  const missingFiles: string[] = [];
  if (!fs.existsSync(path.join(workspaceRoot, "README.md"))) {
    missingFiles.push("README.md");
  }
  if (!fs.existsSync(path.join(workspaceRoot, "agent-workflow.json"))) {
    missingFiles.push("agent-workflow.json");
  }
  if (!fs.existsSync(path.join(workspaceRoot, "src/evaluator.ts"))) {
    missingFiles.push("src/evaluator.ts");
  }
  if (!fs.existsSync(path.join(workspaceRoot, "config/runtime.json"))) {
    missingFiles.push("config/runtime.json");
  }

  if (missingFiles.length === 0) {
    checks.push({
      name: "File Inventory Integrity",
      status: "pass",
      message: "All required project files exist in workspace.",
    });
  } else {
    allPassed = false;
    checks.push({
      name: "File Inventory Integrity",
      status: "fail",
      message: `Missing required files: ${missingFiles.join(", ")}`,
      details: "Restore workspace from snapshot to recover missing blueprint files.",
    });
  }

  // Check 2: agent-workflow.json Schema and Syntax
  const workflowPath = path.join(workspaceRoot, "agent-workflow.json");
  if (fs.existsSync(workflowPath)) {
    try {
      const raw = fs.readFileSync(workflowPath, "utf-8");
      const parsed = JSON.parse(raw);

      if (!parsed.agentName || typeof parsed.agentName !== "string") {
        allPassed = false;
        checks.push({
          name: "Workflow Specification",
          status: "fail",
          message: "'agent-workflow.json' missing or invalid 'agentName'.",
        });
      } else if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        allPassed = false;
        checks.push({
          name: "Workflow Specification",
          status: "fail",
          message: "'agent-workflow.json' steps must be a non-empty array.",
        });
      } else {
        checks.push({
          name: "Workflow Specification",
          status: "pass",
          message: `Valid workflow configuration (${parsed.steps.length} steps configured for ${parsed.agentName} v${parsed.version || "1.0.0"}).`,
        });
      }
    } catch (jsonErr: unknown) {
      allPassed = false;
      const errMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      checks.push({
        name: "Workflow Specification",
        status: "fail",
        message: "JSON syntax corruption detected in 'agent-workflow.json'.",
        details: errMsg,
      });
    }
  }

  // Check 3: config/runtime.json Schema and Syntax
  const runtimePath = path.join(workspaceRoot, "config/runtime.json");
  if (fs.existsSync(runtimePath)) {
    try {
      const raw = fs.readFileSync(runtimePath, "utf-8");
      const parsed = JSON.parse(raw);

      if (typeof parsed.memoryLimitMb !== "number" || parsed.memoryLimitMb <= 0) {
        allPassed = false;
        checks.push({
          name: "Runtime Config Invariants",
          status: "fail",
          message: "'config/runtime.json' invalid memoryLimitMb property.",
        });
      } else {
        checks.push({
          name: "Runtime Config Invariants",
          status: "pass",
          message: `Runtime constraints valid (memory: ${parsed.memoryLimitMb}MB, timeout: ${parsed.timeoutSeconds}s).`,
        });
      }
    } catch (jsonErr: unknown) {
      allPassed = false;
      const errMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      checks.push({
        name: "Runtime Config Invariants",
        status: "fail",
        message: "JSON syntax corruption in 'config/runtime.json'.",
        details: errMsg,
      });
    }
  }

  // Check 4: src/evaluator.ts Integrity
  const evaluatorPath = path.join(workspaceRoot, "src/evaluator.ts");
  if (fs.existsSync(evaluatorPath)) {
    const code = fs.readFileSync(evaluatorPath, "utf-8");

    // Check for intentional demo break syntax error markers
    if (code.includes("<<<SYNTAX_ERROR_CRASH>>>") || code.includes("throw new FatalAgentCorruptionError")) {
      allPassed = false;
      checks.push({
        name: "Safety Evaluator Logic",
        status: "fail",
        message: "Fatal synthetic failure detected in 'src/evaluator.ts'.",
        details: "Code contains intentional demo crash sequence or unhandled fatal syntax error.",
      });
    } else if (
      !code.includes("function evaluateSafetyPolicy") ||
      !code.includes("function validateStepSequence")
    ) {
      allPassed = false;
      checks.push({
        name: "Safety Evaluator Logic",
        status: "fail",
        message: "'src/evaluator.ts' is missing required safety export functions.",
        details: "Expected exports 'evaluateSafetyPolicy' and 'validateStepSequence' were not found.",
      });
    } else {
      checks.push({
        name: "Safety Evaluator Logic",
        status: "pass",
        message: "Evaluator contract intact with all required safety assertions.",
      });
    }
  }

  const executionTimeMs = Date.now() - startTime;
  const summary = allPassed
    ? "All deterministic workspace invariants passed."
    : `Validation failed: ${checks.filter((c) => c.status === "fail").length} check(s) reported errors.`;

  return {
    passed: allPassed,
    timestamp: new Date().toISOString(),
    target: "demo-workspace",
    checks,
    summary,
    executionTimeMs,
  };
}

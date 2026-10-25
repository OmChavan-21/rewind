import fs from "node:fs";
import path from "node:path";

export interface DemoProjectBlueprint {
  "README.md": string;
  "agent-workflow.json": string;
  "src/evaluator.ts": string;
  "config/runtime.json": string;
}

export const INITIAL_DEMO_PROJECT: DemoProjectBlueprint = {
  "README.md": `# Autonomous Recovery Agent — Sample Project

This is the dedicated demo workspace for **Rewind**, the AI-agent reliability and recovery platform.

## Agent Responsibilities
- Monitor autonomous multi-step execution tasks
- Validate tool execution boundaries against security allowlists
- Execute safety checkpoints before mutable file operations
- Rollback cleanly to known-good snapshots on policy violations or execution faults
`,

  "agent-workflow.json": `{
  "agentName": "NebiusNvidiaRecoveryBot",
  "version": "1.0.0",
  "environment": "sandbox-demo",
  "maxRetryAttempts": 3,
  "safetyGuardEnabled": true,
  "permittedTools": [
    "code_analysis",
    "diff_verifier",
    "syntax_validator",
    "snapshot_engine"
  ],
  "steps": [
    {
      "stepId": "01_analyze",
      "action": "code_analysis",
      "timeoutMs": 5000,
      "required": true
    },
    {
      "stepId": "02_validate_invariants",
      "action": "syntax_validator",
      "timeoutMs": 3000,
      "required": true
    },
    {
      "stepId": "03_checkpoint_snapshot",
      "action": "snapshot_engine",
      "timeoutMs": 2000,
      "required": true
    }
  ]
}
`,

  "src/evaluator.ts": `/**
 * Agent Evaluator & Safety Policy Engine
 * Deterministic rules for workspace validation
 */

export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}

export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  if (!state) return false;
  if (state.safetyScore < 0.8) return false;
  if (state.errorsDetected.length > 0) return false;
  return true;
}

export function validateStepSequence(steps: string[]): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  // Steps must execute in approved order
  const approvedStart = "01_analyze";
  return steps[0] === approvedStart;
}
`,

  "config/runtime.json": `{
  "memoryLimitMb": 512,
  "timeoutSeconds": 30,
  "telemetry": {
    "enabled": true,
    "logLevel": "info"
  },
  "recoveryPolicy": {
    "autoRollbackOnFailure": true,
    "maxSnapshotHistory": 25
  }
}
`,
};

/**
 * Initializes or resets the demo workspace with the standard sample project files.
 */
export function initializeDemoWorkspace(workspaceRoot: string, force = false): void {
  if (!fs.existsSync(workspaceRoot)) {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  for (const [relativePath, content] of Object.entries(INITIAL_DEMO_PROJECT)) {
    const fullPath = path.join(workspaceRoot, relativePath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    if (force || !fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content, "utf-8");
    }
  }
}

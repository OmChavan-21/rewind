import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseAndValidateProposal,
  getNebiusConfig,
  checkNebiusStatus,
  MAX_MODEL_OUTPUT_BYTES,
} from "../src/server/nebiusService";
import {
  applyApprovedAIProposal,
  ConflictError,
} from "../src/server/proposalExecution";
import {
  restoreSnapshot,
  validateWorkspaceDeterministically,
} from "../src/engine/recoveryEngine";
import { initializeDemoWorkspace } from "../src/engine/demoWorkspace";
import { SecurityError } from "../src/security/boundaries";
import { calculateSha256 } from "../src/engine/storage";
import type { AIChangeProposal } from "../src/types/ai";

describe("Rewind Phase 2 - Nebius AI Integration & Trusted Execution Test Suite", () => {
  let tempBaseDir: string;
  let testWorkspace: string;
  let testStore: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-ai-test-"));
    testWorkspace = path.join(tempBaseDir, "workspace");
    testStore = path.join(tempBaseDir, "store");

    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.mkdirSync(testStore, { recursive: true });

    initializeDemoWorkspace(testWorkspace);
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  // 1. Schema & JSON Extraction
  it("1. correctly parses and validates a well-formed JSON proposal in markdown blocks", () => {
    const rawMarkdown = `Here is the requested change for your workflow:
\`\`\`json
{
  "summary": "Add telemetry guard to workflow",
  "reasoning": "Configures automated recovery and adds guard to permitted tools",
  "modifications": [
    {
      "path": "agent-workflow.json",
      "operation": "modify",
      "replacementContent": "{\\n  \\"agentName\\": \\"NebiusBot\\",\\n  \\"version\\": \\"1.2.0\\",\\n  \\"environment\\": \\"sandbox-demo\\",\\n  \\"maxRetryAttempts\\": 5,\\n  \\"permittedTools\\": [\\"telemetry\\"],\\n  \\"steps\\": []\\n}",
      "explanation": "Bumped version and added telemetry tool"
    }
  ],
  "potentialRisks": "Low risk; modifies json structure",
  "expectedValidationResult": "pass"
}
\`\`\`
Let me know if you would like any other changes!`;

    const proposal = parseAndValidateProposal(
      rawMarkdown,
      "Add telemetry guard",
      "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF"
    );

    assert.ok(proposal.id.startsWith("prop_"));
    assert.strictEqual(proposal.summary, "Add telemetry guard to workflow");
    assert.strictEqual(proposal.modifications.length, 1);
    assert.strictEqual(proposal.modifications[0].path, "agent-workflow.json");
    assert.strictEqual(proposal.modifications[0].operation, "modify");
    assert.strictEqual(proposal.expectedValidationResult, "pass");
    assert.strictEqual(proposal.status, "pending_approval");
  });

  // 2. Reject malformed / incomplete proposals
  it("2. rejects malformed, incomplete, or non-json model output", () => {
    // Missing required fields
    assert.throws(() => {
      parseAndValidateProposal(
        JSON.stringify({ summary: "Just a summary without reasoning" }),
        "Test prompt",
        "nvidia/model"
      );
    }, /missing required 'reasoning'/i);

    // Empty modifications
    assert.throws(() => {
      parseAndValidateProposal(
        JSON.stringify({
          summary: "Valid summary",
          reasoning: "Valid reasoning",
          modifications: [],
        }),
        "Test prompt",
        "nvidia/model"
      );
    }, /must include at least one modification/i);

    // Invalid JSON
    assert.throws(() => {
      parseAndValidateProposal("Not JSON at all", "Test prompt", "nvidia/model");
    }, /Failed to parse model output/i);
  });

  // 3. Reject oversized model output
  it("3. rejects model output that exceeds maximum byte limit", () => {
    const hugePadding = "x".repeat(MAX_MODEL_OUTPUT_BYTES + 100);
    assert.throws(() => {
      parseAndValidateProposal(hugePadding, "Test prompt", "nvidia/model");
    }, /exceeds maximum limit/i);
  });

  // 4. Security: Rejection of path traversal & prohibited files
  it("4. rejects path traversal and prohibited/sensitive file targets in proposal", () => {
    // Path traversal attempt
    assert.throws(() => {
      parseAndValidateProposal(
        JSON.stringify({
          summary: "Traversal attack",
          reasoning: "Attempt to escape workspace",
          modifications: [
            {
              path: "../../etc/passwd",
              operation: "modify",
              replacementContent: "root:x:0:0::/root:/bin/bash",
            },
          ],
        }),
        "Break jail",
        "nvidia/model"
      );
    }, SecurityError);

    // Forbidden file type: .env
    assert.throws(() => {
      parseAndValidateProposal(
        JSON.stringify({
          summary: "Write secret",
          reasoning: "Attempt to write env file",
          modifications: [
            {
              path: ".env.local",
              operation: "create",
              replacementContent: "SECRET_KEY=12345",
            },
          ],
        }),
        "Write secret",
        "nvidia/model"
      );
    }, SecurityError);

    // Forbidden executable file: .sh
    assert.throws(() => {
      parseAndValidateProposal(
        JSON.stringify({
          summary: "Write script",
          reasoning: "Attempt to write shell script",
          modifications: [
            {
              path: "run.sh",
              operation: "create",
              replacementContent: "#!/bin/bash\nrm -rf /",
            },
          ],
        }),
        "Write script",
        "nvidia/model"
      );
    }, SecurityError);
  });

  // 5. Trusted Execution: Applies approved changes with pre-snapshot & validation
  it("5. captures pre-change snapshot, applies approved changes, and passes deterministic validation", async () => {
    const proposal: AIChangeProposal = {
      id: "prop_test_001",
      model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
      createdAt: new Date().toISOString(),
      userPrompt: "Update runtime config",
      summary: "Add telemetry flag to runtime config",
      reasoning: "Enables telemetry in sandbox configuration",
      status: "approved",
      potentialRisks: "None",
      expectedValidationResult: "pass",
      modifications: [
        {
          path: "config/runtime.json",
          operation: "modify",
          replacementContent: JSON.stringify(
            {
              memoryLimitMb: 1024,
              timeoutSeconds: 60,
              telemetry: {
                enabled: true,
                logLevel: "debug",
              },
              recoveryPolicy: {
                autoRollbackOnFailure: true,
                maxSnapshotHistory: 50,
              },
            },
            null,
            2
          ),
          explanation: "Increased memory limit and set debug log level",
        },
      ],
    };

    const result = await applyApprovedAIProposal(testWorkspace, testStore, proposal);

    assert.strictEqual(result.success, true);
    assert.ok(result.snapshotBeforeId.startsWith("snap_"));
    assert.strictEqual(result.appliedChanges.length, 1);
    assert.ok(result.appliedChanges[0].diff.includes("1024"));
    assert.strictEqual(result.validationResult.passed, true);

    // Verify file content on disk
    const contentOnDisk = fs.readFileSync(
      path.join(testWorkspace, "config", "runtime.json"),
      "utf-8"
    );
    assert.ok(contentOnDisk.includes("\"memoryLimitMb\": 1024"));
  });

  // 6. Conflict Detection on Stale State
  it("6. detects stale file hash conflicts and safely refuses application", async () => {
    const workflowPath = path.join(testWorkspace, "agent-workflow.json");
    const currentContent = fs.readFileSync(workflowPath, "utf-8");
    const actualHash = calculateSha256(currentContent);

    // Construct proposal expecting a DIFFERENT hash (stale proposal)
    const proposal: AIChangeProposal = {
      id: "prop_stale_conflict",
      model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
      createdAt: new Date().toISOString(),
      userPrompt: "Update workflow",
      summary: "Update workflow with stale expectation",
      reasoning: "Test conflict detection",
      status: "approved",
      potentialRisks: "None",
      expectedValidationResult: "pass",
      modifications: [
        {
          path: "agent-workflow.json",
          operation: "modify",
          expectedCurrentHash: "0000000000000000000000000000000000000000000000000000000000000000", // deliberate mismatch
          replacementContent: "{}",
        },
      ],
    };

    await assert.rejects(
      async () => {
        await applyApprovedAIProposal(testWorkspace, testStore, proposal);
      },
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.ok((err as Error).message.includes("[Stale File Conflict]"));
        return true;
      }
    );

    // Verify file was NOT modified
    const contentAfterRefusal = fs.readFileSync(workflowPath, "utf-8");
    assert.strictEqual(calculateSha256(contentAfterRefusal), actualHash);
  });

  // 7. Post-Apply Failure Detection & Safe Rollback to Pre-Snapshot
  it("7. flags post-apply invariant failure and enables clean rollback via pre-snapshot", async () => {
    // Propose an invalid/broken workflow that will fail schema validation
    const proposal: AIChangeProposal = {
      id: "prop_breaking_change",
      model: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
      createdAt: new Date().toISOString(),
      userPrompt: "Break workflow intentionally",
      summary: "Inject invalid JSON into agent workflow",
      reasoning: "Simulate an AI mistake to test recovery",
      status: "approved",
      potentialRisks: "Will fail validation",
      expectedValidationResult: "fail",
      modifications: [
        {
          path: "agent-workflow.json",
          operation: "modify",
          replacementContent: "{ INVALID_JSON_SYNTAX :::: broken }",
        },
      ],
    };

    const result = await applyApprovedAIProposal(testWorkspace, testStore, proposal);

    // Application completed, but post-validation caught the error
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.validationResult.passed, false);
    assert.ok(result.snapshotBeforeId.startsWith("snap_"));

    // Workspace is currently failing validation
    const postValidation = validateWorkspaceDeterministically(testWorkspace);
    assert.strictEqual(postValidation.passed, false);

    // Perform rollback to pre-change snapshot
    const recoveryResult = restoreSnapshot(
      testWorkspace,
      testStore,
      result.snapshotBeforeId,
      { force: true }
    );
    assert.strictEqual(recoveryResult.success, true);

    // Workspace is now healthy and valid again!
    const restoredValidation = validateWorkspaceDeterministically(testWorkspace);
    assert.strictEqual(restoredValidation.passed, true);
  });

  // 8. Credentials and Status Sanitization
  it("8. reports unconfigured status when NEBIUS_API_KEY is not set and masks secrets", async () => {
    const origKey = process.env.NEBIUS_API_KEY;
    try {
      delete process.env.NEBIUS_API_KEY;
      const status = await checkNebiusStatus();
      assert.strictEqual(status.state, "unconfigured");
      assert.ok(status.message?.includes("NEBIUS_API_KEY is not set"));

      // Config should have empty apiKey
      const config = getNebiusConfig();
      assert.strictEqual(config.apiKey, "");
      assert.ok(config.model.includes("Nemotron"));
    } finally {
      if (origKey !== undefined) {
        process.env.NEBIUS_API_KEY = origKey;
      }
    }
  });
});

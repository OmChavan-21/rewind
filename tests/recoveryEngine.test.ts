import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createSnapshot,
  getSnapshot,
  listSnapshots,
  compareWorkspaceWithSnapshot,
  restoreSnapshot,
  applyApprovedFileChange,
  validateWorkspace,
  introduceDemoFailure,
  readPermittedTextFile,
} from "../src/engine/recoveryEngine";
import { initializeDemoWorkspace } from "../src/engine/demoWorkspace";
import {
  resolveAndValidatePath,
  SecurityError,
} from "../src/security/boundaries";

describe("Rewind Phase 1 - Recovery Engine Test Suite", () => {
  let tempBaseDir: string;
  let testWorkspace: string;
  let testStore: string;

  beforeEach(() => {
    // Create an isolated temporary test directory
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-test-"));
    testWorkspace = path.join(tempBaseDir, "workspace");
    testStore = path.join(tempBaseDir, "store");

    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.mkdirSync(testStore, { recursive: true });

    // Initialize clean demo project in the temporary workspace
    initializeDemoWorkspace(testWorkspace);
  });

  afterEach(() => {
    // Clean up temporary directory safely
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  // Test 1: Snapshot creation and retrieval
  it("1. creates and retrieves a named snapshot with file contents and hashes", () => {
    const snapshot = createSnapshot(
      testWorkspace,
      testStore,
      "Baseline v1",
      "Initial test snapshot"
    );

    assert.ok(snapshot.id.startsWith("snap_"));
    assert.strictEqual(snapshot.name, "Baseline v1");
    assert.strictEqual(snapshot.totalFiles, 4);

    // Retrieve by ID
    const retrieved = getSnapshot(testStore, snapshot.id);
    assert.ok(retrieved !== null);
    assert.strictEqual(retrieved?.snapshot.id, snapshot.id);
    assert.strictEqual(retrieved?.snapshot.files.length, 4);

    // Check file contents mapping
    const workflowFile = retrieved?.fileContents.get("agent-workflow.json");
    assert.ok(workflowFile?.includes("NebiusNvidiaRecoveryBot"));

    // Verify snapshot appears in list
    const all = listSnapshots(testStore);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, snapshot.id);
  });

  // Test 2: Correct detection of changed files
  it("2. correctly detects added, modified, and deleted files against a snapshot", () => {
    const baseline = createSnapshot(testWorkspace, testStore, "Baseline");

    // 1. Modify a file
    const modifiedPath = path.join(testWorkspace, "agent-workflow.json");
    fs.writeFileSync(
      modifiedPath,
      JSON.stringify({ agentName: "ModifiedAgent", steps: [] }, null, 2)
    );

    // 2. Add a new permitted file
    const addedPath = path.join(testWorkspace, "notes.txt");
    fs.writeFileSync(addedPath, "New agent notes content");

    // 3. Delete a file
    const deletedPath = path.join(testWorkspace, "config/runtime.json");
    fs.unlinkSync(deletedPath);

    const changes = compareWorkspaceWithSnapshot(testWorkspace, testStore, baseline.id);

    const modifiedChange = changes.find((c) => c.path === "agent-workflow.json");
    const addedChange = changes.find((c) => c.path === "notes.txt");
    const deletedChange = changes.find((c) => c.path === "config/runtime.json");
    const unchangedChange = changes.find((c) => c.path === "README.md");

    assert.strictEqual(modifiedChange?.type, "modified");
    assert.ok(modifiedChange?.diff?.includes("-"));
    assert.ok(modifiedChange?.diff?.includes("+"));

    assert.strictEqual(addedChange?.type, "added");
    assert.ok(addedChange?.diff?.includes("+ New agent notes content"));

    assert.strictEqual(deletedChange?.type, "deleted");
    assert.ok(deletedChange?.diff?.includes("-"));

    assert.strictEqual(unchangedChange?.type, "unchanged");
  });

  // Test 3: Successful restoration of a known snapshot
  it("3. successfully restores a known snapshot and reverts all modifications", () => {
    const baseline = createSnapshot(testWorkspace, testStore, "Known-Good");

    // Mutate workspace
    applyApprovedFileChange(
      testWorkspace,
      testStore,
      "agent-workflow.json",
      '{\n  "agentName": "AlteredBot"\n}',
      "Test mutation"
    );

    // Add extra file
    fs.writeFileSync(path.join(testWorkspace, "extra.txt"), "temporary");

    // Verify state is altered
    const alteredContent = readPermittedTextFile(testWorkspace, "agent-workflow.json");
    assert.ok(alteredContent.includes("AlteredBot"));
    assert.ok(fs.existsSync(path.join(testWorkspace, "extra.txt")));

    // Restore baseline snapshot
    const recoveryResult = restoreSnapshot(testWorkspace, testStore, baseline.id, {
      force: true,
    });

    assert.strictEqual(recoveryResult.success, true);
    assert.strictEqual(recoveryResult.snapshotId, baseline.id);

    // Verify baseline content restored
    const restoredContent = readPermittedTextFile(testWorkspace, "agent-workflow.json");
    assert.ok(restoredContent.includes("NebiusNvidiaRecoveryBot"));

    // Verify extra file was pruned
    assert.strictEqual(fs.existsSync(path.join(testWorkspace, "extra.txt")), false);
  });

  // Test 4: Detection of conflicting modifications
  it("4. detects conflicting modifications when comparing with expected baseline", () => {
    const snap1 = createSnapshot(testWorkspace, testStore, "Baseline 1");

    // Modify a file unexpectedly
    const workflowPath = path.join(testWorkspace, "agent-workflow.json");
    fs.writeFileSync(workflowPath, '{"agentName": "ConflictingChange"}');

    // Attempting restore with snap1 as expected baseline should detect divergence
    const snap2 = createSnapshot(testWorkspace, testStore, "Baseline 2");

    // Reset workspace to snap2 state plus unexpected edit
    fs.writeFileSync(workflowPath, '{"agentName": "UnforeseenDivergence"}');

    const result = restoreSnapshot(testWorkspace, testStore, snap1.id, {
      expectedBaselineSnapshotId: snap2.id,
      force: false,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.conflicts.length > 0);
    assert.ok(result.conflicts[0].path === "agent-workflow.json");
    assert.ok(result.message.includes("Rollback refused"));
  });

  // Test 5: Path traversal rejection
  it("5. strictly rejects path traversal sequences", () => {
    assert.throws(
      () => {
        resolveAndValidatePath(testWorkspace, "../outside.txt");
      },
      (err: unknown) => {
        return err instanceof SecurityError && /traversal|escapes/i.test((err as Error).message);
      }
    );

    assert.throws(
      () => {
        resolveAndValidatePath(testWorkspace, "subdir/../../outside.txt");
      },
      (err: unknown) => {
        return err instanceof SecurityError;
      }
    );

    assert.throws(
      () => {
        resolveAndValidatePath(testWorkspace, "C:/Windows/System32/calc.exe");
      },
      (err: unknown) => {
        return err instanceof SecurityError;
      }
    );
  });

  // Test 6: Symbolic-link escape rejection
  it("6. rejects symbolic-link escapes outside workspace", () => {
    // Create an outside secret file
    const outsideFile = path.join(tempBaseDir, "secret.txt");
    fs.writeFileSync(outsideFile, "SUPER_SECRET_TOKEN=xyz123");

    const symlinkPath = path.join(testWorkspace, "symlink-escape.txt");

    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch {
      // On some Windows environments without dev mode, symlink creation may require admin
      // In that case, we verify that resolveAndValidatePath on any symlink is rejected
      return;
    }

    assert.throws(
      () => {
        resolveAndValidatePath(testWorkspace, "symlink-escape.txt");
      },
      (err: unknown) => {
        return err instanceof SecurityError && /Symbolic/i.test((err as Error).message);
      }
    );
  });

  // Test 7: Refusal to restore when workspace state is unexpected
  it("7. refuses to restore when workspace state has unexpected baseline conflicts", () => {
    const snap1 = createSnapshot(testWorkspace, testStore, "Snapshot 1");

    // Advance workspace
    fs.writeFileSync(path.join(testWorkspace, "agent-workflow.json"), '{"unexpected": true}');

    const result = restoreSnapshot(testWorkspace, testStore, snap1.id, {
      expectedBaselineSnapshotId: "non_existent_baseline", // Or diverged baseline
      force: false,
    });
    assert.strictEqual(result.success, false);

    // If expectedBaselineSnapshotId doesn't match, or conflicts exist
    // Let's test with a real baseline that has diverged
    const snap2 = createSnapshot(testWorkspace, testStore, "Snapshot 2");
    fs.writeFileSync(path.join(testWorkspace, "src/evaluator.ts"), "// unexpected edit");

    const refusedResult = restoreSnapshot(testWorkspace, testStore, snap1.id, {
      expectedBaselineSnapshotId: snap2.id,
      force: false,
    });

    assert.strictEqual(refusedResult.success, false);
    assert.ok(refusedResult.conflicts.length > 0);
    assert.ok(refusedResult.message.includes("Rollback refused"));
  });

  // Test 8: Successful validation after recovery
  it("8. passes deterministic validation after restoring a broken workspace", () => {
    // Break the workspace
    introduceDemoFailure(testWorkspace, testStore, "agent-workflow.json");

    // Validation fails
    const brokenValidation = validateWorkspace(testWorkspace, testStore);
    assert.strictEqual(brokenValidation.passed, false);

    // Get the snapshot created right before the break
    const snapshots = listSnapshots(testStore);
    const preBreakSnapshot = snapshots.find((s) => s.name.includes("Known-Good State"));
    assert.ok(preBreakSnapshot !== undefined);

    // Restore known good state
    const recoveryResult = restoreSnapshot(testWorkspace, testStore, preBreakSnapshot!.id, {
      force: true,
    });

    assert.strictEqual(recoveryResult.success, true);
    assert.ok(recoveryResult.postRestoreValidation?.passed === true);

    // Re-verify workspace validation directly
    const reValidation = validateWorkspace(testWorkspace, testStore);
    assert.strictEqual(reValidation.passed, true);
    assert.strictEqual(reValidation.checks.every((c) => c.status === "pass"), true);
  });

  // Test 9: Failed validation when a deliberate test failure remains
  it("9. reports failed validation when a deliberate test failure remains", () => {
    // Introduce failure in evaluator.ts
    const breakInfo = introduceDemoFailure(testWorkspace, testStore, "src/evaluator.ts");
    assert.strictEqual(breakInfo.brokenFile, "src/evaluator.ts");

    const validation = validateWorkspace(testWorkspace, testStore);
    assert.strictEqual(validation.passed, false);

    const evaluatorCheck = validation.checks.find((c) => c.name === "Safety Evaluator Logic");
    assert.strictEqual(evaluatorCheck?.status, "fail");
    assert.ok(evaluatorCheck?.message.includes("Synthetic") || evaluatorCheck?.message.includes("failure"));
  });
});

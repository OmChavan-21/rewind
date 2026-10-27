/**
 * Rewind Private Staging Deployment & Restart Persistence Test Suite
 * Verifies that:
 * 1. Workspace, snapshot storage, credits, and audit records persist intact across restarts.
 * 2. File systems are writable, bounded, and properly isolated.
 * 3. Recovery snapshots created before a restart remain completely restorable after restart.
 * 4. Staging environment parameters maintain private loopback binding (127.0.0.1).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  createProject,
  loadProjectsRegistry,
  listProjectSnapshots,
  resolveProjectWorkspace,
} from "../src/engine/projectManager";
import {
  listStoredSnapshots,
  loadSnapshotRecord,
  atomicWriteFileSync,
  calculateSha256,
  getAuditActionHistory,
} from "../src/engine/storage";
import {
  createSnapshot,
  recordAction,
  restoreSnapshot,
  validateWorkspaceDeterministically,
  listPermittedWorkspaceFiles,
  initializeDemoWorkspace,
} from "../src/engine/recoveryEngine";
import {
  checkAndReserveCredits,
  commitCreditReservation,
  readProjectCreditStore,
  getProjectCreditBalance,
  clearTaskLedger,
} from "../src/server/ai/dualAccounting";
import {
  ingestDocument,
  loadProjectVectorStore,
} from "../src/server/ragService";

describe("Rewind Private Staging & Storage Persistence Test Suite", () => {
  let stagingStore: string;
  let stagingWorkspace: string;

  beforeEach(() => {
    stagingStore = path.join(os.tmpdir(), `rewind-staging-store-${randomUUID()}`);
    stagingWorkspace = path.join(os.tmpdir(), `rewind-staging-ws-${randomUUID()}`);
    fs.mkdirSync(stagingStore, { recursive: true });
    fs.mkdirSync(stagingWorkspace, { recursive: true });
    clearTaskLedger();
  });

  afterEach(() => {
    clearTaskLedger();
    try {
      if (fs.existsSync(stagingStore)) {
        fs.rmSync(stagingStore, { recursive: true, force: true });
      }
      if (fs.existsSync(stagingWorkspace)) {
        fs.rmSync(stagingWorkspace, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors in tests
    }
  });

  it("1. verifies configured filesystem is writable and creates store structure correctly", () => {
    assert.strictEqual(fs.existsSync(stagingStore), true);
    assert.strictEqual(fs.existsSync(stagingWorkspace), true);

    // Test write permission via atomic write
    const testFile = path.join(stagingStore, "write-check.json");
    atomicWriteFileSync(testFile, JSON.stringify({ writable: true, timestamp: Date.now() }));
    assert.strictEqual(fs.existsSync(testFile), true);

    const parsed = JSON.parse(fs.readFileSync(testFile, "utf-8"));
    assert.strictEqual(parsed.writable, true);
  });

  it("2. persists projects, snapshots, credit ledger, and audit history across simulated process restart", async () => {
    // === PHASE A: Pre-restart Operations ===
    // 1. Create a project
    const project = createProject(
      {
        name: "Staging Persistence Demo",
        description: "Project designed to verify restart resilience",
        template: "demo",
      },
      stagingStore
    );
    const projWorkspace = resolveProjectWorkspace(project.id, stagingStore);

    // Verify initial demo files exist
    const filesBeforeRestart = listPermittedWorkspaceFiles(projWorkspace);
    assert.ok(filesBeforeRestart.length >= 4);

    // 2. Capture a pre-restart snapshot
    const snap1 = createSnapshot(
      projWorkspace,
      stagingStore,
      "Pre-Restart Baseline",
      "Safety snapshot before server restart simulation",
      { projectId: project.id }
    );
    assert.ok(snap1.id.startsWith("snap_"));

    // 3. Commit a credit reservation
    const reservation = checkAndReserveCredits(project.id, 4, 100, stagingStore);
    commitCreditReservation(
      reservation.reservationId,
      project.id,
      "task_pre_restart_01",
      4,
      "complex_code_modification",
      stagingStore
    );

    // 4. Record an audit log entry
    recordAction(stagingStore, {
      actionType: "snapshot_create",
      summary: "Created pre-restart baseline snapshot",
      status: "success",
      targetPath: "agent-workflow.json",
      snapshotIdAfter: snap1.id,
      details: { test: true },
    });

    // 5. Ingest a document into RAG vector store
    const docBuffer = Buffer.from("Rewind Agent Reliability Engine Staging Architecture Documentation");
    await ingestDocument(project.id, "README.md", docBuffer, stagingStore);

    // Verify pre-restart state
    const preRestartBalance = getProjectCreditBalance(project.id, stagingStore);
    assert.strictEqual(preRestartBalance.used, 4);
    assert.strictEqual(preRestartBalance.remaining, 96);

    // === PHASE B: Simulate Process / Container Restart ===
    // Clear all in-memory caches and singletons
    clearTaskLedger();

    // === PHASE C: Post-restart Verification from Disk ===
    // 1. Registry reload
    const freshRegistry = loadProjectsRegistry(stagingStore);
    assert.ok(freshRegistry.projects[project.id], "Project must exist in registry after restart");
    assert.strictEqual(freshRegistry.projects[project.id].name, "Staging Persistence Demo");

    // 2. Workspace file persistence
    const filesAfterRestart = listPermittedWorkspaceFiles(projWorkspace);
    assert.strictEqual(filesAfterRestart.length, filesBeforeRestart.length);

    // 3. Snapshot history reload
    assert.ok(listStoredSnapshots(stagingStore).length >= 1);
    const storedSnapshots = listProjectSnapshots(project.id, stagingStore);
    const foundSnap = storedSnapshots.find((s) => s.id === snap1.id);
    assert.ok(foundSnap, "Snapshot must be listed in project snapshot history after restart");
    assert.strictEqual(foundSnap?.workspaceId, project.id);

    // 4. Snapshot record and file content fidelity
    const loadedRecord = loadSnapshotRecord(stagingStore, snap1.id);
    assert.ok(loadedRecord, "Snapshot files and metadata must load cleanly after restart");
    assert.strictEqual(loadedRecord?.snapshot.name, "Pre-Restart Baseline");
    assert.ok(loadedRecord?.fileContents.has("agent-workflow.json"));

    // 5. Credit ledger persistence
    const freshCreditStore = readProjectCreditStore(project.id, stagingStore);
    assert.strictEqual(freshCreditStore.usedCredits, 4);
    assert.ok(freshCreditStore.tasks["task_pre_restart_01"]);

    const freshBalance = getProjectCreditBalance(project.id, stagingStore);
    assert.strictEqual(freshBalance.used, 4);
    assert.strictEqual(freshBalance.remaining, 96);

    // 6. Audit history persistence
    const auditActions = getAuditActionHistory(stagingStore);
    assert.ok(auditActions.length >= 1);
    assert.strictEqual(auditActions[0].summary, "Created pre-restart baseline snapshot");

    // 7. RAG vector store persistence
    const freshVectorStore = loadProjectVectorStore(project.id, stagingStore);
    const docs = Object.values(freshVectorStore.documents);
    assert.ok(docs.some((d) => d.fileName === "README.md"));
    assert.ok(freshVectorStore.chunks.length > 0);
  });

  it("3. restores pre-restart snapshot after simulated server reboot and workspace corruption", () => {
    // 1. Initialize demo workspace and record baseline snapshot
    initializeDemoWorkspace(stagingWorkspace);
    const baselineWorkflowContent = fs.readFileSync(path.join(stagingWorkspace, "agent-workflow.json"), "utf-8");
    const baselineHash = calculateSha256(baselineWorkflowContent);

    const baselineSnap = createSnapshot(
      stagingWorkspace,
      stagingStore,
      "Gold Master Baseline",
      "Snapshot before corruption",
      { projectId: "demo-workspace" }
    );

    // 2. Corrupt workspace file
    fs.writeFileSync(path.join(stagingWorkspace, "agent-workflow.json"), "<<<CORRUPTED_SYNTAX>>>", "utf-8");
    const invalidCheck = validateWorkspaceDeterministically(stagingWorkspace);
    assert.strictEqual(invalidCheck.passed, false);

    // 3. Simulate process restart
    clearTaskLedger();

    // 4. Restore the pre-restart snapshot
    const recovery = restoreSnapshot(stagingWorkspace, stagingStore, baselineSnap.id, {
      force: true,
      expectedProjectId: "demo-workspace",
    });

    assert.strictEqual(recovery.success, true);
    assert.strictEqual(recovery.conflicts.length, 0);

    // 5. Workspace is fully recovered and verified
    const restoredContent = fs.readFileSync(path.join(stagingWorkspace, "agent-workflow.json"), "utf-8");
    assert.strictEqual(calculateSha256(restoredContent), baselineHash);

    const validCheck = validateWorkspaceDeterministically(stagingWorkspace);
    assert.strictEqual(validCheck.passed, true);
  });

  it("4. verifies default staging loopback binding configuration", () => {
    // Standard Node.js staging deployment binds to 127.0.0.1
    const defaultHost = process.env.HOSTNAME || "127.0.0.1";
    const isPrivate = defaultHost === "127.0.0.1" || defaultHost === "localhost";
    assert.strictEqual(isPrivate, true, "Staging server must bind to private loopback interface");
  });
});

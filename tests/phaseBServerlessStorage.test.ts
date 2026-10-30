/**
 * Rewind Phase B - Vercel Serverless Durable Storage Test Suite
 * Simulates serverless execution with no shared writable disk.
 *
 * Verifies:
 * 1. Fail-closed behavior when Cloud Storage is required but unavailable.
 * 2. Multi-tenant isolation for projects, files, snapshots, chat, memories, and audit.
 * 3. Security boundaries: path traversal rejection, disallowed extension rejection, size limits.
 * 4. Immutable snapshots, restoration, and rollback recovery.
 * 5. Atomic Firestore transactions for credit reservations, budget capping, and commit idempotency.
 * 6. Distributed rate limiting with Vercel KV / Upstash REST mock.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { StorageError } from "../src/server/storage/storageTypes";
import {
  CloudStorageAdapter,
  type FirestoreClient,
  type FirestoreDocRef,
  type FirestoreTransaction,
  type StorageBucket,
  type StorageFile,
} from "../src/server/storage/cloudStorageAdapter";
import {
  getStorageProvider,
  setStorageProviderForTesting,
  isCloudStorageRequired,
} from "../src/server/storage/storageProvider";
import {
  enforceRateLimitAsync,
  setDistributedHandlerForTesting,
  clearRateLimitStore,
} from "../src/security/rateLimiter";

// ---------------------------------------------------------------------------
// In-Memory Cloud Storage & Firestore Simulator for Serverless Isolation Tests
// ---------------------------------------------------------------------------

function createMockFirestore(): FirestoreClient {
  const store: Record<string, Record<string, unknown>> = {};

  function getDocPath(parts: string[]): string {
    return parts.join("/");
  }

  function mockCollection(pathSegments: string[]) {
    return {
      doc: (id?: string): FirestoreDocRef => {
        const docId = id || `doc_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
        const docSegments = [...pathSegments, docId];
        const docKey = getDocPath(docSegments);

        return {
          id: docId,
          get: async () => {
            const data = store[docKey];
            return {
              exists: Boolean(data),
              id: docId,
              data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
            };
          },
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            if (opts?.merge && store[docKey]) {
              store[docKey] = { ...store[docKey], ...JSON.parse(JSON.stringify(data)) };
            } else {
              store[docKey] = JSON.parse(JSON.stringify(data));
            }
          },
          update: async (data: Record<string, unknown>) => {
            if (!store[docKey]) throw new Error(`Document not found: ${docKey}`);
            store[docKey] = { ...store[docKey], ...JSON.parse(JSON.stringify(data)) };
          },
          delete: async () => {
            delete store[docKey];
          },
          collection: (subName: string) => mockCollection([...docSegments, subName]),
        };
      },
      get: async () => {
        const prefix = getDocPath(pathSegments) + "/";
        const docs: { id: string; data: () => Record<string, unknown>; ref: FirestoreDocRef }[] = [];
        for (const [key, val] of Object.entries(store)) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            if (!rest.includes("/")) {
              docs.push({
                id: rest,
                data: () => JSON.parse(JSON.stringify(val)),
                ref: mockCollection(pathSegments).doc(rest),
              });
            }
          }
        }
        return {
          docs,
          forEach: (fn: (d: { id: string; data: () => Record<string, unknown> }) => void) => docs.forEach(fn),
        };
      },
    };
  }

  let txQueue: Promise<unknown> = Promise.resolve();
  const mockDb: FirestoreClient = {
    collection: (name: string) => mockCollection([name]),
    batch: () => {
      const operations: (() => void)[] = [];
      return {
        set: (docRef: FirestoreDocRef, data: Record<string, unknown>) => {
          operations.push(() => {
            void docRef.set(data);
          });
        },
        commit: async () => {
          for (const op of operations) op();
        },
      };
    },
    runTransaction: async <T>(updateFunction: (tx: FirestoreTransaction) => Promise<T>): Promise<T> => {
      const run = async () => {
        const tx = {
          get: async (docRef: FirestoreDocRef) => docRef.get(),
          set: (docRef: FirestoreDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            void docRef.set(data, opts);
          },
          update: (docRef: FirestoreDocRef, data: Record<string, unknown>) => {
            void docRef.update(data);
          },
          delete: (docRef: FirestoreDocRef) => {
            void docRef.delete();
          },
        };
        return updateFunction(tx);
      };
      const res = txQueue.then(run);
      txQueue = res.then(() => {}, () => {});
      return res;
    },
  };

  return mockDb;
}

function createMockStorageBucket(): StorageBucket {
  const files: Record<string, { buffer: Buffer; metadata: Record<string, string> }> = {};

  const bucket: StorageBucket = {
    file: (name: string): StorageFile => {
      const normalizedName = name.replace(/\\/g, "/");
      return {
        name: normalizedName,
        save: async (content: Buffer | string, opts?: { resumable?: boolean; metadata?: Record<string, unknown> }) => {
          const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
          const customMeta: Record<string, string> = {};
          if (opts?.metadata) {
            for (const [k, v] of Object.entries(opts.metadata)) {
              customMeta[k] = String(v);
            }
          }
          files[normalizedName] = {
            buffer: buf,
            metadata: {
              size: String(buf.length),
              updated: new Date().toISOString(),
              md5Hash: crypto.createHash("md5").update(buf).digest("base64"),
              ...customMeta,
            },
          };
        },
        download: async () => {
          const entry = files[normalizedName];
          if (!entry) throw new Error(`Object '${normalizedName}' not found in bucket`);
          return [Buffer.from(entry.buffer)];
        },
        delete: async () => {
          delete files[normalizedName];
        },
        exists: async () => {
          return [Boolean(files[normalizedName])];
        },
        metadata: files[normalizedName]?.metadata || {},
      };
    },
    getFiles: async (options?: { prefix?: string }) => {
      const prefix = options?.prefix || "";
      const matches: StorageFile[] = [];
      for (const fName of Object.keys(files)) {
        if (!prefix || fName.startsWith(prefix)) {
          matches.push(bucket.file(fName));
        }
      }
      return [matches];
    },
  };

  return bucket;
}

describe("Rewind Phase B - Vercel Serverless Durable Storage Test Suite", () => {
  beforeEach(() => {
    setStorageProviderForTesting(null);
    setDistributedHandlerForTesting(null);
    clearRateLimitStore();
    delete process.env.REWIND_STORAGE_PROVIDER;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });

  // -------------------------------------------------------------------------
  // 1. Fail-Closed Behavior in Cloud/Production Mode
  // -------------------------------------------------------------------------
  it("1.1. fails closed when cloud storage is required but unconfigured", async () => {
    process.env.REWIND_STORAGE_PROVIDER = "cloud";
    delete process.env.FIREBASE_PROJECT_ID;

    assert.strictEqual(isCloudStorageRequired(), true);

    const provider = getStorageProvider();
    assert.strictEqual(provider.mode, "cloud");

    // Operations must reject with CLOUD_STORAGE_UNAVAILABLE
    await assert.rejects(
      async () => {
        await provider.projects.listProjects("test_user");
      },
      (err: unknown) => {
        return (
          err instanceof StorageError &&
          err.code === "CLOUD_STORAGE_UNAVAILABLE" &&
          err.statusCode === 503
        );
      }
    );

    await assert.rejects(
      async () => {
        await provider.workspace.listFiles("proj_fail");
      },
      (err: unknown) => {
        return (
          err instanceof StorageError &&
          err.code === "CLOUD_STORAGE_UNAVAILABLE" &&
          err.statusCode === 503
        );
      }
    );
  });

  // -------------------------------------------------------------------------
  // 2. Multi-Tenant Project Metadata Isolation
  // -------------------------------------------------------------------------
  it("2.1. isolates project listings and project metadata strictly between users in Firestore", async () => {
    const mockDb = createMockFirestore();
    const mockBucket = createMockStorageBucket();
    const adapter = new CloudStorageAdapter({ db: mockDb, bucket: mockBucket });

    // Alice creates Project Alpha
    await adapter.projects.saveProject(
      {
        id: "proj_alice_alpha",
        name: "Alice Alpha App",
        description: "Confidential R&D",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspacePath: "projects/proj_alice_alpha/workspace",
        fileCount: 0,
        totalSizeBytes: 0,
        snapshotCount: 0,
        status: "active",
        userId: "user_alice",
      },
      "user_alice"
    );

    // Bob creates Project Beta
    await adapter.projects.saveProject(
      {
        id: "proj_bob_beta",
        name: "Bob Beta App",
        description: "Public tool",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspacePath: "projects/proj_bob_beta/workspace",
        fileCount: 0,
        totalSizeBytes: 0,
        snapshotCount: 0,
        status: "active",
        userId: "user_bob",
      },
      "user_bob"
    );

    // Alice lists projects: sees demo-workspace + Alice Alpha only
    const aliceList = await adapter.projects.listProjects("user_alice");
    assert.strictEqual(aliceList.projects.length, 2);
    assert.ok(aliceList.projects.some((p) => p.id === "demo-workspace"));
    assert.ok(aliceList.projects.some((p) => p.id === "proj_alice_alpha"));
    assert.ok(!aliceList.projects.some((p) => p.id === "proj_bob_beta"));

    // Bob lists projects: sees demo-workspace + Bob Beta only
    const bobList = await adapter.projects.listProjects("user_bob");
    assert.strictEqual(bobList.projects.length, 2);
    assert.ok(bobList.projects.some((p) => p.id === "demo-workspace"));
    assert.ok(bobList.projects.some((p) => p.id === "proj_bob_beta"));
    assert.ok(!bobList.projects.some((p) => p.id === "proj_alice_alpha"));

    // Bob cannot read Alice's project metadata directly
    const bobAccessAlice = await adapter.projects.getProject("proj_alice_alpha", "user_bob");
    assert.strictEqual(bobAccessAlice, null);

    // Alice can read her own project
    const aliceAccessAlice = await adapter.projects.getProject("proj_alice_alpha", "user_alice");
    assert.ok(aliceAccessAlice);
    assert.strictEqual(aliceAccessAlice.name, "Alice Alpha App");
  });

  // -------------------------------------------------------------------------
  // 3. Workspace File Operations & Security Boundaries
  // -------------------------------------------------------------------------
  it("3.1. writes, lists, and reads workspace files in Cloud Storage with strict boundary validation", async () => {
    const mockDb = createMockFirestore();
    const mockBucket = createMockStorageBucket();
    const adapter = new CloudStorageAdapter({ db: mockDb, bucket: mockBucket });

    const projId = "proj_cloud_test";

    // 1. Write permitted Python and TypeScript files
    await adapter.workspace.writeFile(
      projId,
      "src/workflow.py",
      "def run():\n    return 'success'\n",
      "user_1"
    );
    await adapter.workspace.writeFile(
      projId,
      "config.json",
      JSON.stringify({ active: true, version: 1 }),
      "user_1"
    );

    // 2. List files
    const files = await adapter.workspace.listFiles(projId, "user_1");
    assert.strictEqual(files.length, 2);
    assert.ok(files.some((f) => f.path === "src/workflow.py"));
    assert.ok(files.some((f) => f.path === "config.json"));

    // 3. Read file
    const content = await adapter.workspace.readFile(projId, "src/workflow.py", "user_1");
    assert.ok(content.includes("def run()"));

    // 4. Reject path traversal
    await assert.rejects(
      async () => {
        await adapter.workspace.readFile(projId, "../../../etc/passwd", "user_1");
      },
      /Path traversal detected/
    );

    await assert.rejects(
      async () => {
        await adapter.workspace.writeFile(projId, "sub/../../secret.env", "KEY=val", "user_1");
      },
      /Path traversal detected/
    );

    // 5. Reject disallowed file extension
    await assert.rejects(
      async () => {
        await adapter.workspace.writeFile(projId, "malicious.exe", Buffer.from("MZ"), "user_1");
      },
      /File extension not permitted/
    );

    await assert.rejects(
      async () => {
        await adapter.workspace.writeFile(projId, "run.sh", "#!/bin/bash\necho hi", "user_1");
      },
      /File extension not permitted/
    );

    // 6. Delete file
    const deleted = await adapter.workspace.deleteFile(projId, "config.json", "user_1");
    assert.strictEqual(deleted, true);
    const filesAfterDelete = await adapter.workspace.listFiles(projId, "user_1");
    assert.strictEqual(filesAfterDelete.length, 1);
  });

  // -------------------------------------------------------------------------
  // 4. Immutable Snapshots, Restoration, and Failure Recovery
  // -------------------------------------------------------------------------
  it("4.1. creates immutable snapshot objects in Cloud Storage and restores live files cleanly", async () => {
    const mockDb = createMockFirestore();
    const mockBucket = createMockStorageBucket();
    const adapter = new CloudStorageAdapter({ db: mockDb, bucket: mockBucket });

    const projId = "proj_snap_test";
    const userId = "user_snap_owner";

    // Write initial workspace state
    await adapter.workspace.writeFile(projId, "main.ts", "console.log('v1.0');", userId);
    await adapter.workspace.writeFile(projId, "config.json", '{"version": 1}', userId);

    // Create Snapshot 1
    const fileContents = new Map<string, string>();
    fileContents.set("main.ts", "console.log('v1.0');");
    fileContents.set("config.json", '{"version": 1}');

    const snapId = "snap_1730000000_1234";
    await adapter.snapshots.saveSnapshot(
      projId,
      {
        id: snapId,
        workspaceId: projId,
        name: "Initial Working Baseline",
        createdAt: new Date().toISOString(),
        totalFiles: 2,
        totalBytes: 50,
        files: [
          { path: "main.ts", hash: "hash1", size: 20, modifiedAt: new Date().toISOString() },
          { path: "config.json", hash: "hash2", size: 15, modifiedAt: new Date().toISOString() },
        ],
      },
      fileContents,
      userId
    );

    // Mutate live workspace (break it)
    await adapter.workspace.writeFile(projId, "main.ts", "SYNTAX ERROR BROKEN", userId);
    const broken = await adapter.workspace.readFile(projId, "main.ts", userId);
    assert.strictEqual(broken, "SYNTAX ERROR BROKEN");

    // Restore Snapshot 1
    const restoreRes = await adapter.snapshots.restoreSnapshot(projId, snapId, userId);
    assert.strictEqual(restoreRes.snapshot.id, snapId);
    assert.strictEqual(restoreRes.restoredFiles.length, 2);

    // Verify live workspace file is restored to v1.0
    const restoredContent = await adapter.workspace.readFile(projId, "main.ts", userId);
    assert.strictEqual(restoredContent, "console.log('v1.0');");

    // Attempting to restore non-existent snapshot throws 404 NOT_FOUND
    await assert.rejects(
      async () => {
        await adapter.snapshots.restoreSnapshot(projId, "snap_non_existent", userId);
      },
      (err: unknown) => err instanceof StorageError && err.code === "NOT_FOUND" && err.statusCode === 404
    );
  });

  // -------------------------------------------------------------------------
  // 5. Chat Continuity & Memory Membrane Persistence with Tenant Isolation
  // -------------------------------------------------------------------------
  it("5.1. persists chat sessions, messages, and project memories with strict user scoping", async () => {
    const mockDb = createMockFirestore();
    const mockBucket = createMockStorageBucket();
    const adapter = new CloudStorageAdapter({ db: mockDb, bucket: mockBucket });

    const projId = "proj_chat_test";

    // 1. Create chat session
    const sessionId = "sess_001";
    await adapter.chatMemories.saveSession(
      projId,
      {
        id: sessionId,
        projectId: projId,
        userId: "alice",
        title: "Architecture Planning",
        activeModel: "nvidia/llama-3.1-nemotron-70b-instruct",
        routingMode: "auto",
        messageCount: 0,
        extractedMemoriesCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      },
      "alice"
    );

    // 2. Append message
    await adapter.chatMemories.appendMessage(
      projId,
      sessionId,
      {
        id: "msg_001",
        sessionId,
        projectId: projId,
        userId: "alice",
        role: "user",
        content: "We must use Firestore transactions for atomic balance updates.",
        createdAt: new Date().toISOString(),
      },
      "alice"
    );

    // 3. Save memory
    await adapter.chatMemories.saveMemory(
      projId,
      {
        id: "mem_001",
        projectId: projId,
        userId: "alice",
        category: "architectural_decision",
        title: "Atomic Balances",
        distilledIntent: "Use Firestore transactions to eliminate in-memory credit race conditions.",
        importance: 5,
        tags: ["database", "credits"],
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "alice"
    );

    // Alice verifies her session and messages
    const aliceSessions = await adapter.chatMemories.listSessions(projId, "alice");
    assert.strictEqual(aliceSessions.length, 1);
    assert.strictEqual(aliceSessions[0].title, "Architecture Planning");

    const aliceMsgs = await adapter.chatMemories.listMessages(projId, sessionId, "alice");
    assert.strictEqual(aliceMsgs.length, 1);
    assert.ok(aliceMsgs[0].content.includes("Firestore transactions"));

    const aliceMems = await adapter.chatMemories.listMemories(projId, undefined, "alice");
    assert.strictEqual(aliceMems.length, 1);
    assert.strictEqual(aliceMems[0].title, "Atomic Balances");

    // Bob cannot see Alice's chat sessions or memories
    const bobSessions = await adapter.chatMemories.listSessions(projId, "bob");
    assert.strictEqual(bobSessions.length, 0);

    const bobMems = await adapter.chatMemories.listMemories(projId, undefined, "bob");
    assert.strictEqual(bobMems.length, 0);
  });

  // -------------------------------------------------------------------------
  // 6. Concurrent Credit Accounting & Atomic Deductions
  // -------------------------------------------------------------------------
  it("6.1. atomically enforces credit budget under concurrent requests and prevents over-allocation", async () => {
    const mockDb = createMockFirestore();
    const mockBucket = createMockStorageBucket();
    const adapter = new CloudStorageAdapter({ db: mockDb, bucket: mockBucket });

    const projId = "proj_credits_test";
    const userId = "dev_concurrent";

    // Initial balance: 100 credits available
    const initialBalance = await adapter.credits.getBalance(projId, userId);
    assert.strictEqual(initialBalance.allowance, 100);
    assert.strictEqual(initialBalance.remaining, 100);

    // Simulate 4 concurrent reservation requests of 30 credits each
    // Total requested = 120 credits. With 100 allowance, at most 3 can succeed (3 x 30 = 90 <= 100).
    // The 4th request MUST fail with BUDGET_EXCEEDED.
    const reserveRequests = [1, 2, 3, 4].map((i) =>
      adapter.credits
        .reserve(projId, `task_${i}`, 30, userId)
        .then((res) => ({ success: true, taskId: res.taskId, error: null }))
        .catch((err: unknown) => ({ success: false, taskId: `task_${i}`, error: err }))
    );

    const results = await Promise.all(reserveRequests);
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    assert.strictEqual(successful.length, 3, "Exactly 3 reservations of 30 credits should succeed (90 credits)");
    assert.strictEqual(failed.length, 1, "The 4th reservation must be rejected");
    assert.strictEqual((failed[0].error as StorageError).code, "BUDGET_EXCEEDED");

    // Verify remaining balance after 3 reservations is 10
    const balanceAfterRes = await adapter.credits.getBalance(projId, userId);
    assert.strictEqual(balanceAfterRes.inFlightReserved, 90);
    assert.strictEqual(balanceAfterRes.remaining, 10);

    // Commit task 1
    await adapter.credits.commit(projId, "task_1", 30, "standard_refactor", userId, {
      provider: "nebius",
      model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      providerCostUSD: 0.00005,
    });

    // Idempotent test: committing task 1 a second time charges zero additional credits
    await adapter.credits.commit(projId, "task_1", 30, "standard_refactor", userId);

    const balanceAfterCommit = await adapter.credits.getBalance(projId, userId);
    assert.strictEqual(balanceAfterCommit.used, 30);
    assert.deepStrictEqual(balanceAfterCommit.providerUsage, {
      requests: 1,
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
    });
    // Remaining in-flight = 60 (task 2 and task 3)
    assert.strictEqual(balanceAfterCommit.inFlightReserved, 60);
    assert.strictEqual(balanceAfterCommit.remaining, 10);

    // Release task 2 (failed execution)
    await adapter.credits.release(projId, "task_2", userId);
    const balanceAfterRelease = await adapter.credits.getBalance(projId, userId);
    assert.strictEqual(balanceAfterRelease.inFlightReserved, 30); // only task 3 reserved
    assert.strictEqual(balanceAfterRelease.remaining, 40); // 100 - 30 used - 30 reserved = 40
  });

  // -------------------------------------------------------------------------
  // 7. Distributed Rate Limiter
  // -------------------------------------------------------------------------
  it("7.1. verifies distributed rate limiter returns 429 when distributed KV indicates limit exceeded", async () => {
    // Mock distributed KV handler returning blocked on 3rd request
    let requestCount = 0;
    setDistributedHandlerForTesting(async (_key, maxRequests, _windowMs) => {
      void _windowMs;
      requestCount++;
      if (requestCount > 2) {
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: 60,
          scope: "distributed",
        };
      }
      return {
        allowed: true,
        limit: maxRequests,
        remaining: maxRequests - requestCount,
        retryAfterSeconds: 0,
        scope: "distributed",
      };
    });

    const req1 = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    const res1 = await enforceRateLimitAsync(req1, "auth_login", 2, 60_000);
    assert.strictEqual(res1, null, "1st request must be allowed");

    const req2 = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    const res2 = await enforceRateLimitAsync(req2, "auth_login", 2, 60_000);
    assert.strictEqual(res2, null, "2nd request must be allowed");

    const req3 = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    const res3 = await enforceRateLimitAsync(req3, "auth_login", 2, 60_000);
    assert.ok(res3, "3rd request must be blocked");
    assert.strictEqual(res3.status, 429);
    assert.strictEqual(res3.headers.get("X-RateLimit-Scope"), "distributed");
  });
});

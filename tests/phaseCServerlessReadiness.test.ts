/**
 * Rewind Phase C - Vercel Serverless Production Readiness & Outage Resilience Suite
 *
 * NOTE ON TESTING METHODOLOGY:
 * - All tests in this file use simulated in-memory cloud models [Simulated Cloud / Mocked],
 *   validating the cloud adapter architecture, concurrency, multi-tenant isolation,
 *   outage handling, and fail-closed behaviors without incurring cloud costs or modifying real infrastructure.
 * - Real live cloud deployments must be verified using the Phase C smoke test checklist.
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
import type { ProjectMetadata } from "../src/types/project";
import type { Snapshot } from "../src/types/recovery";
import type { ChatSession, ChatMessage } from "../src/types/chat";
import type { ProjectMemory } from "../src/types/memory";

// ---------------------------------------------------------------------------
// Shared Cloud Simulators (Firestore & Cloud Storage)
// ---------------------------------------------------------------------------

function createSharedCloudEnvironment() {
  const firestoreStore: Record<string, Record<string, unknown>> = {};
  const storageFiles: Map<string, { buffer: Buffer; metadata: Record<string, string> }> = new Map();

  let transactionQueue = Promise.resolve();

  const mockFirestore: FirestoreClient = {
    collection: (collName: string) => mockCollection([collName]),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (docRef: FirestoreDocRef, data: Record<string, unknown>) => {
          ops.push(() => {
            void docRef.set(data);
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async <T>(updateFunction: (tx: FirestoreTransaction) => Promise<T>): Promise<T> => {
      const run = async () => {
        const tx: FirestoreTransaction = {
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

      const resultPromise = transactionQueue.then(run);
      transactionQueue = resultPromise.then(() => {}, () => {});
      return resultPromise;
    },
  };

  function mockCollection(pathSegments: string[]) {
    return {
      doc: (id?: string): FirestoreDocRef => {
        const docId = id || `doc_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
        const docSegments = [...pathSegments, docId];
        const docKey = docSegments.join("/");

        return {
          id: docId,
          get: async () => {
            const data = firestoreStore[docKey];
            return {
              exists: Boolean(data),
              id: docId,
              data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
            };
          },
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            if (opts?.merge && firestoreStore[docKey]) {
              firestoreStore[docKey] = { ...firestoreStore[docKey], ...JSON.parse(JSON.stringify(data)) };
            } else {
              firestoreStore[docKey] = JSON.parse(JSON.stringify(data));
            }
          },
          update: async (data: Record<string, unknown>) => {
            if (!firestoreStore[docKey]) {
              throw new Error(`Document not found: ${docKey}`);
            }
            firestoreStore[docKey] = { ...firestoreStore[docKey], ...JSON.parse(JSON.stringify(data)) };
          },
          delete: async () => {
            delete firestoreStore[docKey];
          },
          collection: (subName: string) => mockCollection([...docSegments, subName]),
        };
      },
      get: async () => {
        const prefix = pathSegments.join("/") + "/";
        const docs: { id: string; data: () => Record<string, unknown>; ref: FirestoreDocRef }[] = [];

        for (const [key, val] of Object.entries(firestoreStore)) {
          if (key.startsWith(prefix)) {
            const remainder = key.slice(prefix.length);
            if (!remainder.includes("/")) {
              docs.push({
                id: remainder,
                data: () => JSON.parse(JSON.stringify(val)),
                ref: {
                  id: remainder,
                  get: async () => ({ exists: true, id: remainder, data: () => val }),
                  set: async (d) => { firestoreStore[key] = d; },
                  update: async (d) => { firestoreStore[key] = { ...firestoreStore[key], ...d }; },
                  delete: async () => { delete firestoreStore[key]; },
                  collection: (sub) => mockCollection([...pathSegments, remainder, sub]),
                },
              });
            }
          }
        }

        return {
          docs,
          forEach: (fn: (doc: { id: string; data: () => Record<string, unknown> }) => void) => docs.forEach(fn),
        };
      },
    };
  }

  const mockBucket: StorageBucket = {
    file: (cloudPath: string) => ({
      name: cloudPath,
      exists: async () => [storageFiles.has(cloudPath)],
      save: async (data: Buffer, opts?: { metadata?: { contentType?: string } }) => {
        storageFiles.set(cloudPath, {
          buffer: Buffer.from(data),
          metadata: {
            size: String(data.length),
            updated: new Date().toISOString(),
            contentType: opts?.metadata?.contentType || "application/octet-stream",
          },
        });
      },
      download: async () => {
        const stored = storageFiles.get(cloudPath);
        if (!stored) throw new Error(`Object not found in Cloud Storage: ${cloudPath}`);
        return [stored.buffer];
      },
      delete: async () => {
        const deleted = storageFiles.delete(cloudPath);
        if (!deleted) throw new Error(`Object not found to delete: ${cloudPath}`);
      },
    }),
    getFiles: async (query?: { prefix?: string }) => {
      const prefix = query?.prefix || "";
      const matchedFiles = [];
      for (const [name, meta] of storageFiles.entries()) {
        if (name.startsWith(prefix)) {
          matchedFiles.push({
            name,
            exists: async () => [storageFiles.has(name)],
            metadata: meta.metadata,
            download: async (): Promise<[Buffer]> => [meta.buffer],
            delete: async () => { storageFiles.delete(name); },
            save: async (data: Buffer) => {
              storageFiles.set(name, { buffer: data, metadata: meta.metadata });
            },
          });
        }
      }
      return [matchedFiles] as unknown as [StorageFile[]];
    },
  };

  return { mockFirestore, mockBucket, firestoreStore, storageFiles };
}

// ---------------------------------------------------------------------------
// Phase C Test Suite
// ---------------------------------------------------------------------------

describe("Rewind Phase C - Vercel Serverless Production Readiness & Resilience Suite [Simulated Cloud / Mocked]", () => {
  beforeEach(() => {
    setStorageProviderForTesting(null);
    setDistributedHandlerForTesting(null);
    clearRateLimitStore();
    delete process.env.REQUIRE_CLOUD_STORAGE;
    delete process.env.REWIND_STORAGE_PROVIDER;
  });

  it("1.1 [Simulated Cloud] simulates separate serverless instances sharing cloud state with zero shared local disk", async () => {
    const cloud = createSharedCloudEnvironment();

    // Instance 1 writes state to Cloud Storage and Firestore
    const instance1 = new CloudStorageAdapter(cloud.mockFirestore, cloud.mockBucket);

    const project: ProjectMetadata = {
      id: "proj_cloud_stateless_1",
      name: "Cloud Stateless Project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: "projects/proj_cloud_stateless_1",
      fileCount: 2,
      totalSizeBytes: 120,
      snapshotCount: 1,
      status: "active",
      userId: "user_alpha",
    };

    await instance1.projects.saveProject(project, "user_alpha");
    await instance1.workspace.writeFile("proj_cloud_stateless_1", "src/index.ts", "console.log('instance 1');", "user_alpha");

    const session: ChatSession = {
      id: "sess_cloud_1",
      projectId: "proj_cloud_stateless_1",
      title: "Architecture Planning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 1,
      extractedMemoriesCount: 0,
      lastMessageAt: new Date().toISOString(),
      activeModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
      routingMode: "auto",
      userId: "user_alpha",
    };
    await instance1.chatMemories.saveSession("proj_cloud_stateless_1", session, "user_alpha");

    const message: ChatMessage = {
      id: "msg_cloud_1",
      sessionId: "sess_cloud_1",
      projectId: "proj_cloud_stateless_1",
      role: "user",
      content: "Ensure serverless instances share state via cloud.",
      createdAt: new Date().toISOString(),
      userId: "user_alpha",
    };
    await instance1.chatMemories.appendMessage("proj_cloud_stateless_1", "sess_cloud_1", message, "user_alpha");

    // Instance 2 spins up in a fresh process context with empty local disk
    const instance2 = new CloudStorageAdapter(cloud.mockFirestore, cloud.mockBucket);

    const fetchedProject = await instance2.projects.getProject("proj_cloud_stateless_1", "user_alpha");
    assert.ok(fetchedProject, "Instance 2 must resolve project created by Instance 1");
    assert.strictEqual(fetchedProject.name, "Cloud Stateless Project");

    const fetchedFile = await instance2.workspace.readFile("proj_cloud_stateless_1", "src/index.ts", "user_alpha");
    assert.strictEqual(fetchedFile, "console.log('instance 1');");

    const fetchedMessages = await instance2.chatMemories.listMessages("proj_cloud_stateless_1", "sess_cloud_1", "user_alpha");
    assert.strictEqual(fetchedMessages.length, 1);
    assert.strictEqual(fetchedMessages[0].content, "Ensure serverless instances share state via cloud.");
  });

  it("1.2 [Simulated Cloud] strictly enforces multi-tenant boundary isolation across all domains", async () => {
    const cloud = createSharedCloudEnvironment();
    const adapter = new CloudStorageAdapter(cloud.mockFirestore, cloud.mockBucket);

    // Alice creates resources
    const aliceProject: ProjectMetadata = {
      id: "proj_alice_confidential",
      name: "Alice Secret App",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: "projects/proj_alice_confidential",
      fileCount: 1,
      totalSizeBytes: 50,
      snapshotCount: 0,
      status: "active",
      userId: "user_alice",
    };
    await adapter.projects.saveProject(aliceProject, "user_alice");
    await adapter.workspace.writeFile("proj_alice_confidential", "secrets.json", '{"key": "alice_secret"}', "user_alice");

    const aliceMemory: ProjectMemory = {
      id: "mem_alice_1",
      projectId: "proj_alice_confidential",
      userId: "user_alice",
      category: "architectural_decision",
      title: "Security Boundary",
      distilledIntent: "Never share data with Bob",
      importance: 5,
      tags: ["security"],
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await adapter.chatMemories.saveMemory("proj_alice_confidential", aliceMemory, "user_alice");

    // Bob attempts cross-tenant access
    const bobProjects = await adapter.projects.listProjects("user_bob");
    assert.strictEqual(
      bobProjects.projects.some((p) => p.id === "proj_alice_confidential"),
      false,
      "Bob must never see Alice's project in their project listing"
    );

    const bobProjectAccess = await adapter.projects.getProject("proj_alice_confidential", "user_bob");
    assert.strictEqual(bobProjectAccess, null, "Bob must receive null when querying Alice's project metadata");

    const bobMemories = await adapter.chatMemories.listMemories("proj_alice_confidential", undefined, "user_bob");
    assert.strictEqual(bobMemories.length, 0, "Bob must receive zero memories when querying Alice's project");
  });

  it("1.3 [Simulated Cloud] ensures snapshot restoration handles multi-file restoration with zero data corruption", async () => {
    const cloud = createSharedCloudEnvironment();
    const adapter = new CloudStorageAdapter(cloud.mockFirestore, cloud.mockBucket);

    const projectId = "proj_snapshot_verify";
    await adapter.workspace.writeFile(projectId, "app.ts", "const v = 1;", "user_test");
    await adapter.workspace.writeFile(projectId, "config.json", '{"version": 1}', "user_test");

    const files = new Map<string, string>();
    files.set("app.ts", "const v = 1;");
    files.set("config.json", '{"version": 1}');

    const snapshot: Snapshot = {
      id: "snap_v1",
      workspaceId: projectId,
      name: "Version 1 Snapshot",
      createdAt: new Date().toISOString(),
      totalFiles: 2,
      totalBytes: 30,
      files: [
        { path: "app.ts", hash: "hash1", size: 12, modifiedAt: new Date().toISOString() },
        { path: "config.json", hash: "hash2", size: 15, modifiedAt: new Date().toISOString() },
      ],
    };

    await adapter.snapshots.saveSnapshot(projectId, snapshot, files, "user_test");

    // Corrupt active workspace
    await adapter.workspace.writeFile(projectId, "app.ts", "CORRUPTED CONTENT", "user_test");
    await adapter.workspace.deleteFile(projectId, "config.json", "user_test");

    // Restore from snapshot
    const restoreResult = await adapter.snapshots.restoreSnapshot(projectId, "snap_v1", "user_test");
    assert.strictEqual(restoreResult.restoredFiles.length, 2);

    const restoredApp = await adapter.workspace.readFile(projectId, "app.ts", "user_test");
    const restoredConfig = await adapter.workspace.readFile(projectId, "config.json", "user_test");

    assert.strictEqual(restoredApp, "const v = 1;");
    assert.strictEqual(restoredConfig, '{"version": 1}');
  });

  it("1.4 [Simulated Cloud] enforces distributed rate limiting across simulated serverless instances", async () => {
    const redisStore = new Map<string, number>();

    setDistributedHandlerForTesting(async (key: string, maxRequests: number, windowMs: number) => {
      const current = redisStore.get(key) || 0;
      if (current >= maxRequests) {
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.ceil(windowMs / 1000),
          scope: "distributed",
        };
      }
      redisStore.set(key, current + 1);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: maxRequests - (current + 1),
        retryAfterSeconds: 0,
        scope: "distributed",
      };
    });

    const mockRequest = (ip: string) =>
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
      });

    // 5 requests from Instance A
    for (let i = 0; i < 5; i++) {
      const res = await enforceRateLimitAsync(mockRequest("203.0.113.1"), "login", 5, 60000);
      assert.strictEqual(res, null, `Request ${i + 1} should be permitted`);
    }

    // 6th request from Instance B with same IP must be blocked
    const blockedRes = await enforceRateLimitAsync(mockRequest("203.0.113.1"), "login", 5, 60000);
    assert.ok(blockedRes, "6th request across instances must be rate limited");
    assert.strictEqual(blockedRes.status, 429);
    assert.strictEqual(blockedRes.headers.get("X-RateLimit-Scope"), "distributed");
  });

  it("1.5 [Simulated Outage] safely degrades to local rate limiting during distributed Redis outage", async () => {
    // Simulate Redis outage where handler returns null (mimicking fetch timeout/500)
    setDistributedHandlerForTesting(async () => null);

    const mockRequest = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });

    // Should fall back to in-memory local limiter without throwing an unhandled rejection
    const res = await enforceRateLimitAsync(mockRequest, "login_outage_test", 2, 60000);
    assert.strictEqual(res, null, "Should allow request via local fallback");

    const res2 = await enforceRateLimitAsync(mockRequest, "login_outage_test", 2, 60000);
    assert.strictEqual(res2, null, "Should allow 2nd request via local fallback");

    const res3 = await enforceRateLimitAsync(mockRequest, "login_outage_test", 2, 60000);
    assert.ok(res3, "Should block 3rd request via local fallback");
    assert.strictEqual(res3.status, 429);
    assert.strictEqual(res3.headers.get("X-RateLimit-Scope"), "local");
  });

  it("1.6 [Simulated Outage] fails closed when Cloud Storage is mandated but unconfigured", () => {
    process.env.REQUIRE_CLOUD_STORAGE = "true";
    assert.strictEqual(isCloudStorageRequired(), true);

    const provider = getStorageProvider();
    assert.strictEqual(provider.mode, "cloud");

    // In unconfigured environment, accessing cloud store must throw CLOUD_STORAGE_UNAVAILABLE
    assert.rejects(
      async () => provider.projects.listProjects("test_user"),
      (err: unknown) => {
        assert.ok(err instanceof StorageError);
        assert.strictEqual(err.code, "CLOUD_STORAGE_UNAVAILABLE");
        assert.strictEqual(err.statusCode, 503);
        return true;
      }
    );
  });
});

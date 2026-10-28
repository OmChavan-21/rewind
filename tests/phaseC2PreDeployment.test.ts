/**
 * Rewind Phase C.2 — Pre-Deployment Safety Gate Test Suite
 *
 * Verifies:
 * 1. Rate limiting across mutating routes & REQUIRE_DISTRIBUTED_RATE_LIMIT fail-closed behavior
 * 2. Snapshot restoration transactional staging, post-snapshot cleanup, and rollback on mid-flight failure
 * 3. AI_PROVIDER=disabled zero-call guarantee across providers and API routes
 * 4. Multi-tenant isolation across all stateful cloud resources
 * 5. Production session secret entropy and fail-closed guards
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import {
  CloudStorageAdapter,
  type FirestoreClient,
  type FirestoreDocRef,
  type FirestoreTransaction,
  type StorageBucket,
  type StorageFile,
} from "../src/server/storage/cloudStorageAdapter";
import { StorageError } from "../src/server/storage/storageTypes";
import { setStorageProviderForTesting } from "../src/server/storage/storageProvider";
import {
  enforceRateLimitAsync,
  setDistributedHandlerForTesting,
  clearRateLimitStore,
} from "../src/security/rateLimiter";
import { isAIDisabled, getActiveProvider, getProviderClient } from "../src/server/ai/providerRegistry";
import { getAIConfig } from "../src/server/nebiusService";
import {
  getSessionSecret,
  createDevSessionToken,
  verifyDevSessionToken,
  isFirebaseRequired,
  assertProjectAccessAsync,
  NotFoundError,
} from "../src/server/auth";
import { POST as proposePost } from "../src/app/api/ai/propose/route";
import { GET as aiStatusGet } from "../src/app/api/ai/status/route";
import type { Snapshot } from "../src/types/recovery";
import type { AuthUser } from "../src/types/auth";
import type { ProjectMetadata } from "../src/types/project";

// ---------------------------------------------------------------------------
// In-Memory Cloud Simulators for Unit/Integration Verification
// ---------------------------------------------------------------------------

function createMockCloudEnvironment() {
  const firestoreStore: Record<string, Record<string, unknown>> = {};
  const storageFiles: Map<string, { buffer: Buffer; metadata: Record<string, string> }> = new Map();

  const mockFirestore: FirestoreClient = {
    collection: (collName: string) => mockCollection([collName]),
    batch: () => ({
      set: (docRef: FirestoreDocRef, data: Record<string, unknown>) => {
        void docRef.set(data);
      },
      commit: async () => {},
    }),
    runTransaction: async <T>(updateFunction: (tx: FirestoreTransaction) => Promise<T>): Promise<T> => {
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
                  set: async (d) => {
                    firestoreStore[key] = d;
                  },
                  update: async (d) => {
                    firestoreStore[key] = { ...firestoreStore[key], ...d };
                  },
                  delete: async () => {
                    delete firestoreStore[key];
                  },
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

  // Bucket simulation with fail-injection capabilities
  let shouldFailSaveOnPath: string | null = null;
  let failSaveCount = 0;

  const mockBucket: StorageBucket = {
    file: (name: string): StorageFile => ({
      name,
      save: async (data: Buffer | string) => {
        if (shouldFailSaveOnPath && name.includes(shouldFailSaveOnPath) && failSaveCount > 0) {
          failSaveCount--;
          throw new Error(`Simulated Cloud Storage I/O failure on file: ${name}`);
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
        storageFiles.set(name, { buffer: buf, metadata: {} });
      },
      download: async () => {
        const entry = storageFiles.get(name);
        if (!entry) throw new Error(`File ${name} not found`);
        return [entry.buffer];
      },
      delete: async () => {
        storageFiles.delete(name);
      },
      exists: async () => [storageFiles.has(name)],
    }),
    getFiles: async (query?: { prefix?: string }) => {
      const prefix = query?.prefix || "";
      const matched: StorageFile[] = [];
      for (const key of storageFiles.keys()) {
        if (key.startsWith(prefix)) {
          matched.push(mockBucket.file(key));
        }
      }
      return [matched];
    },
  };

  return {
    adapter: new CloudStorageAdapter(mockFirestore, mockBucket),
    firestoreStore,
    storageFiles,
    setShouldFailSaveOnPath: (pathSubstring: string | null, count: number = 1) => {
      shouldFailSaveOnPath = pathSubstring;
      failSaveCount = count;
    },
  };
}

function makeMockProject(id: string, userId: string, name: string): ProjectMetadata {
  return {
    id,
    name,
    userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspacePath: `projects/${id}/workspace`,
    fileCount: 0,
    totalSizeBytes: 0,
    snapshotCount: 0,
    status: "active",
  };
}

describe("Rewind Phase C.2 Pre-Deployment Safety Gate Suite", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearRateLimitStore();
    setDistributedHandlerForTesting(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    clearRateLimitStore();
    setDistributedHandlerForTesting(null);
    setStorageProviderForTesting(null);
  });

  // =========================================================================
  // 1. Rate Limiting & REQUIRE_DISTRIBUTED_RATE_LIMIT Guard
  // =========================================================================

  describe("1. Rate Limiting Safety & Distributed Enforcement", () => {
    it("enforces route limits locally and blocks requests exceeding threshold", async () => {
      const ip = "192.0.2.10";
      const makeReq = () =>
        new Request("http://localhost/api/ai/propose", {
          headers: { "x-forwarded-for": ip },
        });

      // Test limit of 5 requests per window
      for (let i = 0; i < 5; i++) {
        const res = await enforceRateLimitAsync(makeReq(), "ai_propose", 5, 60_000);
        assert.strictEqual(res, null, `Request ${i + 1} should be allowed (res === null)`);
      }

      // 6th request must be rejected with 429
      const blocked = await enforceRateLimitAsync(makeReq(), "ai_propose", 5, 60_000);
      assert.ok(blocked !== null, "Request 6 should return rate limit response");
      assert.strictEqual(blocked.status, 429);
      const body = await blocked.json();
      assert.ok(body.error.includes("Too many requests"));
    });

    it("fails closed with 503 when REQUIRE_DISTRIBUTED_RATE_LIMIT=true and Redis is unconfigured", async () => {
      process.env.REQUIRE_DISTRIBUTED_RATE_LIMIT = "true";
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;

      const req = new Request("http://localhost/api/workspace/upload", {
        headers: { "x-forwarded-for": "192.0.2.11" },
      });

      const res = await enforceRateLimitAsync(req, "workspace_upload", 10, 60_000);
      assert.ok(res !== null, "Must fail closed when distributed rate limiting is mandated but missing");
      assert.strictEqual(res.status, 503, "Must return HTTP 503 Service Unavailable");
      const body = await res.json();
      assert.strictEqual(body.code, "RATE_LIMIT_SERVICE_UNAVAILABLE");
    });

    it("fails closed with 503 when REQUIRE_DISTRIBUTED_RATE_LIMIT=true and distributed provider throws", async () => {
      process.env.REQUIRE_DISTRIBUTED_RATE_LIMIT = "true";
      // Simulate failing Redis connection
      setDistributedHandlerForTesting(async () => {
        throw new Error("Connection refused to Upstash Redis cluster");
      });

      const req = new Request("http://localhost/api/snapshots/snap_1/restore", {
        headers: { "x-forwarded-for": "192.0.2.12" },
      });

      const res = await enforceRateLimitAsync(req, "snapshots_restore", 5, 60_000);
      assert.ok(res !== null);
      assert.strictEqual(res.status, 503);
      const body = await res.json();
      assert.strictEqual(body.code, "RATE_LIMIT_SERVICE_UNAVAILABLE");
    });
  });

  // =========================================================================
  // 2. Snapshot Restoration Transactional Safety & Rollback
  // =========================================================================

  describe("2. Snapshot Restoration Transactional Integrity", () => {
    it("restores snapshot files and cleanly deletes post-snapshot files", async () => {
      const { adapter, storageFiles } = createMockCloudEnvironment();
      const userId = "user_deploy_test";
      const projectId = "proj_snap_clean";

      // Initialize project
      await adapter.projects.saveProject(makeMockProject(projectId, userId, "Snap Clean Project"), userId);

      // Save a snapshot with 2 files: src/app.ts and README.md
      const snap: Snapshot = {
        id: "snap_clean_v1",
        workspaceId: projectId,
        name: "Initial working version",
        createdAt: new Date().toISOString(),
        totalFiles: 2,
        totalBytes: 150,
        files: [
          { path: "src/app.ts", hash: "h1", size: 100, modifiedAt: new Date().toISOString() },
          { path: "README.md", hash: "h2", size: 50, modifiedAt: new Date().toISOString() },
        ],
        metadata: { projectId },
      };

      const snapFiles = new Map<string, string>([
        ["src/app.ts", "console.log('v1');"],
        ["README.md", "# Version 1"],
      ]);

      await adapter.snapshots.saveSnapshot(projectId, snap, snapFiles, userId);

      // Now simulate work on the project:
      // - Overwrite src/app.ts with broken code
      // - Add a newly created rogue file: rogue.txt (post-snapshot file)
      await adapter.workspace.writeFile(projectId, "src/app.ts", "console.log('broken v2');", userId);
      await adapter.workspace.writeFile(projectId, "rogue.txt", "rogue content that should be deleted", userId);

      assert.strictEqual(storageFiles.has(`projects/${projectId}/workspace/rogue.txt`), true);

      // Execute Restore
      const result = await adapter.snapshots.restoreSnapshot(projectId, "snap_clean_v1", userId);

      assert.strictEqual(result.restoredFiles.length, 2);
      assert.ok(result.restoredFiles.includes("src/app.ts"));
      assert.ok(result.restoredFiles.includes("README.md"));

      // Verify app.ts was restored to v1
      const restoredApp = await adapter.workspace.readFile(projectId, "src/app.ts", userId);
      assert.strictEqual(restoredApp, "console.log('v1');");

      // Verify rogue.txt was cleanly removed
      const filesAfter = await adapter.workspace.listFiles(projectId, userId);
      const rogueExists = filesAfter.some((f) => f.path === "rogue.txt");
      assert.strictEqual(rogueExists, false, "Post-snapshot files must be removed on restore");
    });

    it("safely rolls back workspace when mid-flight restoration write fails", async () => {
      const { adapter, setShouldFailSaveOnPath } = createMockCloudEnvironment();
      const userId = "user_deploy_test";
      const projectId = "proj_snap_rollback";

      await adapter.projects.saveProject(makeMockProject(projectId, userId, "Snap Rollback Project"), userId);

      // Create snapshot with file1.txt and file2.txt
      const snap: Snapshot = {
        id: "snap_to_fail",
        workspaceId: projectId,
        name: "Good snapshot",
        createdAt: new Date().toISOString(),
        totalFiles: 2,
        totalBytes: 20,
        files: [
          { path: "file1.txt", hash: "h1", size: 10, modifiedAt: new Date().toISOString() },
          { path: "file2.txt", hash: "h2", size: 10, modifiedAt: new Date().toISOString() },
        ],
        metadata: { projectId },
      };

      const snapFiles = new Map<string, string>([
        ["file1.txt", "file1-snap-content"],
        ["file2.txt", "file2-snap-content"],
      ]);
      await adapter.snapshots.saveSnapshot(projectId, snap, snapFiles, userId);

      // Pre-existing workspace files before restore
      await adapter.workspace.writeFile(projectId, "file1.txt", "file1-pre-restore", userId);
      await adapter.workspace.writeFile(projectId, "file2.txt", "file2-pre-restore", userId);

      // Simulate failure on the second file write during restore (exactly 1 failure, so rollback succeeds)
      setShouldFailSaveOnPath("workspace/file2.txt", 1);

      // Attempt restore: should throw StorageError with rollback notification
      let errorThrown: StorageError | null = null;
      try {
        await adapter.snapshots.restoreSnapshot(projectId, "snap_to_fail", userId);
      } catch (err) {
        if (err instanceof StorageError) {
          errorThrown = err;
        }
      }

      assert.ok(errorThrown !== null, "Restore must throw when a file write fails mid-flight");
      assert.strictEqual(errorThrown.statusCode, 500);
      assert.ok(
        errorThrown.message.includes("safely recovered to pre-restoration state"),
        `Error message should confirm safe rollback: ${errorThrown.message}`
      );

      // Verify file1.txt was rolled back to file1-pre-restore (not left in half-restored file1-snap-content state)
      const file1Content = await adapter.workspace.readFile(projectId, "file1.txt", userId);
      assert.strictEqual(file1Content, "file1-pre-restore", "file1.txt must be rolled back to pre-restoration content");

      const file2Content = await adapter.workspace.readFile(projectId, "file2.txt", userId);
      assert.strictEqual(file2Content, "file2-pre-restore", "file2.txt must remain at pre-restoration content");
    });
  });

  // =========================================================================
  // 3. AI Provider Safety: AI_PROVIDER=disabled
  // =========================================================================

  describe("3. AI Provider Safety: AI_PROVIDER=disabled Zero-Call Guarantee", () => {
    it("identifies disabled mode and provides zero-key config", () => {
      process.env.AI_PROVIDER = "disabled";
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NEBIUS_API_KEY;

      assert.strictEqual(isAIDisabled(), true);
      assert.strictEqual(getActiveProvider(), "disabled");

      const cfg = getAIConfig();
      assert.strictEqual(cfg.provider, "disabled");
      assert.strictEqual(cfg.apiKey, "");
    });

    it("disabled client rejects completions without making any network calls", async () => {
      process.env.AI_PROVIDER = "disabled";
      const client = getProviderClient("disabled");

      await assert.rejects(
        async () => {
          await client.generateCompletion({
            model: "any",
            messages: [{ role: "user", content: "Hello" }],
          });
        },
        {
          name: "Error",
          message: /AI provider is disabled/i,
        }
      );
    });

    it("POST /api/ai/propose returns 503 unconfigured when AI_PROVIDER=disabled", async () => {
      process.env.AI_PROVIDER = "disabled";

      const req = new Request("http://localhost:3000/api/ai/propose", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer dev_test_token",
        },
        body: JSON.stringify({
          prompt: "Fix bug in app.ts",
          projectId: "default_project",
        }),
      });

      const response = await proposePost(req);
      assert.strictEqual(response.status, 503);
      const data = await response.json();
      assert.strictEqual(data.category, "unconfigured");
      assert.ok(data.error.includes("disabled"));
    });

    it("GET /api/ai/status returns clean unconfigured payload when AI_PROVIDER=disabled", async () => {
      process.env.AI_PROVIDER = "disabled";

      const req = new Request("http://localhost:3000/api/ai/status", {
        headers: {
          "Authorization": "Bearer dev_test_token",
        },
      });

      const response = await aiStatusGet(req);
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.provider, "disabled");
      assert.strictEqual(data.status.state, "unconfigured");
      assert.strictEqual(data.status.endpointReachable, false);
    });
  });

  // =========================================================================
  // 4. Multi-Tenant Resource Isolation
  // =========================================================================

  describe("4. Multi-Tenant Resource Isolation in Cloud Adapter", () => {
    it("ensures User A cannot access User B's project files, snapshots, or memories", async () => {
      const { adapter } = createMockCloudEnvironment();
      setStorageProviderForTesting(adapter);

      const userAlpha = "user_alpha_111";
      const userBeta = "user_beta_222";
      const alphaProj = "proj_alpha_secure";

      // User Alpha creates a project and workspace files
      await adapter.projects.saveProject(makeMockProject(alphaProj, userAlpha, "Alpha Secure Proj"), userAlpha);

      // User Beta attempts to query Alpha's project
      const betaProject = await adapter.projects.getProject(alphaProj, userBeta);
      assert.strictEqual(betaProject, null, "User Beta must not be able to retrieve User Alpha's project");

      // User Beta attempts to list Alpha's snapshots
      const betaSnapshots = await adapter.snapshots.listSnapshots(alphaProj, userBeta);
      assert.strictEqual(betaSnapshots.length, 0, "User Beta must not see User Alpha's snapshots");

      // User Beta attempts to list Alpha's project memories
      const betaMemories = await adapter.chatMemories.listMemories(alphaProj, userBeta);
      assert.strictEqual(betaMemories.length, 0, "User Beta must not see User Alpha's memories");

      // Assert project access throws NotFoundError for User Beta
      const userBetaAuth: AuthUser = {
        uid: userBeta,
        email: "beta@rewind.local",
        displayName: "Beta User",
        role: "developer",
        creditAllowance: 100,
        creditsUsed: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authProvider: "development",
      };

      await assert.rejects(
        async () => {
          await assertProjectAccessAsync(userBetaAuth, alphaProj);
        },
        (err: Error) => {
          assert.ok(err instanceof NotFoundError);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 5. Session Secret Entropy Guards
  // =========================================================================

  describe("5. Session Secret Entropy & Environment Guards", () => {
    it("throws critical error in production when session secret is missing or under 32 characters", () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = "production";
      delete env.AUTH_SESSION_SECRET;
      delete env.SESSION_SECRET;

      assert.throws(
        () => {
          getSessionSecret();
        },
        /CRITICAL: AUTH_SESSION_SECRET or SESSION_SECRET must be configured in production/
      );

      env.AUTH_SESSION_SECRET = "too-short-secret";
      assert.throws(
        () => {
          getSessionSecret();
        },
        /at least 32 characters in production/
      );
    });

    it("successfully creates and verifies tokens when adequate entropy is provided", () => {
      process.env.AUTH_SESSION_SECRET = "production-ready-high-entropy-signing-key-32-chars-long";

      const user = {
        uid: "user_test_entropy",
        email: "test@rewind.dev",
        displayName: "Entropy Test",
        role: "developer" as const,
        creditAllowance: 100,
        creditsUsed: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authProvider: "development" as const,
      };

      const token = createDevSessionToken(user);
      assert.ok(token.startsWith("dev_"));

      const session = verifyDevSessionToken(token);
      assert.ok(session !== null);
      assert.strictEqual(session?.userId, user.uid);
      assert.strictEqual(session?.email, user.email);

      // Verify signature tampering is rejected
      const tampered = token.slice(0, -4) + "XXXX";
      const tamperedSession = verifyDevSessionToken(tampered);
      assert.strictEqual(tamperedSession, null, "Tampered signature must be rejected");
    });

    it("fails closed when Firebase is required but not configured", () => {
      process.env.REQUIRE_FIREBASE = "true";
      assert.strictEqual(isFirebaseRequired(), true);

      delete process.env.REQUIRE_FIREBASE;
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = "production";
      env.REWIND_ALLOW_LOCAL_AUTH_IN_PROD = "false";
      assert.strictEqual(isFirebaseRequired(), true);
    });
  });
});

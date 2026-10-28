import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  registerUser,
  loginUser,
  createDevSessionToken,
  verifyDevSessionToken,
  getAuthenticatedUser,
  requireAuthenticatedUser,
  assertProjectAccess,
  AuthenticationError,
  ForbiddenError,
} from "../src/server/auth";
import { createProject, listProjects, getProject } from "../src/engine/projectManager";
import {
  createChatSession,
  listChatSessions,
  addChatMessage,
  listChatMessages,
  saveProjectMemory,
  listProjectMemories,
} from "../src/engine/chatMemoryStore";
import { createSnapshot, restoreSnapshot, listSnapshots } from "../src/engine/recoveryEngine";

// API Route Handlers
import { GET as authMeGet } from "../src/app/api/auth/me/route";
import { POST as authRegisterPost } from "../src/app/api/auth/register/route";
import { POST as authLoginPost } from "../src/app/api/auth/login/route";
import { POST as authLogoutPost } from "../src/app/api/auth/logout/route";
import { GET as projectsGet, POST as projectsPost } from "../src/app/api/projects/route";
import { GET as projectDetailGet } from "../src/app/api/projects/[id]/route";
import { GET as projectMemoriesGet, POST as projectMemoriesPost } from "../src/app/api/projects/[id]/memories/route";
import { GET as chatSessionsGet, POST as chatSessionsPost } from "../src/app/api/chat/sessions/route";
import { GET as chatSessionDetailGet } from "../src/app/api/chat/sessions/[sessionId]/route";
import { POST as chatMessagesPost } from "../src/app/api/chat/messages/route";
import { GET as snapshotsGet, POST as snapshotsPost } from "../src/app/api/snapshots/route";
import { POST as snapshotRestorePost } from "../src/app/api/snapshots/[id]/restore/route";
import { POST as uploadPost } from "../src/app/api/workspace/upload/route";
import { POST as applyPost } from "../src/app/api/ai/apply/route";

describe("Rewind Firebase & Multi-Tenant Authentication, Authorization & Isolation Suite", () => {
  let tempBaseDir: string;
  let testStore: string;
  let originalStoreDir: string | undefined;
  let originalStrictAuth: string | undefined;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-auth-test-"));
    testStore = path.join(tempBaseDir, "store");
    fs.mkdirSync(testStore, { recursive: true });

    originalStoreDir = process.env.REWIND_STORE_DIR;
    originalStrictAuth = process.env.REWIND_STRICT_AUTH;
    originalEnv = { ...process.env };

    process.env.REWIND_STORE_DIR = testStore;
    // Enable strict auth mode for authentication & isolation assertions
    process.env.REWIND_STRICT_AUTH = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalStoreDir !== undefined) {
      process.env.REWIND_STORE_DIR = originalStoreDir;
    } else {
      delete process.env.REWIND_STORE_DIR;
    }
    if (originalStrictAuth !== undefined) {
      process.env.REWIND_STRICT_AUTH = originalStrictAuth;
    } else {
      delete process.env.REWIND_STRICT_AUTH;
    }

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // -------------------------------------------------------------------------
  // 1. Registration, Password Policies & Privilege Escalation Defenses
  // -------------------------------------------------------------------------
  it("1.1. registers developer account and hashes password with salt using PBKDF2", async () => {
    const reg = await registerUser(
      {
        email: "alice@example.com",
        password: "StrongPassword123!",
        displayName: "Alice Developer",
      },
      testStore
    );

    assert.ok(reg.user.uid.startsWith("usr_"));
    assert.strictEqual(reg.user.email, "alice@example.com");
    assert.strictEqual(reg.user.displayName, "Alice Developer");
    assert.strictEqual(reg.user.role, "developer");
    assert.strictEqual(reg.user.creditAllowance, 100);
    assert.strictEqual(reg.user.creditsUsed, 0);
    assert.ok(reg.token.startsWith("dev_"));

    // Verify stored file does NOT store plaintext password
    const usersFile = path.join(testStore, "auth", "users.json");
    assert.ok(fs.existsSync(usersFile));
    const storedUsers = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
    const storedAlice = storedUsers[reg.user.uid];
    assert.ok(storedAlice);
    assert.strictEqual(storedAlice.password, undefined);
    assert.ok(storedAlice.passwordHash && storedAlice.passwordHash.length === 128);
    assert.ok(storedAlice.salt && storedAlice.salt.length === 32);
  });

  it("1.2. strictly enforces password length and valid email format", async () => {
    // Short password (< 8 chars)
    await assert.rejects(
      async () => {
        await registerUser(
          { email: "short@example.com", password: "123" },
          testStore
        );
      },
      /Password must be at least 8 characters/
    );

    // Invalid email
    await assert.rejects(
      async () => {
        await registerUser(
          { email: "not-an-email", password: "ValidPassword123" },
          testStore
        );
      },
      /valid email address is required/
    );

    // Duplicate email
    await registerUser(
      { email: "dup@example.com", password: "Password123" },
      testStore
    );
    await assert.rejects(
      async () => {
        await registerUser(
          { email: "dup@example.com", password: "Password456" },
          testStore
        );
      },
      /already exists/
    );
  });

  it("1.3. strictly prevents privilege escalation on registration", async () => {
    // Even if client attempts to pass role="admin" and creditAllowance=999999
    const regPayload: Record<string, unknown> = {
      email: "hacker@example.com",
      password: "StrongPassword123!",
      role: "admin",
      creditAllowance: 999999,
    };

    const reg = await registerUser(regPayload as unknown as { email: string; password: string }, testStore);
    assert.strictEqual(reg.user.role, "developer"); // Must remain developer
    assert.strictEqual(reg.user.creditAllowance, 100); // Must remain 100
  });

  // -------------------------------------------------------------------------
  // 2. Login, Verification & Session Token Cryptography
  // -------------------------------------------------------------------------
  it("2.1. successfully logs in with matching credentials and rejects invalid password", async () => {
    await registerUser(
      { email: "bob@example.com", password: "CorrectPassword123!" },
      testStore
    );

    // Valid login
    const loginRes = await loginUser(
      { email: "bob@example.com", password: "CorrectPassword123!" },
      testStore
    );
    assert.strictEqual(loginRes.user.email, "bob@example.com");
    assert.ok(loginRes.token.startsWith("dev_"));

    // Invalid password
    await assert.rejects(
      async () => {
        await loginUser(
          { email: "bob@example.com", password: "WrongPassword" },
          testStore
        );
      },
      /Invalid email or password/
    );

    // Non-existent email
    await assert.rejects(
      async () => {
        await loginUser(
          { email: "unknown@example.com", password: "AnyPassword" },
          testStore
        );
      },
      /Invalid email or password/
    );
  });

  it("2.2. detects HMAC signature tampering and expired session tokens", () => {
    const fakeUser = {
      uid: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      role: "developer" as const,
      creditAllowance: 100,
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      authProvider: "development" as const,
    };

    const validToken = createDevSessionToken(fakeUser);
    const verified = verifyDevSessionToken(validToken);
    assert.ok(verified);
    assert.strictEqual(verified.userId, "usr_alice");

    // Tampered signature
    const parts = validToken.split(".");
    const tamperedToken = `${parts[0]}.tamperedSignature`;
    assert.strictEqual(verifyDevSessionToken(tamperedToken), null);

    // Tampered payload
    const tamperedPayloadToken = `dev_eyJ1c2VySWQiOiJ1c3JfaGFja2VyIn0.${parts[1]}`;
    assert.strictEqual(verifyDevSessionToken(tamperedPayloadToken), null);

    // Expired token
    const expiredPayload = Buffer.from(
      JSON.stringify({
        userId: "usr_alice",
        email: "alice@example.com",
        role: "developer",
        expiresAt: Date.now() - 1000,
      })
    ).toString("base64url");
    const cryptoMod = require("node:crypto");
    const secret = process.env.AUTH_SESSION_SECRET || "rewind-session-signing-secret-safe-dev-key-2026";
    const sig = cryptoMod.createHmac("sha256", secret).update(expiredPayload).digest("base64url");
    const expiredToken = `dev_${expiredPayload}.${sig}`;

    assert.strictEqual(verifyDevSessionToken(expiredToken), null);
  });

  // -------------------------------------------------------------------------
  // 3. Strict 401 Unauthorized for Unauthenticated API Requests
  // -------------------------------------------------------------------------
  it("3.1. returns 401 Unauthorized on protected routes when no credentials are provided", async () => {
    // GET /api/auth/me
    const meReq = new Request("http://localhost/api/auth/me");
    const meRes = await authMeGet(meReq);
    assert.strictEqual(meRes.status, 401);

    // GET /api/projects
    const projReq = new Request("http://localhost/api/projects");
    const projRes = await projectsGet(projReq);
    assert.strictEqual(projRes.status, 401);

    // POST /api/projects
    const createProjReq = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unauth Project" }),
    });
    const createProjRes = await projectsPost(createProjReq);
    assert.strictEqual(createProjRes.status, 401);

    // GET /api/chat/sessions
    const chatReq = new Request("http://localhost/api/chat/sessions?projectId=demo-workspace");
    const chatRes = await chatSessionsGet(chatReq);
    assert.strictEqual(chatRes.status, 401);

    // POST /api/chat/messages
    const msgReq = new Request("http://localhost/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess_123", content: "Hello" }),
    });
    const msgRes = await chatMessagesPost(msgReq);
    assert.strictEqual(msgRes.status, 401);

    // POST /api/snapshots
    const snapReq = new Request("http://localhost/api/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unauth Snapshot" }),
    });
    const snapRes = await snapshotsPost(snapReq);
    assert.strictEqual(snapRes.status, 401);

    // POST /api/ai/apply
    const applyReq = new Request("http://localhost/api/ai/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, proposal: { modifications: [] } }),
    });
    const applyRes = await applyPost(applyReq);
    assert.strictEqual(applyRes.status, 401);
  });

  it("3.2. successfully authenticates via session cookie or Authorization Bearer header", async () => {
    const userA = await registerUser(
      { email: "user_a@example.com", password: "Password123!" },
      testStore
    );

    // Cookie authentication
    const cookieReq = new Request("http://localhost/api/auth/me", {
      headers: { Cookie: `rewind_session=${userA.token}` },
    });
    const cookieRes = await authMeGet(cookieReq);
    assert.strictEqual(cookieRes.status, 200);
    const cookieData = await cookieRes.json();
    assert.strictEqual(cookieData.user.email, "user_a@example.com");

    // Header authentication
    const headerReq = new Request("http://localhost/api/auth/me", {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    const headerRes = await authMeGet(headerReq);
    assert.strictEqual(headerRes.status, 200);
    const headerData = await headerRes.json();
    assert.strictEqual(headerData.user.email, "user_a@example.com");
  });

  // -------------------------------------------------------------------------
  // 4. Strict 403 Forbidden for Unauthorized Cross-User Operations
  // -------------------------------------------------------------------------
  it("4.1. blocks cross-user project listing, details, and modifications with 403 Forbidden", async () => {
    const userA = await registerUser(
      { email: "alice_iso@example.com", password: "Password123!" },
      testStore
    );
    const userB = await registerUser(
      { email: "bob_iso@example.com", password: "Password123!" },
      testStore
    );

    // User A creates project ProjA
    const projA = createProject({ name: "Alice Secret App", template: "empty" }, testStore, userA.user.uid);

    // 1. When User B lists projects, ProjA is excluded (only demo-workspace and User B projects returned)
    const listReqUserB = new Request("http://localhost/api/projects", {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const listResUserB = await projectsGet(listReqUserB);
    assert.strictEqual(listResUserB.status, 200);
    const listDataUserB = await listResUserB.json();
    const hasProjA = listDataUserB.projects.some((p: { id: string }) => p.id === projA.id);
    assert.strictEqual(hasProjA, false);

    // 2. When User A lists projects, ProjA IS included
    const listReqUserA = new Request("http://localhost/api/projects", {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    const listResUserA = await projectsGet(listReqUserA);
    assert.strictEqual(listResUserA.status, 200);
    const listDataUserA = await listResUserA.json();
    const aliceHasProjA = listDataUserA.projects.some((p: { id: string }) => p.id === projA.id);
    assert.strictEqual(aliceHasProjA, true);

    // 3. User B attempts to access ProjA detail directly -> 403 Forbidden
    const detailReqUserB = new Request(`http://localhost/api/projects/${projA.id}`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const detailResUserB = await projectDetailGet(detailReqUserB, {
      params: Promise.resolve({ id: projA.id }),
    });
    assert.strictEqual(detailResUserB.status, 403);
    const detailErr = await detailResUserB.json();
    assert.ok(detailErr.error.includes("permission"));
  });

  it("4.2. blocks cross-user chat sessions, messages, and memories with 403 Forbidden", async () => {
    const userA = await registerUser(
      { email: "alice_chat@example.com", password: "Password123!" },
      testStore
    );
    const userB = await registerUser(
      { email: "bob_chat@example.com", password: "Password123!" },
      testStore
    );

    const projA = createProject({ name: "Alice Chat App", template: "empty" }, testStore, userA.user.uid);

    // User B attempts to list chat sessions of Alice's project -> 403 Forbidden
    const listSessionsUserB = new Request(`http://localhost/api/chat/sessions?projectId=${projA.id}`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const listSessionsResUserB = await chatSessionsGet(listSessionsUserB);
    assert.strictEqual(listSessionsResUserB.status, 403);

    // User B attempts to create a chat session in Alice's project -> 403 Forbidden
    const createSessionUserB = new Request("http://localhost/api/chat/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ projectId: projA.id, title: "Intruder Session" }),
    });
    const createSessionResUserB = await chatSessionsPost(createSessionUserB);
    assert.strictEqual(createSessionResUserB.status, 403);

    // User B attempts to access or add memories in Alice's project -> 403 Forbidden
    const memReqUserB = new Request(`http://localhost/api/projects/${projA.id}/memories`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const memResUserB = await projectMemoriesGet(memReqUserB, {
      params: Promise.resolve({ id: projA.id }),
    });
    assert.strictEqual(memResUserB.status, 403);

    const addMemReqUserB = new Request(`http://localhost/api/projects/${projA.id}/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({
        title: "Malicious intent",
        distilledIntent: "Inject backdoor",
        category: "project_intent",
      }),
    });
    const addMemResUserB = await projectMemoriesPost(addMemReqUserB, {
      params: Promise.resolve({ id: projA.id }),
    });
    assert.strictEqual(addMemResUserB.status, 403);
  });

  it("4.3. blocks cross-user snapshot creation and restoration with 403 Forbidden", async () => {
    const userA = await registerUser(
      { email: "alice_snap@example.com", password: "Password123!" },
      testStore
    );
    const userB = await registerUser(
      { email: "bob_snap@example.com", password: "Password123!" },
      testStore
    );

    const projA = createProject({ name: "Alice Snap App", template: "empty" }, testStore, userA.user.uid);

    // User B attempts to create snapshot in Alice's project -> 403 Forbidden
    const snapPostReq = new Request("http://localhost/api/snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ projectId: projA.id, name: "Unauthorized Snapshot" }),
    });
    const snapPostRes = await snapshotsPost(snapPostReq);
    assert.strictEqual(snapPostRes.status, 403);

    // User A creates legitimate snapshot in ProjA
    const snapA = createSnapshot(projA.workspacePath, testStore, "Legit Snap", "Snap by Alice", {
      projectId: projA.id,
    });

    // User B attempts to restore Alice's snapshot -> 403 Forbidden
    const restoreReqUserB = new Request(`http://localhost/api/snapshots/${snapA.id}/restore?projectId=${projA.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ projectId: projA.id, force: true }),
    });
    const restoreResUserB = await snapshotRestorePost(restoreReqUserB, {
      params: Promise.resolve({ id: snapA.id }),
    });
    assert.strictEqual(restoreResUserB.status, 403);
  });

  // -------------------------------------------------------------------------
  // 5. Shared Template (demo-workspace) Accessibility
  // -------------------------------------------------------------------------
  it("5.1. allows authenticated developers to access and view shared demo-workspace", async () => {
    const userA = await registerUser(
      { email: "dev_shared@example.com", password: "Password123!" },
      testStore
    );

    // Authenticated GET on demo-workspace succeeds
    const demoReq = new Request("http://localhost/api/projects/demo-workspace", {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    const demoRes = await projectDetailGet(demoReq, {
      params: Promise.resolve({ id: "demo-workspace" }),
    });
    assert.strictEqual(demoRes.status, 200);
    const demoData = await demoRes.json();
    assert.strictEqual(demoData.project.id, "demo-workspace");
  });
});

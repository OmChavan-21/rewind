import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  registerUser,
  loginUser,
  createDevSessionToken,
  verifyDevSessionToken,
  getAuthenticatedUser,
  sendPasswordResetEmail,
  confirmPasswordReset,
  getMockResetCodeForEmail,
  clearMockResetCodes,
  isSessionRevocationCheckEnabled,
} from "../src/server/auth";
import { createProject } from "../src/engine/projectManager";
import { createSnapshot } from "../src/engine/recoveryEngine";
import { clearRateLimitStore, extractClientIp } from "../src/security/rateLimiter";

// API Route Handlers
import { GET as authMeGet } from "../src/app/api/auth/me/route";
import { POST as authLoginPost } from "../src/app/api/auth/login/route";
import { GET as projectsGet, POST as projectsPost } from "../src/app/api/projects/route";
import { GET as projectDetailGet } from "../src/app/api/projects/[id]/route";
import { GET as projectMemoriesGet, POST as projectMemoriesPost } from "../src/app/api/projects/[id]/memories/route";
import { GET as chatSessionsGet, POST as chatSessionsPost } from "../src/app/api/chat/sessions/route";
import { POST as chatMessagesPost } from "../src/app/api/chat/messages/route";
import { POST as snapshotsPost } from "../src/app/api/snapshots/route";
import { POST as snapshotRestorePost } from "../src/app/api/snapshots/[id]/restore/route";
import { POST as applyPost } from "../src/app/api/ai/apply/route";
import { POST as demoBreakPost } from "../src/app/api/actions/demo-break/route";
import { POST as validatePost } from "../src/app/api/actions/validate/route";
import { GET as aiStatusGet } from "../src/app/api/ai/status/route";
import { GET as limitsGet } from "../src/app/api/system/limits/route";
import { GET as auditGet } from "../src/app/api/audit/route";
import { POST as authGooglePost } from "../src/app/api/auth/google/route";
import { POST as authVerifyEmailPost } from "../src/app/api/auth/verify-email/route";
import { POST as authForgotPasswordPost } from "../src/app/api/auth/forgot-password/route";
import { POST as authResetPasswordPost } from "../src/app/api/auth/reset-password/route";
import { GET as workspaceFilesGet } from "../src/app/api/workspace/files/route";
import { GET as workspaceFileGet } from "../src/app/api/workspace/file/route";

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
      clearMockResetCodes();
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
    const secret = process.env.AUTH_SESSION_SECRET || "rewind-session-signing-secret-safe-dev-key-2026";
    const sig = crypto.createHmac("sha256", secret).update(expiredPayload).digest("base64url");
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

  // -------------------------------------------------------------------------
  // 6. Fail-Closed Behavior on Firebase Configuration Errors & Production Protections
  // -------------------------------------------------------------------------
  it("6.1. rejects registration and login when Firebase is required but unconfigured", async () => {
    process.env.AUTH_REQUIRE_FIREBASE = "true";
    delete process.env.FIREBASE_PROJECT_ID;

    await assert.rejects(
      async () => {
        await registerUser(
          { email: "failclosed@example.com", password: "Password123!" },
          testStore
        );
      },
      /Firebase Authentication is required/
    );

    await assert.rejects(
      async () => {
        await loginUser(
          { email: "failclosed@example.com", password: "Password123!" },
          testStore
        );
      },
      /Firebase Authentication is required/
    );
  });

  it("6.2. fails closed when Firebase is configured but has connection errors", async () => {
    process.env.FIREBASE_PROJECT_ID = "bad-project-id";
    process.env.FIREBASE_CLIENT_EMAIL = "bad@serviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "not-a-valid-pem-key";

    await assert.rejects(
      async () => {
        await registerUser(
          { email: "badconn@example.com", password: "Password123!" },
          testStore
        );
      },
      /Firebase/
    );
  });

  it("6.3. prohibits local filesystem authentication in production mode without explicit opt-in", async () => {
    const oldNodeEnv = process.env.NODE_ENV;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.AUTH_REQUIRE_FIREBASE;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.REWIND_ALLOW_LOCAL_AUTH_IN_PROD;

    try {
      await assert.rejects(
        async () => {
          await registerUser(
            { email: "prod_local@example.com", password: "Password123!" },
            testStore
          );
        },
        /(Local filesystem authentication is prohibited in production mode|Firebase Authentication is required in this environment)/
      );
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = oldNodeEnv;
    }
  });

  // -------------------------------------------------------------------------
  // 7. CSRF Defense on Cookie-Authenticated Mutating Requests
  // -------------------------------------------------------------------------
  it("7.1. blocks cross-origin mutating requests when authenticated via session cookie", async () => {
    const user = await registerUser(
      { email: "csrf_victim@example.com", password: "Password123!" },
      testStore
    );

    // Malicious site attempts POST with victim's session cookie
    const csrfReq = new Request("http://localhost:3000/api/snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "https://evil-attacker.com",
        Cookie: `rewind_session=${user.token}`,
      },
      body: JSON.stringify({ name: "Attacker Snapshot" }),
    });

    const res = await snapshotsPost(csrfReq);
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.ok(data.error.includes("CSRF"));
  });

  it("7.2. permits same-origin mutating requests with session cookie", async () => {
    const user = await registerUser(
      { email: "sameorigin@example.com", password: "Password123!" },
      testStore
    );

    const validReq = new Request("http://localhost:3000/api/snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        Cookie: `rewind_session=${user.token}`,
      },
      body: JSON.stringify({ name: "Valid Snapshot" }),
    });

    const res = await snapshotsPost(validReq);
    assert.strictEqual(res.status, 201);
  });

  // -------------------------------------------------------------------------
  // 8. Authorization Coverage on Demo Actions, AI Status, and System Limits
  // -------------------------------------------------------------------------
  it("8.1. enforces authentication on demo-break and validate actions", async () => {
    // Unauthenticated POST /api/actions/demo-break -> 401
    const unauthBreak = new Request("http://localhost/api/actions/demo-break", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetFile: "agent-workflow.json" }),
    });
    const resBreak = await demoBreakPost(unauthBreak);
    assert.strictEqual(resBreak.status, 401);

    // Unauthenticated POST /api/actions/validate -> 401
    const unauthValidate = new Request("http://localhost/api/actions/validate", {
      method: "POST",
    });
    const resValidate = await validatePost(unauthValidate);
    assert.strictEqual(resValidate.status, 401);

    // Authenticated calls succeed
    const user = await registerUser(
      { email: "action_dev@example.com", password: "Password123!" },
      testStore
    );
    const authValidate = new Request("http://localhost/api/actions/validate", {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}` },
    });
    const authValRes = await validatePost(authValidate);
    assert.strictEqual(authValRes.status, 200);
  });

  it("8.2. blocks unauthorized cross-user inspection of project AI status and system limits", async () => {
    const userA = await registerUser(
      { email: "alice_metrics@example.com", password: "Password123!" },
      testStore
    );
    const userB = await registerUser(
      { email: "bob_metrics@example.com", password: "Password123!" },
      testStore
    );

    const projA = createProject({ name: "Alice Metrics App", template: "empty" }, testStore, userA.user.uid);

    // User B tries to inspect Alice's AI credit status -> 403 Forbidden
    const aiStatusReq = new Request(`http://localhost/api/ai/status?projectId=${projA.id}`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const aiStatusRes = await aiStatusGet(aiStatusReq);
    assert.strictEqual(aiStatusRes.status, 403);

    // User B tries to inspect Alice's memory and storage limits -> 403 Forbidden
    const limitsReq = new Request(`http://localhost/api/system/limits?projectId=${projA.id}`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const limitsRes = await limitsGet(limitsReq);
    assert.strictEqual(limitsRes.status, 403);
  });

  // -------------------------------------------------------------------------
  // 9. Production Security Hardening: Token Enforcement, Rate Limiting & Concurrency
  // -------------------------------------------------------------------------
  it("9.1. rejects dev tokens in production mode when Firebase is required", async () => {
    const user = await registerUser(
      { email: "dev_prod_check@example.com", password: "Password123!" },
      testStore
    );

    const oldNodeEnv = process.env.NODE_ENV;
    const oldRequireFb = process.env.AUTH_REQUIRE_FIREBASE;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.AUTH_REQUIRE_FIREBASE = "true";

      const req = new Request("http://localhost/api/auth/me", {
        headers: { Authorization: `Bearer ${user.token}` },
      });

      const authUser = await getAuthenticatedUser(req, testStore);
      assert.strictEqual(authUser, null, "dev_ token must be rejected in production Firebase mode");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = oldNodeEnv;
      process.env.AUTH_REQUIRE_FIREBASE = oldRequireFb;
    }
  });

  it("9.2. enforces rate limiting on login endpoint against brute-force attempts", async () => {
    clearRateLimitStore();

    // 10 attempts allowed
    for (let i = 0; i < 10; i++) {
      const req = new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.42" },
        body: JSON.stringify({ email: "victim@example.com", password: "wrong" }),
      });
      const res = await authLoginPost(req);
      assert.strictEqual(res.status, 401);
    }

    // 11th attempt must be blocked by rate limiter with 429 Too Many Requests
    const reqBlocked = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.42" },
      body: JSON.stringify({ email: "victim@example.com", password: "wrong" }),
    });
    const resBlocked = await authLoginPost(reqBlocked);
    assert.strictEqual(resBlocked.status, 429);
    assert.ok(resBlocked.headers.get("Retry-After"));
    const data = await resBlocked.json();
    assert.ok(data.error.includes("Too many requests"));
  });

  it("9.3. safely handles concurrent project creation without registry corruption", async () => {
    const user = await registerUser(
      { email: "concurrent_dev@example.com", password: "Password123!" },
      testStore
    );

    const promises = Array.from({ length: 8 }, (_, i) => {
      const req = new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ name: `Concurrent App ${i}`, template: "empty" }),
      });
      return projectsPost(req);
    });

    const responses = await Promise.all(promises);
    for (const res of responses) {
      assert.strictEqual(res.status, 200);
    }

    // List projects and verify all 8 exist (+ 1 demo-workspace = 9)
    const listReq = new Request("http://localhost/api/projects", {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    const listRes = await projectsGet(listReq);
    assert.strictEqual(listRes.status, 200);
    const data = await listRes.json();
    assert.strictEqual(data.projects.length, 9);
    for (let i = 0; i < 8; i++) {
      assert.ok(data.projects.some((p: { name: string }) => p.name === `Concurrent App ${i}`));
    }
  });

  // -------------------------------------------------------------------------
  // 10. Comprehensive Two-User Isolation & Google Social Login Suite
  // -------------------------------------------------------------------------
  it("10.1. strictly isolates projects, files, snapshots, chat, memories, audit, and credits between two users", async () => {
    // 1. Register User Alice and User Bob
    const alice = await registerUser(
      { email: "alice_iso@example.com", password: "Password123!", displayName: "Alice Iso" },
      testStore
    );
    const bob = await registerUser(
      { email: "bob_iso@example.com", password: "Password123!", displayName: "Bob Iso" },
      testStore
    );

    // 2. Alice creates Alice Project
    const createProjReq = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ name: "Alice Confidential App", template: "empty" }),
    });
    const createProjRes = await projectsPost(createProjReq);
    assert.strictEqual(createProjRes.status, 200);
    const { project: aliceProj } = await createProjRes.json();

    // Alice creates a chat session
    const chatSessReq = new Request("http://localhost/api/chat/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ projectId: aliceProj.id, title: "Secret Architecture" }),
    });
    const chatSessRes = await chatSessionsPost(chatSessReq);
    assert.strictEqual(chatSessRes.status, 201);
    const { session: aliceSession } = await chatSessRes.json();

    // Alice creates a memory
    const memReq = new Request(`http://localhost/api/projects/${aliceProj.id}/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        title: "Confidential Decision",
        distilledIntent: "Never expose secret encryption keys",
        category: "architectural_decision",
      }),
    });
    const memRes = await projectMemoriesPost(memReq, { params: Promise.resolve({ id: aliceProj.id }) });
    assert.strictEqual(memRes.status, 201);

    // Alice creates a snapshot
    const snapReq = new Request("http://localhost/api/snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ projectId: aliceProj.id, name: "Alice v1.0" }),
    });
    const snapRes = await snapshotsPost(snapReq);
    assert.strictEqual(snapRes.status, 201);
    const { snapshot: aliceSnapshot } = await snapRes.json();

    // 3. Bob attempts to access Alice's project resources by ID or parameter

    // Bob tries to get Alice's project details -> 403
    const bobGetProj = new Request(`http://localhost/api/projects/${aliceProj.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobGetProjRes = await projectDetailGet(bobGetProj, { params: Promise.resolve({ id: aliceProj.id }) });
    assert.strictEqual(bobGetProjRes.status, 403);

    // Bob tries to list Alice's workspace files -> 403
    const bobListFiles = new Request(`http://localhost/api/workspace/files?projectId=${aliceProj.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobListFilesRes = await workspaceFilesGet(bobListFiles);
    assert.strictEqual(bobListFilesRes.status, 403);

    // Bob tries to read a file from Alice's project -> 403
    const bobReadFile = new Request(`http://localhost/api/workspace/file?path=package.json&projectId=${aliceProj.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobReadFileRes = await workspaceFileGet(bobReadFile);
    assert.strictEqual(bobReadFileRes.status, 403);

    // Bob tries to list Alice's chat sessions -> 403
    const bobListChat = new Request(`http://localhost/api/chat/sessions?projectId=${aliceProj.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobListChatRes = await chatSessionsGet(bobListChat);
    assert.strictEqual(bobListChatRes.status, 403);

    // Bob tries to post a message into Alice's session -> 403
    const bobPostMsg = new Request("http://localhost/api/chat/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({
        projectId: aliceProj.id,
        sessionId: aliceSession.id,
        content: "Malicious injection",
      }),
    });
    const bobPostMsgRes = await chatMessagesPost(bobPostMsg);
    assert.strictEqual(bobPostMsgRes.status, 403);

    // Bob tries to list Alice's memories -> 403
    const bobListMem = new Request(`http://localhost/api/projects/${aliceProj.id}/memories`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobListMemRes = await projectMemoriesGet(bobListMem, { params: Promise.resolve({ id: aliceProj.id }) });
    assert.strictEqual(bobListMemRes.status, 403);

    // Bob tries to restore Alice's snapshot -> 403
    const bobRestore = new Request(`http://localhost/api/snapshots/${aliceSnapshot.id}/restore`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({ projectId: aliceProj.id }),
    });
    const bobRestoreRes = await snapshotRestorePost(bobRestore, { params: Promise.resolve({ id: aliceSnapshot.id }) });
    assert.strictEqual(bobRestoreRes.status, 403);

    // Bob tries to inspect Alice's audit history directly with ?projectId -> 403
    const bobAuditProj = new Request(`http://localhost/api/audit?projectId=${aliceProj.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobAuditProjRes = await auditGet(bobAuditProj);
    assert.strictEqual(bobAuditProjRes.status, 403);

    // Bob calls global GET /api/audit -> must NOT leak any of Alice's project actions
    const bobGlobalAudit = new Request("http://localhost/api/audit", {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    const bobGlobalAuditRes = await auditGet(bobGlobalAudit);
    assert.strictEqual(bobGlobalAuditRes.status, 200);
    const bobAuditData = await bobGlobalAuditRes.json();
    assert.ok(
      !bobAuditData.actions.some((a: { projectId?: string }) => a.projectId === aliceProj.id),
      "Bob's audit log must not leak Alice's project actions"
    );
  });

  it("10.2. supports Google sign-in endpoint and enforces validation & rate limiting", async () => {
    clearRateLimitStore();

    // Rejects empty ID token -> 400
    const emptyReq = new Request("http://localhost/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "" }),
    });
    const emptyRes = await authGooglePost(emptyReq);
    assert.strictEqual(emptyRes.status, 400);

    // Accepts valid token in dev mode
    const validReq = new Request("http://localhost/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "mock-google-id-token-valid-2026" }),
    });
    const validRes = await authGooglePost(validReq);
    assert.strictEqual(validRes.status, 200);
    const validData = await validRes.json();
    assert.strictEqual(validData.user.authProvider, "google");
    assert.strictEqual(validData.user.role, "developer");
    assert.ok(validRes.headers.get("Set-Cookie"));

    // Rate limiting blocks beyond 10 attempts
    for (let i = 0; i < 10; i++) {
      const floodReq = new Request("http://localhost/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.99" },
        body: JSON.stringify({ idToken: `flood-${i}` }),
      });
      await authGooglePost(floodReq);
    }
    const blockedReq = new Request("http://localhost/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.99" },
      body: JSON.stringify({ idToken: "flood-blocked" }),
    });
    const blockedRes = await authGooglePost(blockedReq);
    assert.strictEqual(blockedRes.status, 429);
  });

  // -------------------------------------------------------------------------
  // 11. Email Verification & Configurable Verification Gate
  // -------------------------------------------------------------------------
  it("11.1. exposes emailVerified flag during registration and login", async () => {
    const reg = await registerUser(
      {
        email: "verified_test@example.com",
        password: "StrongPassword123!",
        displayName: "Verified Tester",
      },
      testStore
    );

    assert.strictEqual(typeof reg.user.emailVerified, "boolean");

    const login = await loginUser(
      {
        email: "verified_test@example.com",
        password: "StrongPassword123!",
      },
      testStore
    );

    assert.strictEqual(typeof login.user.emailVerified, "boolean");
  });

  it("11.2. strictly enforces email verification before login when REQUIRE_EMAIL_VERIFICATION is enabled", async () => {
    const oldVal = process.env.REQUIRE_EMAIL_VERIFICATION;
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";

    try {
      const reg = await registerUser(
        {
          email: "unverified_gated@example.com",
          password: "StrongPassword123!",
          displayName: "Gated Tester",
        },
        testStore
      );
      assert.strictEqual(reg.user.emailVerified, false);

      // Attempting to login when unverified and REQUIRE_EMAIL_VERIFICATION=true throws
      await assert.rejects(
        async () => {
          await loginUser(
            {
              email: "unverified_gated@example.com",
              password: "StrongPassword123!",
            },
            testStore
          );
        },
        {
          message: /Please verify your email address before logging in/i,
        }
      );
    } finally {
      if (oldVal !== undefined) {
        process.env.REQUIRE_EMAIL_VERIFICATION = oldVal;
      } else {
        delete process.env.REQUIRE_EMAIL_VERIFICATION;
      }
    }
  });

  it("11.3. verifies /api/auth/verify-email endpoint handles requests and enforces rate limiting", async () => {
    // 1. Unauthenticated request without email returns 400
    const emptyReq = new Request("http://localhost/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const emptyRes = await authVerifyEmailPost(emptyReq);
    assert.strictEqual(emptyRes.status, 400);

    // 2. Request with email dispatches verification
    const validReq = new Request("http://localhost/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user_to_verify@example.com" }),
    });
    const validRes = await authVerifyEmailPost(validReq);
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.success, true);

    // 3. Rate limiting blocks beyond 5 attempts per IP per minute
    for (let i = 0; i < 5; i++) {
      const floodReq = new Request("http://localhost/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ email: `flood-${i}@example.com` }),
      });
      await authVerifyEmailPost(floodReq);
    }
    const blockedReq = new Request("http://localhost/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
      body: JSON.stringify({ email: "blocked@example.com" }),
    });
    const blockedRes = await authVerifyEmailPost(blockedReq);
    assert.strictEqual(blockedRes.status, 429);
  });

  // -------------------------------------------------------------------------
  // 12. Password Recovery (Forgot Password & Reset Confirmation Flow)
  // -------------------------------------------------------------------------
  it("12.1. verifies password recovery request returns generic success message without leaking account existence", async () => {
    // Register test user
    await registerUser(
      { email: "user_registered@example.com", password: "InitialPassword123!", displayName: "Registered User" },
      testStore
    );

    // 1. Recovery request for existing user returns generic success message
    const reqExisting = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user_registered@example.com" }),
    });
    const resExisting = await authForgotPasswordPost(reqExisting);
    assert.strictEqual(resExisting.status, 200);
    const bodyExisting = await resExisting.json();
    assert.strictEqual(bodyExisting.success, true);
    assert.match(bodyExisting.message, /If an account exists/i);

    // 2. Recovery request for non-existent user returns IDENTICAL generic message (anti-enumeration)
    const reqNonExistent = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user_nonexistent@example.com" }),
    });
    const resNonExistent = await authForgotPasswordPost(reqNonExistent);
    assert.strictEqual(resNonExistent.status, 200);
    const bodyNonExistent = await resNonExistent.json();
    assert.strictEqual(bodyNonExistent.success, true);
    assert.strictEqual(bodyNonExistent.message, bodyExisting.message);

    // 3. Malformed email without @ returns HTTP 400
    const reqMalformed = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    const resMalformed = await authForgotPasswordPost(reqMalformed);
    assert.strictEqual(resMalformed.status, 400);
  });

  it("12.2. enforces rate limiting on /api/auth/forgot-password against request flooding", async () => {
    // 3 attempts permitted per 15 minutes per IP
    const testIp = "198.51.100.122";
    for (let i = 0; i < 3; i++) {
      const req = new Request("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
        body: JSON.stringify({ email: `test-${i}@example.com` }),
      });
      const res = await authForgotPasswordPost(req);
      assert.strictEqual(res.status, 200);
    }

    // 4th attempt from same IP is blocked with HTTP 429
    const blockedReq = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
      body: JSON.stringify({ email: "test-blocked@example.com" }),
    });
    const blockedRes = await authForgotPasswordPost(blockedReq);
    assert.strictEqual(blockedRes.status, 429);
  });

  it("12.3. validates reset action code, enforces minimum password length, and applies new password", async () => {
    await registerUser(
      { email: "charlie@example.com", password: "OldPassword123!", displayName: "Charlie" },
      testStore
    );

    // Request reset
    await sendPasswordResetEmail("charlie@example.com");
    const code = getMockResetCodeForEmail("charlie@example.com");
    assert.ok(code, "Expected mock reset code to be generated");

    // 1. Password reset with short password (< 8 chars) fails
    const weakReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: code, newPassword: "short" }),
    });
    const weakRes = await authResetPasswordPost(weakReq);
    assert.strictEqual(weakRes.status, 400);
    const weakBody = await weakRes.json();
    assert.match(weakBody.error, /at least 8 characters/i);

    // 2. Successful reset with valid 8+ character password
    const validReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: code, newPassword: "BrandNewSecurePassword123!" }),
    });
    const validRes = await authResetPasswordPost(validReq);
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.success, true);

    // 3. Verify old password no longer works
    await assert.rejects(
      () => loginUser({ email: "charlie@example.com", password: "OldPassword123!" }, testStore),
      /Invalid email or password/i
    );

    // 4. Verify new password successfully logs in
    const loginSuccess = await loginUser(
      { email: "charlie@example.com", password: "BrandNewSecurePassword123!" },
      testStore
    );
    assert.strictEqual(loginSuccess.user.email, "charlie@example.com");
  });

  it("12.4. rejects invalid, expired, and already-used action codes (single-use enforcement)", async () => {
    await registerUser(
      { email: "david@example.com", password: "OldPassword123!", displayName: "David" },
      testStore
    );

    await sendPasswordResetEmail("david@example.com");
    const code = getMockResetCodeForEmail("david@example.com");
    assert.ok(code);

    // 1. Reset succeeds once
    const firstReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: code, newPassword: "NewSecurePassword1!" }),
    });
    const firstRes = await authResetPasswordPost(firstReq);
    assert.strictEqual(firstRes.status, 200);

    // 2. Replay attempt with same code fails (single-use)
    const replayReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: code, newPassword: "AnotherPassword123!" }),
    });
    const replayRes = await authResetPasswordPost(replayReq);
    assert.strictEqual(replayRes.status, 400);
    const replayBody = await replayRes.json();
    assert.match(replayBody.error, /invalid, expired, or has already been used/i);

    // 3. Fictitious action code fails
    const fakeReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: "non_existent_code_xyz", newPassword: "AnotherPassword123!" }),
    });
    const fakeRes = await authResetPasswordPost(fakeReq);
    assert.strictEqual(fakeRes.status, 400);
  });

  it("12.5. invalidates active pre-existing session tokens after password reset", async () => {
    const reg = await registerUser(
      { email: "eve@example.com", password: "EveOldPassword123!", displayName: "Eve" },
      testStore
    );

    // Issue session token before password change
    const oldSessionToken = reg.token;
    const reqWithOldSession = new Request("http://localhost/api/auth/me", {
      headers: { Cookie: `rewind_session=${oldSessionToken}` },
    });
    const userBeforeReset = await getAuthenticatedUser(reqWithOldSession, testStore);
    assert.ok(userBeforeReset, "User should be authenticated before password reset");

    // Perform password reset (which updates passwordChangedAt)
    await sendPasswordResetEmail("eve@example.com");
    const code = getMockResetCodeForEmail("eve@example.com");
    assert.ok(code);

    await confirmPasswordReset(code, "EveNewPassword123!", testStore);

    // Check with the old session token: must be rejected because createdAt < passwordChangedAt!
    const userAfterReset = await getAuthenticatedUser(reqWithOldSession, testStore);
    assert.strictEqual(userAfterReset, null, "Old session token must be invalidated after password reset");

    // New login succeeds and issues valid session
    const newLogin = await loginUser({ email: "eve@example.com", password: "EveNewPassword123!" }, testStore);
    const reqWithNewSession = new Request("http://localhost/api/auth/me", {
      headers: { Cookie: `rewind_session=${newLogin.token}` },
    });
    const userWithNewSession = await getAuthenticatedUser(reqWithNewSession, testStore);
    assert.ok(userWithNewSession, "New session token must be valid");
  });

  it("12.6. enforces rate limiting on /api/auth/reset-password against brute force attempts", async () => {
    const testIp = "198.51.100.199";
    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
        body: JSON.stringify({ oobCode: `code-${i}`, newPassword: "ShortPass123!" }),
      });
      await authResetPasswordPost(req);
    }

    const blockedReq = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
      body: JSON.stringify({ oobCode: "code-blocked", newPassword: "ShortPass123!" }),
    });
    const blockedRes = await authResetPasswordPost(blockedReq);
    assert.strictEqual(blockedRes.status, 429);
  });

  // -------------------------------------------------------------------------
  // 12.7 & 12.8: Pre-Commit Security Hardening (IP Extraction & Session Revocation)
  // -------------------------------------------------------------------------
  it("12.7. safely extracts client IP, prevents X-Forwarded-For spoofing, and enforces platform header precedence", () => {
    // 1. Spoofed X-Forwarded-For: Attacker prepends fake IP to bypass rate limits
    // In reverse-proxy chains (e.g. Vercel), proxy appends the real remote address to the right.
    const spoofedReq = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.50" },
    });
    const extractedSpoofed = extractClientIp(spoofedReq);
    assert.strictEqual(
      extractedSpoofed,
      "203.0.113.50",
      "Must extract rightmost proxy-appended IP and ignore attacker-controlled leftmost IP"
    );

    // 2. Trusted Platform Precedence: x-real-ip (set and stripped by Vercel edge) overrides x-forwarded-for
    const platformReq = new Request("http://localhost/api/test", {
      headers: {
        "x-real-ip": "198.51.100.7",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      },
    });
    assert.strictEqual(
      extractClientIp(platformReq),
      "198.51.100.7",
      "Platform-guaranteed x-real-ip must take precedence over x-forwarded-for"
    );

    // 3. Vercel-specific forwarded header precedence over general x-forwarded-for
    const vercelReq = new Request("http://localhost/api/test", {
      headers: {
        "x-vercel-forwarded-for": "198.51.100.12",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    assert.strictEqual(
      extractClientIp(vercelReq),
      "198.51.100.12",
      "x-vercel-forwarded-for must take precedence over general x-forwarded-for"
    );

    // 4. Backward compatibility: Single IP in x-forwarded-for resolves correctly
    const singleReq = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "198.51.100.42" },
    });
    assert.strictEqual(extractClientIp(singleReq), "198.51.100.42");

    // 5. Missing headers fallback to conservative 127.0.0.1
    const emptyReq = new Request("http://localhost/api/test");
    assert.strictEqual(extractClientIp(emptyReq), "127.0.0.1");

    // 6. Trims whitespace properly
    const spacedReq = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": " 1.2.3.4 ,  203.0.113.88  " },
    });
    assert.strictEqual(extractClientIp(spacedReq), "203.0.113.88");
  });

  it("12.8. resolves the production session-revocation gap and verifies revocation-aware verification defaults", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCheckRevoked = process.env.CHECK_REVOKED_SESSION_COOKIES;

    try {
      // 1. In Production, session revocation checking defaults to TRUE (secure by default)
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.CHECK_REVOKED_SESSION_COOKIES;
      assert.strictEqual(
        isSessionRevocationCheckEnabled(),
        true,
        "Production must default to revocation-aware session checking to prevent session-revocation gap"
      );

      // 2. In Production, operators can explicitly opt out if needed for performance or outage resilience
      process.env.CHECK_REVOKED_SESSION_COOKIES = "false";
      assert.strictEqual(
        isSessionRevocationCheckEnabled(),
        false,
        "Explicit CHECK_REVOKED_SESSION_COOKIES=false must disable revocation check in production"
      );

      // 3. In Test/Dev, session revocation checking defaults to FALSE (prevents network calls in tests)
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      delete process.env.CHECK_REVOKED_SESSION_COOKIES;
      assert.strictEqual(
        isSessionRevocationCheckEnabled(),
        false,
        "Test/Dev must default to false to avoid external network calls"
      );

      // 4. In Test/Dev, operators can explicitly opt in
      process.env.CHECK_REVOKED_SESSION_COOKIES = "true";
      assert.strictEqual(
        isSessionRevocationCheckEnabled(),
        true,
        "Explicit CHECK_REVOKED_SESSION_COOKIES=true must enable revocation check in test/dev"
      );

      // 5. Demonstrates the difference between signature/expiry validation and revocation-aware verification
      // Simulate verification behavior:
      type MockToken = { uid: string; exp: number; revoked: boolean };
      const testToken: MockToken = { uid: "user_456", exp: Date.now() + 3600000, revoked: true };

      const verifyMockToken = (token: MockToken, checkRevoked: boolean) => {
        // Step A: Local signature & expiration verification (offline, 0ms latency)
        if (token.exp < Date.now()) {
          throw new Error("Token expired");
        }
        // Step B: Revocation check (online HTTPS call to Firebase Auth, ~50-100ms latency)
        if (checkRevoked && token.revoked) {
          throw new Error("auth/session-cookie-revoked: Firebase session cookie has been revoked");
        }
        return { uid: token.uid };
      };

      // With checkRevoked: false -> signature check passes, revoked token is mistakenly accepted!
      const unverifiedResult = verifyMockToken(testToken, false);
      assert.strictEqual(unverifiedResult.uid, "user_456", "checkRevoked=false only verifies signature/expiry");

      // With checkRevoked: true -> online revocation check catches and rejects the revoked session!
      assert.throws(
        () => verifyMockToken(testToken, true),
        /auth\/session-cookie-revoked/i,
        "checkRevoked=true must reject sessions revoked by password reset"
      );
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      if (originalCheckRevoked !== undefined) {
        process.env.CHECK_REVOKED_SESSION_COOKIES = originalCheckRevoked;
      } else {
        delete process.env.CHECK_REVOKED_SESSION_COOKIES;
      }
    }
  });
});

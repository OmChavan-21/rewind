import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AuthUser, AuthSession, RegisterRequest, LoginRequest, UserRole } from "../types/auth";
import type { ProjectMetadata } from "../types/project";
import { getDefaultStoreRoot } from "../engine/recoveryEngine";
import { atomicWriteFileSync } from "../engine/storage";
import { getProject, DEFAULT_PROJECT_ID } from "../engine/projectManager";
import { checkFirebaseStatus, getFirestoreDb } from "./firebaseService";

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  constructor(message: string = "Unauthorized: Authentication required.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message: string = "Forbidden: You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string = "Resource not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

interface StoredDevUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string | null;
  passwordHash: string;
  salt: string;
  role: UserRole;
  creditAllowance: number;
  creditsUsed: number;
  createdAt: string;
  updatedAt: string;
}

const SESSION_COOKIE_NAME = "rewind_session";
const DEV_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || "rewind-session-signing-secret-safe-dev-key-2026";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getAuthStorePath(storeRoot: string): string {
  const dir = path.join(storeRoot, "auth");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "users.json");
}

function loadDevUsers(storeRoot: string): Record<string, StoredDevUser> {
  const filePath = getAuthStorePath(storeRoot);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveDevUsers(users: Record<string, StoredDevUser>, storeRoot: string): void {
  const filePath = getAuthStorePath(storeRoot);
  atomicWriteFileSync(filePath, JSON.stringify(users, null, 2));
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
}

/**
 * Creates an HMAC-signed development session token.
 */
export function createDevSessionToken(user: AuthUser): string {
  const session: AuthSession = {
    userId: user.uid,
    email: user.email,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
    createdAt: Date.now(),
    authProvider: user.authProvider,
  };

  const payloadStr = JSON.stringify(session);
  const payloadB64 = Buffer.from(payloadStr, "utf-8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", DEV_SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");

  return `dev_${payloadB64}.${signature}`;
}

/**
 * Verifies and decodes a signed development session token.
 */
export function verifyDevSessionToken(token: string): AuthSession | null {
  if (!token.startsWith("dev_")) {
    return null;
  }

  const parts = token.slice(4).split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadB64, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", DEV_SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature, "utf-8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf-8");

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const session: AuthSession = JSON.parse(payloadStr);

    if (Date.now() > session.expiresAt) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Extracts raw session token from Request (Authorization header or Cookie).
 */
export function extractTokenFromRequest(request: Request): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  // 2. Cookie header: rewind_session=<token>
  const cookieHeader = request.headers.get("cookie") || request.headers.get("Cookie");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        return cookie.slice(SESSION_COOKIE_NAME.length + 1).trim();
      }
    }
  }

  return null;
}

/**
 * Generates Set-Cookie header string for session cookie.
 */
export function createSessionCookieHeader(token: string, maxAgeSeconds: number = 7 * 24 * 3600): string {
  const isSecure = process.env.NODE_ENV === "production" && !process.env.REWIND_BIND_HOST?.includes("127.0.0.1");
  const secureFlag = isSecure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

/**
 * Generates Set-Cookie header string to clear session cookie.
 */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Authenticates user from request.
 * Returns AuthUser if valid, or null if unauthenticated.
 */
export async function getAuthenticatedUser(
  request: Request,
  storeRoot: string = getDefaultStoreRoot()
): Promise<AuthUser | null> {
  const token = extractTokenFromRequest(request);

  if (token) {
    // 1. Check if token is local dev token
    const devSession = verifyDevSessionToken(token);
    if (devSession) {
      const users = loadDevUsers(storeRoot);
      const user = users[devSession.userId];
      if (user) {
        return {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          role: user.role,
          creditAllowance: user.creditAllowance,
          creditsUsed: user.creditsUsed,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          authProvider: "development",
        };
      }
    }

    // 2. Check if Firebase is configured and verify Firebase ID token
    const fbStatus = await checkFirebaseStatus();
    if (fbStatus.configured && fbStatus.state === "connected") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getAuth } = require("firebase-admin/auth");
        const decoded = await getAuth().verifyIdToken(token);
        if (decoded && decoded.uid) {
          return {
            uid: decoded.uid,
            email: decoded.email || `${decoded.uid}@firebase.user`,
            displayName: decoded.name || decoded.email?.split("@")[0] || "Firebase Developer",
            photoURL: decoded.picture || null,
            role: "developer",
            creditAllowance: 100,
            creditsUsed: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            authProvider: "firebase",
          };
        }
      } catch {
        // Not a valid Firebase ID token or verification failed
      }
    }
  }

  // 3. Fallback: Development/test mock mode when running locally or during tests
  // STRICTLY disabled in production or when REWIND_STRICT_AUTH / REWIND_DISABLE_DEV_AUTH is active
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REWIND_STRICT_AUTH !== "true" &&
    process.env.REWIND_DISABLE_DEV_AUTH !== "true"
  ) {
    return {
      uid: "default_developer",
      email: "dev@rewind.local",
      displayName: "Default Developer",
      photoURL: null,
      role: "developer",
      activeProjectId: DEFAULT_PROJECT_ID,
      creditAllowance: 100,
      creditsUsed: 0,
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
      authProvider: "development",
    };
  }

  return null;
}

/**
 * Asserts user is authenticated. Throws AuthenticationError if not.
 */
export async function requireAuthenticatedUser(
  request: Request,
  storeRoot: string = getDefaultStoreRoot()
): Promise<AuthUser> {
  const user = await getAuthenticatedUser(request, storeRoot);
  if (!user) {
    throw new AuthenticationError();
  }
  return user;
}

/**
 * Asserts that user has permission to access a project.
 * Throws NotFoundError if project does not exist, or ForbiddenError if owned by another user.
 */
export function assertProjectAccess(
  user: AuthUser,
  projectId: string,
  storeRoot: string = getDefaultStoreRoot(),
  _requiredAccess: "read" | "write" = "read"
): ProjectMetadata {
  void _requiredAccess;
  const project = getProject(projectId, storeRoot);
  if (!project) {
    throw new NotFoundError(`Project '${projectId}' not found.`);
  }

  // Default demo workspace is accessible to all authenticated users
  if (project.id === DEFAULT_PROJECT_ID) {
    return project;
  }

  // User-created projects require ownership
  if (project.userId && project.userId !== user.uid) {
    throw new ForbiddenError(`You do not have permission to access project '${projectId}'.`);
  }

  return project;
}

/**
 * Registers a new user.
 * Enforces email format, password length, and rejects privilege escalation.
 */
export async function registerUser(
  req: RegisterRequest,
  storeRoot: string = getDefaultStoreRoot()
): Promise<{ user: AuthUser; token: string }> {
  const email = (req.email || "").trim().toLowerCase();
  const password = req.password || "";
  const displayName = (req.displayName || "").trim() || email.split("@")[0] || "Developer";

  if (!email || !email.includes("@")) {
    throw new Error("A valid email address is required.");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }

  // Check if Firebase is configured
  const fbStatus = await checkFirebaseStatus();
  if (fbStatus.configured && fbStatus.state === "connected") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAuth } = require("firebase-admin/auth");
      const userRecord = await getAuth().createUser({
        email,
        password,
        displayName,
      });

      const user: AuthUser = {
        uid: userRecord.uid,
        email: userRecord.email || email,
        displayName: userRecord.displayName || displayName,
        photoURL: userRecord.photoURL || null,
        role: "developer", // Strictly prevent privilege escalation
        creditAllowance: 100,
        creditsUsed: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authProvider: "firebase",
      };

      // Sync user profile to Firestore
      const db = await getFirestoreDb();
      if (db) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).collection("users").doc(user.uid).set(user, { merge: true });
      }

      const token = createDevSessionToken(user);
      return { user, token };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Firebase registration failed.";
      throw new Error(`Registration failed: ${message}`);
    }
  }

  // Development mode: store in .rewind_store/auth/users.json
  const users = loadDevUsers(storeRoot);
  for (const existing of Object.values(users)) {
    if (existing.email === email) {
      throw new Error("An account with this email address already exists.");
    }
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const uid = `usr_${crypto.randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();

  const storedUser: StoredDevUser = {
    uid,
    email,
    displayName,
    passwordHash,
    salt,
    role: "developer", // Strictly prevent privilege escalation
    creditAllowance: 100,
    creditsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };

  users[uid] = storedUser;
  saveDevUsers(users, storeRoot);

  const user: AuthUser = {
    uid,
    email,
    displayName,
    photoURL: null,
    role: "developer",
    creditAllowance: 100,
    creditsUsed: 0,
    createdAt: now,
    updatedAt: now,
    authProvider: "development",
  };

  const token = createDevSessionToken(user);
  return { user, token };
}

/**
 * Logs in an existing user with email and password.
 */
export async function loginUser(
  req: LoginRequest,
  storeRoot: string = getDefaultStoreRoot()
): Promise<{ user: AuthUser; token: string }> {
  const email = (req.email || "").trim().toLowerCase();
  const password = req.password || "";

  if (!email || !password) {
    throw new Error("Email and password are required.");
  }

  const fbStatus = await checkFirebaseStatus();
  if (fbStatus.configured && fbStatus.state === "connected") {
    // In Firebase mode, client gets ID token or server exchanges with Firebase Identity REST API
    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
    if (apiKey) {
      const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.idToken) {
        throw new Error(data.error?.message || "Invalid credentials.");
      }

      const user: AuthUser = {
        uid: data.localId,
        email: data.email,
        displayName: data.displayName || email.split("@")[0],
        photoURL: null,
        role: "developer",
        creditAllowance: 100,
        creditsUsed: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        authProvider: "firebase",
      };

      const token = createDevSessionToken(user);
      return { user, token };
    }
  }

  // Development mode: verify against .rewind_store/auth/users.json
  const users = loadDevUsers(storeRoot);
  let matchedUser: StoredDevUser | null = null;
  for (const u of Object.values(users)) {
    if (u.email === email) {
      matchedUser = u;
      break;
    }
  }

  if (!matchedUser) {
    throw new Error("Invalid email or password.");
  }

  const computedHash = hashPassword(password, matchedUser.salt);
  const hashBuffer = Buffer.from(computedHash, "hex");
  const storedBuffer = Buffer.from(matchedUser.passwordHash, "hex");

  if (hashBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(hashBuffer, storedBuffer)) {
    throw new Error("Invalid email or password.");
  }

  const user: AuthUser = {
    uid: matchedUser.uid,
    email: matchedUser.email,
    displayName: matchedUser.displayName,
    photoURL: matchedUser.photoURL,
    role: matchedUser.role,
    creditAllowance: matchedUser.creditAllowance,
    creditsUsed: matchedUser.creditsUsed,
    createdAt: matchedUser.createdAt,
    updatedAt: matchedUser.updatedAt,
    authProvider: "development",
  };

  const token = createDevSessionToken(user);
  return { user, token };
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatSession, ChatMessage, CreateChatSessionRequest } from "../types/chat";
import type { ProjectMemory, UserGlobalMemory } from "../types/memory";
import { getDefaultStoreRoot } from "./recoveryEngine";
import { atomicWriteFileSync } from "./storage";
import {
  SecurityError,
  validateProjectId,
  validateSessionId,
  validateMemoryId,
} from "../security/boundaries";

export const DEFAULT_USER_ID = "default_developer";

function getCanonicalStore(storeRoot: string): string {
  return fs.existsSync(storeRoot) ? fs.realpathSync(storeRoot) : path.resolve(storeRoot);
}

function verifyStoreContainment(storeRoot: string, targetPath: string): void {
  const canonicalStore = getCanonicalStore(storeRoot);
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(canonicalStore + path.sep) && resolved !== canonicalStore) {
    throw new SecurityError(`Path escapes store boundaries: '${targetPath}'`);
  }
}

function getProjectChatDir(projectId: string, storeRoot: string): string {
  validateProjectId(projectId);
  const dir = path.join(storeRoot, "projects", projectId, "chat");
  verifyStoreContainment(storeRoot, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getProjectMessagesDir(projectId: string, storeRoot: string): string {
  const chatDir = getProjectChatDir(projectId, storeRoot);
  const messagesDir = path.join(chatDir, "messages");
  if (!fs.existsSync(messagesDir)) {
    fs.mkdirSync(messagesDir, { recursive: true });
  }
  return messagesDir;
}

function getProjectMemoriesDir(projectId: string, storeRoot: string): string {
  validateProjectId(projectId);
  const dir = path.join(storeRoot, "projects", projectId, "memories");
  verifyStoreContainment(storeRoot, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Chat Sessions
// ---------------------------------------------------------------------------

function getSessionsFilePath(projectId: string, storeRoot: string): string {
  return path.join(getProjectChatDir(projectId, storeRoot), "sessions.json");
}

function loadSessionsMap(projectId: string, storeRoot: string): Record<string, ChatSession> {
  const filePath = getSessionsFilePath(projectId, storeRoot);
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

function saveSessionsMap(
  projectId: string,
  map: Record<string, ChatSession>,
  storeRoot: string
): void {
  const filePath = getSessionsFilePath(projectId, storeRoot);
  atomicWriteFileSync(filePath, JSON.stringify(map, null, 2));
}

/**
 * Lists all chat sessions for a project, filtered by user if requested.
 * Sorted descending by lastMessageAt / createdAt.
 */
export function listChatSessions(
  projectId: string,
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string
): ChatSession[] {
  validateProjectId(projectId);
  const map = loadSessionsMap(projectId, storeRoot);
  const list = Object.values(map);

  const filtered = userId ? list.filter((s) => s.userId === userId) : list;
  return filtered.sort(
    (a, b) => new Date(b.lastMessageAt || b.createdAt).getTime() - new Date(a.lastMessageAt || a.createdAt).getTime()
  );
}

/**
 * Retrieves a single chat session by ID, asserting ownership if userId is supplied.
 */
export function getChatSession(
  projectId: string,
  sessionId: string,
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string
): ChatSession | null {
  validateProjectId(projectId);
  validateSessionId(sessionId);
  const map = loadSessionsMap(projectId, storeRoot);
  const session = map[sessionId] || null;

  if (session && userId && session.userId !== userId) {
    throw new SecurityError(`Access denied: Session '${sessionId}' does not belong to user '${userId}'.`);
  }

  return session;
}

/**
 * Creates a new chat session scoped strictly under the designated project.
 */
export function createChatSession(
  request: CreateChatSessionRequest,
  storeRoot: string = getDefaultStoreRoot(),
  userId: string = DEFAULT_USER_ID
): ChatSession {
  const projectId = request.projectId.trim();
  validateProjectId(projectId);

  const now = new Date().toISOString();
  const sessionUnique = crypto.randomBytes(4).toString("hex");
  const sessionId = `sess_${Date.now()}_${sessionUnique}`;

  const title = (request.title || "").trim() || "New Project Chat";

  const session: ChatSession = {
    id: sessionId,
    projectId,
    userId,
    title,
    activeModel: request.model || "nvidia/nemotron-3.5-lightning-30b-a3b",
    routingMode: request.routingMode || "auto",
    messageCount: 0,
    extractedMemoriesCount: 0,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  };

  const map = loadSessionsMap(projectId, storeRoot);
  map[sessionId] = session;
  saveSessionsMap(projectId, map, storeRoot);

  return session;
}

// ---------------------------------------------------------------------------
// 2. Chat Messages
// ---------------------------------------------------------------------------

function getMessagesFilePath(projectId: string, sessionId: string, storeRoot: string): string {
  validateSessionId(sessionId);
  const messagesDir = getProjectMessagesDir(projectId, storeRoot);
  const file = path.join(messagesDir, `${sessionId}.json`);
  verifyStoreContainment(storeRoot, file);
  return file;
}

/**
 * Lists all messages in a project chat session, sorted chronologically.
 */
export function listChatMessages(
  projectId: string,
  sessionId: string,
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string
): ChatMessage[] {
  // Validate ownership first
  const session = getChatSession(projectId, sessionId, storeRoot, userId);
  if (!session) {
    return [];
  }

  const filePath = getMessagesFilePath(projectId, sessionId, storeRoot);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: ChatMessage[] = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Adds a message to a session, updating session message count and timestamps.
 */
export function addChatMessage(
  projectId: string,
  sessionId: string,
  messageData: Omit<ChatMessage, "id" | "createdAt" | "projectId" | "sessionId" | "userId">,
  storeRoot: string = getDefaultStoreRoot(),
  userId: string = DEFAULT_USER_ID
): ChatMessage {
  const session = getChatSession(projectId, sessionId, storeRoot, userId);
  if (!session) {
    throw new SecurityError(`Chat session '${sessionId}' not found in project '${projectId}'.`);
  }

  const now = new Date().toISOString();
  const msgUnique = crypto.randomBytes(4).toString("hex");
  const messageId = `msg_${Date.now()}_${msgUnique}`;

  const message: ChatMessage = {
    id: messageId,
    sessionId,
    projectId,
    userId,
    role: messageData.role,
    content: messageData.content,
    reasoning: messageData.reasoning,
    proposalId: messageData.proposalId,
    containsCoreIntent: messageData.containsCoreIntent ?? false,
    tokenUsage: messageData.tokenUsage,
    createdAt: now,
  };

  const messages = listChatMessages(projectId, sessionId, storeRoot);
  messages.push(message);

  const filePath = getMessagesFilePath(projectId, sessionId, storeRoot);
  atomicWriteFileSync(filePath, JSON.stringify(messages, null, 2));

  // Update session stats
  const sessionsMap = loadSessionsMap(projectId, storeRoot);
  if (sessionsMap[sessionId]) {
    sessionsMap[sessionId].messageCount = messages.length;
    sessionsMap[sessionId].lastMessageAt = now;
    sessionsMap[sessionId].updatedAt = now;
    saveSessionsMap(projectId, sessionsMap, storeRoot);
  }

  return message;
}

// ---------------------------------------------------------------------------
// 3. Project Memory Membrane
// ---------------------------------------------------------------------------

function getProjectMemoriesFilePath(projectId: string, storeRoot: string): string {
  return path.join(getProjectMemoriesDir(projectId, storeRoot), "memories.json");
}

function loadProjectMemoriesMap(projectId: string, storeRoot: string): Record<string, ProjectMemory> {
  const filePath = getProjectMemoriesFilePath(projectId, storeRoot);
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

function saveProjectMemoriesMap(
  projectId: string,
  map: Record<string, ProjectMemory>,
  storeRoot: string
): void {
  const filePath = getProjectMemoriesFilePath(projectId, storeRoot);
  atomicWriteFileSync(filePath, JSON.stringify(map, null, 2));
}

/**
 * Lists memories for a project, optionally filtering to active-only or user-owned.
 */
export function listProjectMemories(
  projectId: string,
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string,
  activeOnly: boolean = true
): ProjectMemory[] {
  validateProjectId(projectId);
  const map = loadProjectMemoriesMap(projectId, storeRoot);
  let list = Object.values(map);

  if (activeOnly) {
    list = list.filter((m) => m.isActive);
  }
  if (userId) {
    list = list.filter((m) => m.userId === userId);
  }

  // Sort by importance descending, then createdAt descending
  return list.sort((a, b) => {
    if (b.importance !== a.importance) {
      return b.importance - a.importance;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Saves or updates a project memory item in the project membrane.
 */
export function saveProjectMemory(
  projectId: string,
  memory: ProjectMemory,
  storeRoot: string = getDefaultStoreRoot(),
  userId: string = DEFAULT_USER_ID
): ProjectMemory {
  validateProjectId(projectId);
  validateMemoryId(memory.id);

  if (memory.userId && memory.userId !== userId) {
    throw new SecurityError("Unauthorized to modify memory for another user.");
  }

  const map = loadProjectMemoriesMap(projectId, storeRoot);
  map[memory.id] = {
    ...memory,
    projectId,
    userId,
    updatedAt: new Date().toISOString(),
  };

  saveProjectMemoriesMap(projectId, map, storeRoot);

  // If memory originated from a chat session, increment that session's extractedMemoriesCount
  if (memory.sourceSessionId) {
    try {
      const sessionsMap = loadSessionsMap(projectId, storeRoot);
      if (sessionsMap[memory.sourceSessionId]) {
        sessionsMap[memory.sourceSessionId].extractedMemoriesCount =
          (sessionsMap[memory.sourceSessionId].extractedMemoriesCount || 0) + 1;
        saveSessionsMap(projectId, sessionsMap, storeRoot);
      }
    } catch {
      // Non-fatal
    }
  }

  return map[memory.id];
}

/**
 * Deactivates a memory item in the project membrane.
 */
export function deactivateProjectMemory(
  projectId: string,
  memoryId: string,
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string
): boolean {
  validateProjectId(projectId);
  validateMemoryId(memoryId);

  const map = loadProjectMemoriesMap(projectId, storeRoot);
  const memory = map[memoryId];
  if (!memory) return false;

  if (userId && memory.userId !== userId) {
    throw new SecurityError(`Access denied: Memory '${memoryId}' does not belong to user '${userId}'.`);
  }

  memory.isActive = false;
  memory.updatedAt = new Date().toISOString();
  saveProjectMemoriesMap(projectId, map, storeRoot);
  return true;
}

// ---------------------------------------------------------------------------
// 4. Global Developer Memories
// ---------------------------------------------------------------------------

function getGlobalMemoriesFilePath(storeRoot: string): string {
  const file = path.join(storeRoot, "global_memories.json");
  verifyStoreContainment(storeRoot, file);
  return file;
}

function loadGlobalMemoriesMap(storeRoot: string): Record<string, UserGlobalMemory> {
  const filePath = getGlobalMemoriesFilePath(storeRoot);
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

function saveGlobalMemoriesMap(map: Record<string, UserGlobalMemory>, storeRoot: string): void {
  const filePath = getGlobalMemoriesFilePath(storeRoot);
  atomicWriteFileSync(filePath, JSON.stringify(map, null, 2));
}

/**
 * Lists global developer memories.
 */
export function listGlobalMemories(
  storeRoot: string = getDefaultStoreRoot(),
  userId?: string
): UserGlobalMemory[] {
  const map = loadGlobalMemoriesMap(storeRoot);
  let list = Object.values(map);
  if (userId) {
    list = list.filter((m) => m.userId === userId);
  }
  return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Saves a global developer memory.
 */
export function saveGlobalMemory(
  memory: UserGlobalMemory,
  storeRoot: string = getDefaultStoreRoot(),
  userId: string = DEFAULT_USER_ID
): UserGlobalMemory {
  validateMemoryId(memory.id);

  if (memory.userId && memory.userId !== userId) {
    throw new SecurityError("Unauthorized to modify global memory for another user.");
  }

  const map = loadGlobalMemoriesMap(storeRoot);
  map[memory.id] = {
    ...memory,
    userId,
    updatedAt: new Date().toISOString(),
  };

  saveGlobalMemoriesMap(map, storeRoot);
  return map[memory.id];
}

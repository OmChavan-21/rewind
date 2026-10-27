import { listProjectMemories, listGlobalMemories, listChatMessages } from "../../engine/chatMemoryStore";
import { searchProjectKnowledge } from "../ragService";

export interface AssembleContextOptions {
  projectId: string;
  sessionId?: string;
  userPrompt: string;
  storeRoot: string;
  userId?: string;
  maxMemories?: number;
  maxRecentMessages?: number;
  maxRagChunks?: number;
}

export interface AssembledDeveloperContext {
  memorySection: string;
  globalMemorySection: string;
  recentHistorySection: string;
  ragSection: string;
  augmentedSystemPromptText: string;
  retrievedMemoriesCount: number;
  retrievedHistoryCount: number;
  retrievedRagChunksCount: number;
}

/**
 * Assembles project-scoped context for the Project Developer LLM.
 * Strictly bounded and prioritized to prevent context window saturation.
 */
export async function assembleDeveloperContext(
  options: AssembleContextOptions
): Promise<AssembledDeveloperContext> {
  const {
    projectId,
    sessionId,
    userPrompt,
    storeRoot,
    userId,
    maxMemories = 5,
    maxRecentMessages = 4,
    maxRagChunks = 3,
  } = options;

  // 1. Retrieve Active Project Memories from the Membrane
  const activeMemories = listProjectMemories(projectId, storeRoot, userId, true);
  // Sort prioritized: technical constraints first, then architectural decisions, then goals
  const sortedMemories = [...activeMemories].sort((a, b) => b.importance - a.importance);
  const selectedMemories = sortedMemories.slice(0, maxMemories);

  let memorySection = "";
  if (selectedMemories.length > 0) {
    const memoryLines = selectedMemories.map((m) => {
      const catLabel =
        m.category === "technical_constraint"
          ? "Technical Constraint"
          : m.category === "architectural_decision"
          ? "Architectural Decision"
          : m.category === "project_intent"
          ? "Project Goal"
          : "Resolved Pattern";
      return `- [${catLabel}] (${m.title}): ${m.distilledIntent}`;
    });
    memorySection = `PROJECT MEMORY MEMBRANE (Distilled User Intentions & Architecture):\n${memoryLines.join("\n")}`;
  }

  // 2. Retrieve Global Developer Preferences
  const globalMemories = listGlobalMemories(storeRoot, userId).slice(0, 3);
  let globalMemorySection = "";
  if (globalMemories.length > 0) {
    const globalLines = globalMemories.map((g) => `- [Developer Preference] ${g.title}: ${g.content}`);
    globalMemorySection = `DEVELOPER GLOBAL PREFERENCES:\n${globalLines.join("\n")}`;
  }

  // 3. Retrieve Recent Session Chat Turns
  let recentHistorySection = "";
  let retrievedHistoryCount = 0;
  if (sessionId) {
    try {
      const messages = listChatMessages(projectId, sessionId, storeRoot, userId);
      // Take last N messages before the current prompt
      const recent = messages.slice(-maxRecentMessages);
      retrievedHistoryCount = recent.length;
      if (recent.length > 0) {
        const historyLines = recent.map((msg) => {
          const roleLabel = msg.role === "user" ? "User" : "Assistant";
          const snippet = msg.content.length > 400 ? msg.content.slice(0, 400) + "..." : msg.content;
          return `${roleLabel}: ${snippet}`;
        });
        recentHistorySection = `RECENT PROJECT CHAT HISTORY (Last ${recent.length} turns):\n${historyLines.join("\n")}`;
      }
    } catch {
      // Non-fatal
    }
  }

  // 4. Targeted RAG Retrieval (top relevant chunks for this project)
  let ragSection = "";
  let retrievedRagChunksCount = 0;
  try {
    const ragResults = await searchProjectKnowledge(projectId, userPrompt, maxRagChunks, 0.1, storeRoot);
    retrievedRagChunksCount = ragResults.length;
    if (ragResults.length > 0) {
      const chunkSnippets = ragResults.map(
        (r, i) =>
          `[Targeted Code Excerpt ${i + 1} from ${r.chunk.fileName}]:\n${r.chunk.text.slice(0, 600)}`
      );
      ragSection = `TARGETED KNOWLEDGE & CODE EXCERPTS (Retrieved via RAG):\n${chunkSnippets.join("\n\n")}`;
    }
  } catch {
    // Non-fatal
  }

  // Assemble the combined context string for the LLM
  const parts: string[] = [];
  if (memorySection) parts.push(memorySection);
  if (globalMemorySection) parts.push(globalMemorySection);
  if (recentHistorySection) parts.push(recentHistorySection);
  if (ragSection) parts.push(ragSection);

  const augmentedSystemPromptText = parts.join("\n\n");

  return {
    memorySection,
    globalMemorySection,
    recentHistorySection,
    ragSection,
    augmentedSystemPromptText,
    retrievedMemoriesCount: selectedMemories.length,
    retrievedHistoryCount,
    retrievedRagChunksCount,
  };
}

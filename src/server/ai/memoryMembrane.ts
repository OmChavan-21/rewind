import crypto from "node:crypto";
import type { ProjectMemory, MemoryCategory, MemoryExtractionResult } from "../../types/memory";
import { saveProjectMemory, listProjectMemories, DEFAULT_USER_ID } from "../../engine/chatMemoryStore";

// Patterns for conversational noise to exclude immediately
const GREETING_NOISE = /^(hi|hello|hey|good\s+(morning|afternoon|evening|day)|thanks|thank\s+you|ok|okay|got\s+it|cool|great|bye|goodbye|see\s+you)\b[.!?, ]*$/i;
const SPECULATIVE_NOISE = /^(maybe\s+we\s+could|what\s+if\s+we|could\s+we\s+possibly|i\s+wonder\s+if|perhaps\s+we\s+might|let['’]?s\s+think\s+about)\b/i;
const TEMPORARY_DEBUG_NOISE = /^(let\s+me\s+check|wait\s+a\s+sec|just\s+testing|testing\s+this\s+out|quick\s+test|syntax\s+error\s+on\s+line|typo\s+here)\b/i;

// Safety and injection rejection patterns
const DANGEROUS_DIRECTIVE_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /disable\s+(safety|sandbox|verification|limits|checks)/i,
  /permit\s+(eval|exec|shell|binary|\.env|credentials)/i,
  /override\s+(security|invariants|boundaries)/i,
  /<script\b/i,
];

function sanitizeMemoryText(text: string): string {
  // Strip private reasoning / chain-of-thought tags
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "");

  // Strip system prompt control tags
  cleaned = cleaned.replace(/\b(system|assistant|user):/gi, "");

  return cleaned.trim();
}

function isDangerousDirective(text: string): boolean {
  return DANGEROUS_DIRECTIVE_PATTERNS.some((pat) => pat.test(text));
}

function calculateStringSimilarity(s1: string, s2: string): number {
  const words1 = new Set(s1.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const words2 = new Set(s2.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  let common = 0;
  for (const w of words1) {
    if (words2.has(w)) common++;
  }

  const union = new Set([...words1, ...words2]).size;
  return union > 0 ? common / union : 0;
}

interface CandidateMemoryExtraction {
  category: MemoryCategory;
  title: string;
  distilledIntent: string;
  importance: number;
  tags: string[];
}

/**
 * Analyzes a text fragment and extracts high-signal memory candidates.
 */
function identifyCandidateMemories(text: string): CandidateMemoryExtraction[] {
  const candidates: CandidateMemoryExtraction[] = [];
  const lines = text
    .split(/\n+|\.\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 15);

  for (const line of lines) {
    // Check for conversational noise
    if (GREETING_NOISE.test(line) || SPECULATIVE_NOISE.test(line) || TEMPORARY_DEBUG_NOISE.test(line)) {
      continue;
    }

    // 1. Technical Constraints & Invariants (Importance: 5)
    if (
      /\b(never\s+modify|never\s+change|must\s+strictly|do\s+not\s+(modify|use|touch|alter)|keep\s+all\s+safety\s+invariants|cannot\s+exceed|enforce\s+boundary)\b/i.test(line)
    ) {
      candidates.push({
        category: "technical_constraint",
        title: "Project Technical Constraint",
        distilledIntent: line,
        importance: 5,
        tags: ["constraint", "invariant", "security"],
      });
      continue;
    }

    // 2. Architectural Decisions (Importance: 4)
    if (
      /\b(we\s+decided\s+to\s+use|architecture\s+should\s+be|store\s+state\s+in|use\s+[\w.-]+\s+instead\s+of|organize\s+files\s+into|structure\s+the\s+codebase|switch\s+to\s+[\w.-]+)\b/i.test(line)
    ) {
      candidates.push({
        category: "architectural_decision",
        title: "Architectural Decision",
        distilledIntent: line,
        importance: 4,
        tags: ["architecture", "decision"],
      });
      continue;
    }

    // 3. Project Intent (Importance: 4)
    if (
      /\b(we\s+are\s+building|the\s+goal\s+of\s+this\s+project\s+is|this\s+project\s+is\s+a|our\s+project\s+intends\s+to|primary\s+objective\s+is|aiming\s+to\s+develop)\b/i.test(line)
    ) {
      candidates.push({
        category: "project_intent",
        title: "Core Project Goal",
        distilledIntent: line,
        importance: 4,
        tags: ["intent", "goal"],
      });
      continue;
    }

    // 4. Resolved Patterns (Importance: 3)
    if (
      /\b(the\s+fix\s+was\s+to|resolved\s+by|confirmed\s+that\s+[\w\s.-]+\s+fixes|the\s+solution\s+is\s+to|correct\s+pattern\s+for\s+[\w\s.-]+\s+is)\b/i.test(line)
    ) {
      candidates.push({
        category: "resolved_pattern",
        title: "Resolved Bug Pattern & Fix",
        distilledIntent: line,
        importance: 3,
        tags: ["fix", "pattern", "solution"],
      });
      continue;
    }
  }

  return candidates;
}

/**
 * Extracts and distills core project memories from a chat conversation turn.
 * Non-destructive: errors are handled gracefully and never crash message delivery.
 */
export function extractAndPersistMemories(params: {
  projectId: string;
  sessionId: string;
  messageId: string;
  userPrompt: string;
  assistantResponse?: string;
  reasoning?: string;
  storeRoot?: string;
  userId?: string;
}): MemoryExtractionResult {
  const {
    projectId,
    sessionId,
    messageId,
    userPrompt,
    assistantResponse,
    storeRoot,
    userId = DEFAULT_USER_ID,
  } = params;

  try {
    // Check if entire user message is pure conversational noise
    const cleanPrompt = sanitizeMemoryText(userPrompt);
    if (GREETING_NOISE.test(cleanPrompt)) {
      return { extractedMemories: [], skippedReason: "Greeting or conversational noise." };
    }

    const candidateExtracts: CandidateMemoryExtraction[] = [];

    // Analyze user prompt
    candidateExtracts.push(...identifyCandidateMemories(cleanPrompt));

    // If assistant provided response with confirmed patterns, inspect it too
    if (assistantResponse) {
      const cleanResponse = sanitizeMemoryText(assistantResponse);
      const assistantCandidates = identifyCandidateMemories(cleanResponse);
      // Only keep resolved patterns or architectural conclusions from assistant
      for (const cand of assistantCandidates) {
        if (cand.category === "resolved_pattern" || cand.category === "architectural_decision") {
          candidateExtracts.push(cand);
        }
      }
    }

    if (candidateExtracts.length === 0) {
      return { extractedMemories: [], skippedReason: "No new core intentions or decisions articulated." };
    }

    // Load existing project memories to handle deduplication and superseding
    const existing = listProjectMemories(projectId, storeRoot, userId, false);
    const persisted: ProjectMemory[] = [];

    for (const cand of candidateExtracts) {
      if (isDangerousDirective(cand.distilledIntent)) {
        continue; // Discard directives attempting to breach security
      }

      // Check if this supersedes or duplicates an existing memory
      let isDuplicate = false;
      for (const ex of existing) {
        if (!ex.isActive) continue;

        const similarity = calculateStringSimilarity(cand.distilledIntent, ex.distilledIntent);

        if (similarity > 0.75) {
          // Near identical memory already active: skip saving duplicate
          isDuplicate = true;
          break;
        }

        if (ex.category === cand.category && similarity > 0.4) {
          // Related decision in same category: supersede the older one
          ex.isActive = false;
          const newId = `pmem_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
          ex.supersededBy = newId;
          saveProjectMemory(projectId, ex, storeRoot, userId);
        }
      }

      if (isDuplicate) {
        continue;
      }

      const memId = `pmem_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const now = new Date().toISOString();

      const newMemory: ProjectMemory = {
        id: memId,
        projectId,
        userId,
        sourceSessionId: sessionId,
        sourceMessageId: messageId,
        category: cand.category,
        title: cand.title,
        distilledIntent: cand.distilledIntent,
        importance: cand.importance,
        tags: cand.tags,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      const saved = saveProjectMemory(projectId, newMemory, storeRoot, userId);
      persisted.push(saved);
    }

    return { extractedMemories: persisted };
  } catch (err) {
    // Non-destructive: return graceful failure
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MemoryMembrane Extraction Warning for ${projectId}]:`, msg);
    return { extractedMemories: [], skippedReason: `Extraction error: ${msg}` };
  }
}

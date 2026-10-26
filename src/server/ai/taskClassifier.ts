/**
 * Deterministic Task Classifier
 * Analyzes user prompts and workspace context to determine task complexity,
 * security risk level, and required model capabilities without relying on an LLM.
 */

import type { TaskClassification } from "../../types/router";

const SECURITY_KEYWORDS = [
  "evaluator",
  "safetypolicy",
  "evaluatesafetypolicy",
  "securityscore",
  "threshold",
  "invariant",
  "invariants",
  "security",
  "permission",
  "credentials",
  "secret",
  "boundary",
  "traversal",
  "vulnerability",
  "exploit",
  "bypass",
  "auth",
  "sanitize",
];

const COMPLEX_KEYWORDS = [
  "refactor",
  "overhaul",
  "restructure",
  "breaking change",
  "architecture",
  "concurrency",
  "async",
  "migration",
  "state machine",
  "pipeline",
  "recovery guard",
  "automated recovery",
  "rollback handler",
  "multi-step",
];

const EXPLANATION_KEYWORDS = [
  "explain",
  "describe",
  "what is",
  "how does",
  "why",
  "summarize",
  "overview",
  "inspect",
  "show me",
  "documentation",
];

const APPROVED_FILES = [
  "src/evaluator.ts",
  "agent-workflow.json",
  "config/runtime.json",
  "README.md",
];

/**
 * Extracts candidate target file paths from the user prompt and context.
 */
export function detectTargetPaths(
  userPrompt: string,
  contextFiles: { path: string; content?: string }[] = []
): string[] {
  const normalizedPrompt = userPrompt.toLowerCase();
  const matched = new Set<string>();

  for (const approved of APPROVED_FILES) {
    const baseName = approved.split("/").pop()?.toLowerCase() || "";
    if (
      normalizedPrompt.includes(approved.toLowerCase()) ||
      (baseName && normalizedPrompt.includes(baseName))
    ) {
      matched.add(approved);
    }
  }

  // If context files are passed and only 1-2 files exist, consider them targets if mentioned
  for (const file of contextFiles) {
    const fileName = file.path.toLowerCase();
    const base = fileName.split("/").pop() || "";
    if (normalizedPrompt.includes(fileName) || (base && normalizedPrompt.includes(base))) {
      matched.add(file.path);
    }
  }

  return Array.from(matched);
}

/**
 * Pure deterministic task classifier.
 */
export function classifyTask(
  userPrompt: string,
  contextFiles: { path: string; content: string }[] = []
): TaskClassification {
  const normalized = (userPrompt || "").trim().toLowerCase();
  const targetPaths = detectTargetPaths(userPrompt, contextFiles);

  // Compute estimated prompt tokens (~4 chars per token)
  const totalChars =
    (userPrompt || "").length +
    contextFiles.reduce((acc, f) => acc + (f.content || "").length + (f.path || "").length, 0);
  const estimatedPromptTokens = Math.max(10, Math.ceil(totalChars / 4));

  // 1. Security Sensitivity Check (Highest Precedence)
  const isSecurityFile = targetPaths.some(
    (p) => p.toLowerCase().includes("evaluator.ts") || p.toLowerCase().includes("security")
  );
  const containsSecurityKeyword = SECURITY_KEYWORDS.some((kw) => normalized.includes(kw));

  if (isSecurityFile || (containsSecurityKeyword && !normalized.startsWith("explain"))) {
    return {
      complexity: "security_sensitive",
      riskLevel: "high",
      targetPaths,
      estimatedPromptTokens,
      rationale:
        "Task targets safety evaluator ('src/evaluator.ts') or invariant policies; requires high security awareness and deterministic verification.",
    };
  }

  // 2. Pure Informational / Explanation Check
  const startsWithQuestion = /^(what|how|why|explain|describe|summarize|is there|can you explain)\b/i.test(
    normalized
  );
  const isExplanation =
    (startsWithQuestion || EXPLANATION_KEYWORDS.some((kw) => normalized.includes(kw))) &&
    !normalized.includes("modify") &&
    !normalized.includes("update") &&
    !normalized.includes("inject") &&
    !normalized.includes("change");

  if (isExplanation && !isSecurityFile) {
    return {
      complexity: "simple_explanation",
      riskLevel: "low",
      targetPaths,
      estimatedPromptTokens,
      rationale:
        "Informational query or conceptual explanation with zero structural file modifications.",
    };
  }

  // 3. Documentation / Lightweight Analysis Check
  const isReadmeOnly =
    targetPaths.length === 1 && targetPaths[0].toLowerCase().endsWith("readme.md");
  const isLightweightKeyword =
    normalized.includes("comment") ||
    normalized.includes("typo") ||
    normalized.includes("readme") ||
    normalized.includes("formatting") ||
    normalized.includes("inspect");

  if (isReadmeOnly || (isLightweightKeyword && targetPaths.length <= 1 && !isSecurityFile)) {
    return {
      complexity: "lightweight_analysis",
      riskLevel: "low",
      targetPaths,
      estimatedPromptTokens,
      rationale:
        "Lightweight documentation adjustment or minor inspection with low risk and minimal execution impact.",
    };
  }

  // 4. Complex Code Modification Check
  const isMultiFile = targetPaths.length > 1;
  const hasComplexKeyword = COMPLEX_KEYWORDS.some((kw) => normalized.includes(kw));
  const isLargeContext = estimatedPromptTokens > 3000;

  if (isMultiFile || hasComplexKeyword || isLargeContext) {
    return {
      complexity: "complex_code_modification",
      riskLevel: "medium",
      targetPaths,
      estimatedPromptTokens,
      rationale:
        "Task involves multi-file structural changes, complex workflow refactoring, or extensive context.",
    };
  }

  // 5. Standard Refactor (Default for single-file approved changes)
  return {
    complexity: "standard_refactor",
    riskLevel: "medium",
    targetPaths,
    estimatedPromptTokens,
    rationale:
      "Standard single-file update or configuration modification within normal operational parameters.",
  };
}

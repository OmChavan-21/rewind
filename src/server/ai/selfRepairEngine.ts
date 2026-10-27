/**
 * Compiler-in-the-Loop Self-Repair Engine
 * Automatically repairs candidate patches by feeding compiler diagnostics,
 * Python syntax errors, and invariant failures back to the active model for
 * bounded re-generation and isolated re-verification.
 *
 * Rules:
 * 1. Maximum of 2 repair attempts.
 * 2. Never bypass security blockers, path boundaries, or required verification.
 * 3. Never trust model-generated assertions of correctness; verify using actual tools.
 * 4. Stop immediately on security violations or non-repairable errors.
 * 5. Re-stage and re-verify every candidate from scratch in an isolated sandbox.
 */

import type {
  AIChangeProposal,
  AIProvider,
  SelfRepairResult,
  RepairAttempt,
} from "../../types/ai";
import { verifyCandidatePatchInSandbox, type CandidateVerificationResult } from "../../engine/patchSandbox";
import { getActiveProvider, getProviderClient } from "./providerRegistry";
import { parseAndValidateProposal } from "../nebiusService";
import type { ProviderClient } from "./providerInterface";

export interface SelfRepairOptions {
  provider?: AIProvider;
  model?: string;
  maxAttempts?: number;
  repairClient?: ProviderClient;
}

/**
 * Determines whether a set of verification errors is repairable.
 * Security violations, path traversals, and forbidden files are STRICTLY non-repairable.
 */
function isRepairableError(result: CandidateVerificationResult): {
  repairable: boolean;
  reason?: string;
} {
  // 1. Security violations are NEVER retried or repaired around
  if (result.securityScan.violations.length > 0) {
    return {
      repairable: false,
      reason: `Security violation detected: [${result.securityScan.violations[0].ruleId}] ${result.securityScan.violations[0].message}. Automatic repair blocked to prevent policy bypass.`,
    };
  }

  // 2. Path boundaries and traversal are strictly non-repairable
  for (const err of result.errors) {
    if (
      err.includes("violates permitted file") ||
      err.includes("directory traversal") ||
      err.includes("Security Boundary Violation")
    ) {
      return {
        repairable: false,
        reason: `Path security boundary violation: ${err}`,
      };
    }
  }

  // 3. Check if there are actionable compiler, syntax, or invariant errors
  const hasDiagnosticErrors = result.diagnostics.some((d) => d.severity === "error");
  const hasInvariantErrors = result.errors.some((e) => e.includes("Workspace Invariant Failure"));
  const hasPatchErrors = result.errors.some(
    (e) => e.includes("TypeScript Error") || e.includes("Python Syntax Error")
  );

  if (hasDiagnosticErrors || hasInvariantErrors || hasPatchErrors) {
    return { repairable: true };
  }

  return {
    repairable: false,
    reason: "Verification errors are non-repairable.",
  };
}

/**
 * Formats diagnostic feedback for LLM self-repair prompt.
 */
function formatDiagnosticFeedback(result: CandidateVerificationResult): string {
  const lines: string[] = [];

  for (const diag of result.diagnostics) {
    if (diag.severity === "error") {
      lines.push(
        `- [${diag.source.toUpperCase()}] ${diag.filePath}:${diag.line}:${diag.column} (${diag.ruleId || "Error"}): ${diag.message}`
      );
      if (diag.codeSnippet) {
        lines.push(`  Code snippet: "${diag.codeSnippet}"`);
      }
      if (diag.suggestion) {
        lines.push(`  Suggested resolution: ${diag.suggestion}`);
      }
    }
  }

  for (const err of result.errors) {
    if (err.includes("Workspace Invariant Failure")) {
      lines.push(`- [WORKSPACE INVARIANT] ${err}`);
    }
  }

  if (lines.length === 0) {
    return result.errors.map((e) => `- ${e}`).join("\n");
  }

  return lines.join("\n");
}

/**
 * Runs the compiler-in-the-loop self-repair loop on a proposed change.
 */
export async function runSelfRepairLoop(
  workspaceRoot: string,
  initialProposal: AIChangeProposal,
  contextFiles: { path: string; content: string }[],
  options: SelfRepairOptions = {}
): Promise<SelfRepairResult> {
  const maxAttempts = options.maxAttempts ?? 2;
  const provider = options.provider || getActiveProvider();
  const client = options.repairClient || getProviderClient(provider);
  const model = options.model || initialProposal.model;

  // 1. Initial Candidate Staging & Verification
  let currentProposal: AIChangeProposal = { ...initialProposal };
  let stageResult = verifyCandidatePatchInSandbox(workspaceRoot, currentProposal.modifications);

  // If candidate is already verified on first attempt
  if (stageResult.passed) {
    currentProposal.verificationStatus = "verified";
    currentProposal.verifiedInSandbox = true;
    currentProposal.repairAttemptsCount = 0;

    return {
      status: "verified",
      proposal: currentProposal,
      initialProposal,
      repairAttempts: [],
      attemptsCount: 0,
      finalDiagnostics: stageResult.diagnostics,
      finalErrors: [],
      verifiedInSandbox: true,
      message: "Candidate patch verified cleanly in isolated sandbox without repair attempts.",
    };
  }

  // 2. Assess repairability
  const repairCheck = isRepairableError(stageResult);
  if (!repairCheck.repairable) {
    currentProposal.verificationStatus = "verification_failed";
    currentProposal.verifiedInSandbox = false;

    return {
      status: "verification_failed",
      proposal: currentProposal,
      initialProposal,
      repairAttempts: [],
      attemptsCount: 0,
      finalDiagnostics: stageResult.diagnostics,
      finalErrors: stageResult.errors,
      verifiedInSandbox: false,
      message: repairCheck.reason || "Verification failed with non-repairable security violations.",
    };
  }

  const repairAttempts: RepairAttempt[] = [];

  // 3. Compiler-in-the-Loop Repair Loop (Max 2 attempts)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const diagnosticFeedback = formatDiagnosticFeedback(stageResult);

    const repairSystemPrompt = `You are Rewind AI Code Repair Engine.
Your previous proposed code modification failed deterministic verification.

STRICT INSTRUCTIONS:
1. Fix all reported compiler, syntax, and invariant errors.
2. Return a SINGLE JSON object matching the standard proposal schema with "summary", "reasoning", and "modifications".
3. "replacementContent" must contain the complete, syntactically and semantically valid file content.
4. Do not include markdown fences or explanatory text.
5. Never introduce dynamic eval, shell command execution, prototype mutation, or credentials.`;

    const repairUserPrompt = `USER TASK:
${initialProposal.userPrompt}

PREVIOUS PROPOSAL SUMMARY:
${currentProposal.summary}

VERIFICATION FAILURES DETECTED:
${diagnosticFeedback}

CURRENT FAILING FILE MODIFICATIONS:
${currentProposal.modifications
  .map((m) => `--- File: ${m.path} (${m.operation}) ---\n${m.replacementContent}\n--- End ---`)
  .join("\n\n")}

Return the corrected JSON proposal resolving all diagnostic failures above.`;

    let repairRawContent: string;

    try {
      const completion = await client.generateCompletion({
        model,
        messages: [
          { role: "system", content: repairSystemPrompt },
          { role: "user", content: repairUserPrompt },
        ],
        temperature: 0.1,
        maxTokens: 4096,
        responseFormat: { type: "json_object" },
      });

      repairRawContent = completion.rawContent;
    } catch (apiErr: unknown) {
      // Provider failure or timeout: DO NOT retry repeatedly, abort gracefully
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      currentProposal.verificationStatus = "verification_incomplete";
      currentProposal.verifiedInSandbox = false;

      return {
        status: "verification_incomplete",
        proposal: currentProposal,
        initialProposal,
        repairAttempts,
        attemptsCount: attempt,
        finalDiagnostics: stageResult.diagnostics,
        finalErrors: [`Provider error during repair attempt ${attempt}: ${errMsg}`],
        verifiedInSandbox: false,
        message: `Self-repair incomplete due to provider failure on attempt ${attempt}: ${errMsg}`,
      };
    }

    // Parse revised proposal
    let revisedProposal: AIChangeProposal;
    try {
      revisedProposal = parseAndValidateProposal(repairRawContent, initialProposal.userPrompt, model);
      revisedProposal.id = `${initialProposal.id}_repair_${attempt}`;
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      repairAttempts.push({
        attemptNumber: attempt,
        diagnosticsFedBack: [diagnosticFeedback],
        candidateModifications: currentProposal.modifications,
        verificationPassed: false,
        errors: [`Model returned unparseable proposal on repair attempt ${attempt}: ${msg}`],
      });
      continue;
    }

    // Re-stage and re-verify revised candidate from scratch
    const revisedStageResult = verifyCandidatePatchInSandbox(
      workspaceRoot,
      revisedProposal.modifications
    );

    repairAttempts.push({
      attemptNumber: attempt,
      diagnosticsFedBack: [diagnosticFeedback],
      candidateModifications: revisedProposal.modifications,
      verificationPassed: revisedStageResult.passed,
      errors: revisedStageResult.errors,
    });

    if (revisedStageResult.passed) {
      revisedProposal.verificationStatus = "verified";
      revisedProposal.verifiedInSandbox = true;
      revisedProposal.repairAttemptsCount = attempt;

      return {
        status: "verified",
        proposal: revisedProposal,
        initialProposal,
        repairAttempts,
        attemptsCount: attempt,
        finalDiagnostics: revisedStageResult.diagnostics,
        finalErrors: [],
        verifiedInSandbox: true,
        message: `Candidate successfully repaired and verified after ${attempt} attempt(s).`,
      };
    }

    // If revised candidate triggered a security violation, stop immediately!
    if (revisedStageResult.securityScan.violations.length > 0) {
      revisedProposal.verificationStatus = "verification_failed";
      revisedProposal.verifiedInSandbox = false;

      return {
        status: "verification_failed",
        proposal: revisedProposal,
        initialProposal,
        repairAttempts,
        attemptsCount: attempt,
        finalDiagnostics: revisedStageResult.diagnostics,
        finalErrors: revisedStageResult.errors,
        verifiedInSandbox: false,
        message: "Revised candidate introduced a security violation. Repair aborted.",
      };
    }

    currentProposal = revisedProposal;
    stageResult = revisedStageResult;
  }

  // 4. Maximum repair attempts exhausted without reaching clean verification
  currentProposal.verificationStatus = "repair_exhausted";
  currentProposal.verifiedInSandbox = false;
  currentProposal.repairAttemptsCount = maxAttempts;

  return {
    status: "repair_exhausted",
    proposal: currentProposal,
    initialProposal,
    repairAttempts,
    attemptsCount: maxAttempts,
    finalDiagnostics: stageResult.diagnostics,
    finalErrors: stageResult.errors,
    verifiedInSandbox: false,
    message: `Self-repair exhausted after ${maxAttempts} attempts. The candidate failed verification and cannot be safely applied.`,
  };
}

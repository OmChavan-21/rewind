/**
 * Trusted Execution Engine for AI Change Proposals
 * Enforces security boundaries, conflict detection, automatic pre-snapshots,
 * and post-apply deterministic validation.
 */

import fs from "node:fs";
import type {
  AIChangeProposal,
  ApplyProposalResult,
  AppliedFileResult,
} from "../types/ai";
import {
  resolveAndValidatePath,
  isPermittedFile,
  validateFileSize,
  SecurityError,
} from "../security/boundaries";
import {
  calculateSha256,
  atomicWriteFileSync,
} from "../engine/storage";
import {
  createSnapshot,
  recordAction,
  validateWorkspaceDeterministically,
  restoreSnapshot,
} from "../engine/recoveryEngine";
import { generateUnifiedDiff } from "../engine/diff";
import { scanContentSecurity } from "../security/contentScanner";
import {
  verifyCandidatePatchInSandbox,
  type CandidateVerificationResult,
  type StagingOptions,
} from "../engine/patchSandbox";

export class ConflictError extends Error {
  constructor(message: string) {
    super(`[Stale File Conflict] ${message}`);
    this.name = "ConflictError";
  }
}

/**
 * Pre-verifies a proposal in an isolated staging sandbox without touching live workspace files.
 */
export function stageAndVerifyProposal(
  workspaceRoot: string,
  proposal: AIChangeProposal,
  options?: StagingOptions
): CandidateVerificationResult {
  return verifyCandidatePatchInSandbox(workspaceRoot, proposal.modifications, options);
}

/**
 * Applies a user-approved AI change proposal with comprehensive safety checks.
 */
export async function applyApprovedAIProposal(
  workspaceRoot: string,
  storeRoot: string,
  proposal: AIChangeProposal,
  options?: { enforcePreVerification?: boolean; projectId?: string }
): Promise<ApplyProposalResult> {
  if (proposal.status === "rejected") {
    throw new Error(`Cannot apply rejected proposal ${proposal.id}`);
  }

  // Refuse application if candidate verification failed or was incomplete
  if (
    proposal.verificationStatus === "verification_failed" ||
    proposal.verificationStatus === "repair_exhausted" ||
    proposal.verificationStatus === "verification_incomplete"
  ) {
    throw new Error(
      `[Verification Blocker] Cannot apply proposal '${proposal.id}': candidate verification status is '${proposal.verificationStatus}'. Failed or unverified candidates cannot modify the live workspace.`
    );
  }

  // Optional candidate pre-verification in isolated sandbox
  if (options?.enforcePreVerification) {
    const stagedResult = stageAndVerifyProposal(workspaceRoot, proposal);
    if (!stagedResult.passed) {
      throw new Error(
        `[Candidate Staging Verification Failed] Proposal rejected before modifying live workspace: ${stagedResult.errors.join("; ")}`
      );
    }
  }

  // 1. Boundary & Safety Verification for each modification
  for (const mod of proposal.modifications) {
    if (!isPermittedFile(mod.path)) {
      throw new SecurityError(`Path '${mod.path}' violates permitted file security policy.`);
    }

    const resolved = resolveAndValidatePath(workspaceRoot, mod.path, {
      allowNonExistent: mod.operation === "create",
    });

    if (mod.operation !== "delete") {
      validateFileSize(Buffer.byteLength(mod.replacementContent, "utf-8"));

      // Security Content Scan: block dangerous sinks and leaked credentials
      const secScan = scanContentSecurity(mod.path, mod.replacementContent);
      if (secScan.violations.length > 0) {
        throw new SecurityError(
          `Security violation in '${mod.path}': ${secScan.violations.map((v) => v.message).join("; ")}`
        );
      }
    }

    // 2. Conflict detection: Check current file hash against expected hash
    if (mod.expectedCurrentHash && fs.existsSync(resolved)) {
      const currentContent = fs.readFileSync(resolved, "utf-8");
      const currentHash = calculateSha256(currentContent);
      if (currentHash !== mod.expectedCurrentHash) {
        throw new ConflictError(
          `File '${mod.path}' has changed since proposal was generated (expected ${mod.expectedCurrentHash.slice(0, 10)}..., found ${currentHash.slice(0, 10)}...). Refusing write.`
        );
      }
    }
  }

  // 3. AUTOMATIC RECOVERY SNAPSHOT: Capture pre-proposal baseline state
  const snapshotName = `Pre-AI: ${proposal.summary.slice(0, 35)}`;
  const snapshotDesc = `Safety snapshot captured before applying AI Proposal ${proposal.id} (${proposal.model})`;
  const targetProjectId = options?.projectId || (proposal as { projectId?: string }).projectId || "demo-workspace";
  const preSnapshot = createSnapshot(workspaceRoot, storeRoot, snapshotName, snapshotDesc, {
    projectId: targetProjectId,
    proposalId: proposal.id,
  });

  const appliedChanges: AppliedFileResult[] = [];

  // 4. Apply changes atomically with blast radius rollback on partial failure
  try {
  for (const mod of proposal.modifications) {
    const resolved = resolveAndValidatePath(workspaceRoot, mod.path, {
      allowNonExistent: mod.operation === "create",
    });

    let oldContent = "";
    let oldHash: string | undefined;

    if (fs.existsSync(resolved)) {
      oldContent = fs.readFileSync(resolved, "utf-8");
      oldHash = calculateSha256(oldContent);
    }

    if (mod.operation === "delete") {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
      appliedChanges.push({
        path: mod.path,
        operation: "delete",
        oldHash,
        diff: generateUnifiedDiff(mod.path, oldContent, ""),
      });
    } else {
      atomicWriteFileSync(resolved, mod.replacementContent);
      const newHash = calculateSha256(mod.replacementContent);
      appliedChanges.push({
        path: mod.path,
        operation: mod.operation,
        oldHash,
        newHash,
        diff: generateUnifiedDiff(mod.path, oldContent, mod.replacementContent),
      });
    }

    recordAction(storeRoot, {
      actionType: "file_modify",
      summary: `AI applied: ${mod.operation} on ${mod.path} (${proposal.id})`,
      status: "success",
      targetPath: mod.path,
      snapshotIdBefore: preSnapshot.id,
      details: {
        proposalId: proposal.id,
        model: proposal.model,
        operation: mod.operation,
      },
    });
  }

  } catch (applyErr) {
    try {
      restoreSnapshot(workspaceRoot, storeRoot, preSnapshot.id, { force: true });
    } catch (rollbackErr) {
      console.error("[Rewind Blast Radius] Emergency rollback failed:", rollbackErr);
    }
    throw applyErr;
  }

  // 5. Post-apply deterministic validation
  const validationResult = validateWorkspaceDeterministically(workspaceRoot);

  recordAction(storeRoot, {
    actionType: "validate",
    summary: `Post-AI validation: ${validationResult.passed ? "PASSED" : "FAILED"} (${proposal.id})`,
    status: validationResult.passed ? "success" : "failure",
    details: {
      proposalId: proposal.id,
      checks: validationResult.checks,
      executionTimeMs: validationResult.executionTimeMs,
    },
    error: validationResult.passed ? undefined : validationResult.summary,
  });

  const isSuccess = validationResult.passed;
  const message = isSuccess
    ? `Successfully applied AI proposal '${proposal.summary}' and verified all project invariants.`
    : `AI proposal applied, but post-apply validation detected invariant errors: ${validationResult.summary}`;

  return {
    success: isSuccess,
    proposalId: proposal.id,
    snapshotBeforeId: preSnapshot.id,
    appliedChanges,
    validationResult,
    message,
  };
}

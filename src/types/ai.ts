/**
 * Rewind - AI Assistant & Nebius Integration Types
 * NVIDIA × Nebius Global AI Hackathon (Phase 2)
 */

import type { ValidationResult, RecoveryResult } from "./recovery";
import type { AIProposalRoutingMeta } from "./router";
import type { CodeDiagnostic } from "./diagnostics";

export type AIProvider = "nvidia" | "nebius";

export type AIConnectionState = "unconfigured" | "configured" | "connected" | "failed";

export type AIErrorCategory =
  | "authentication_failure"
  | "invalid_model"
  | "rate_limit"
  | "invalid_payload"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "provider_error";

export interface AIStatus {
  state: AIConnectionState;
  model: string;
  baseUrl: string;
  message?: string;
  availableModels?: string[];
  provider?: AIProvider;
  endpointReachable?: boolean;
  credentialsAccepted?: boolean;
  modelListed?: boolean;
  generationVerified?: boolean;
}

export type ProposedFileOperation = "modify" | "create" | "delete";

export interface ProposedFileModification {
  path: string; // Relative workspace path, e.g. "agent-workflow.json"
  operation: ProposedFileOperation;
  expectedCurrentHash?: string; // Optional baseline hash for conflict detection
  replacementContent: string; // Proposed file content
  explanation?: string;
}

export type VerificationStatus =
  | "verified"
  | "verification_failed"
  | "repair_exhausted"
  | "verification_incomplete";

export interface RepairAttempt {
  attemptNumber: number;
  diagnosticsFedBack: string[];
  candidateModifications: ProposedFileModification[];
  verificationPassed: boolean;
  errors: string[];
}

export interface SelfRepairResult {
  status: VerificationStatus;
  proposal: AIChangeProposal;
  initialProposal: AIChangeProposal;
  repairAttempts: RepairAttempt[];
  attemptsCount: number;
  finalDiagnostics: CodeDiagnostic[];
  finalErrors: string[];
  verifiedInSandbox: boolean;
  message: string;
}

export interface AIChangeProposal {
  id: string;
  model: string;
  createdAt: string;
  userPrompt: string;
  summary: string;
  reasoning: string;
  modifications: ProposedFileModification[];
  potentialRisks: string;
  expectedValidationResult: "pass" | "fail" | "warn";
  status: "pending_approval" | "approved" | "applied" | "rejected";
  /** Optional Auto Router decision and dual-accounting metrics */
  routingMeta?: AIProposalRoutingMeta;
  /** Staged candidate verification outcome */
  verificationStatus?: VerificationStatus;
  verifiedInSandbox?: boolean;
  repairAttemptsCount?: number;
}

export interface AppliedFileResult {
  path: string;
  operation: ProposedFileOperation;
  oldHash?: string;
  newHash?: string;
  diff: string;
}

export interface ApplyProposalResult {
  success: boolean;
  proposalId: string;
  snapshotBeforeId: string;
  appliedChanges: AppliedFileResult[];
  validationResult: ValidationResult;
  recoveryResult?: RecoveryResult;
  message: string;
}

export * from "./router";

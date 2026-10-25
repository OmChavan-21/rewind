/**
 * Rewind - AI Assistant & Nebius Integration Types
 * NVIDIA × Nebius Global AI Hackathon (Phase 2)
 */

import type { ValidationResult, RecoveryResult } from "./recovery";

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
  provider?: "nvidia" | "nebius";
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

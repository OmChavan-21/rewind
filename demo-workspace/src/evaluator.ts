/**
 * Agent Evaluator & Safety Policy Engine
 * Deterministic rules for workspace validation
 */

export interface EvaluationState {
  stepCount: number;
  safetyScore: number;
  errorsDetected: string[];
}

export function evaluateSafetyPolicy(state: EvaluationState): boolean {
  if (!state) return false;
  if (state.safetyScore < 0.8) return false;
  if (state.errorsDetected.length > 0) return false;
  return true;
}

export function validateStepSequence(steps: string[]): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  // Steps must execute in approved order
  const approvedStart = "01_analyze";
  return steps[0] === approvedStart;
}

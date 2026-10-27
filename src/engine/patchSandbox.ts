/**
 * Isolated Candidate-Patch Staging Sandbox
 * Verifies proposed code modifications and unified diffs in an isolated temporary staging
 * environment before any changes touch the live workspace.
 *
 * Guarantees that:
 * 1. Unverified or broken patches are NEVER written to the live workspace.
 * 2. Compilers, linters, security scanners, and invariants evaluate against realistic
 *    staged files.
 * 3. Staging directories are guaranteed to be cleaned up in finally blocks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProposedFileModification } from "../types/ai";
import type { ValidationResult } from "../types/recovery";
import type { CodeDiagnostic } from "../types/diagnostics";
import { isPermittedFile, resolveAndValidatePath } from "../security/boundaries";
import { listPermittedWorkspaceFiles, validateWorkspaceDeterministically } from "./recoveryEngine";
import { scanContentSecurity, type SecurityIssue } from "../security/contentScanner";
import { diagnoseTypeScriptWorkspaceSemantic } from "./typeScriptCompiler";
import { validatePythonSyntaxNative } from "./pythonValidator";
import { parseUnifiedDiff, applyPatchToString } from "./patchApplier";

export interface CandidateVerificationResult {
  passed: boolean;
  errors: string[];
  diagnostics: CodeDiagnostic[];
  securityScan: {
    passed: boolean;
    violations: SecurityIssue[];
    warnings: SecurityIssue[];
  };
  validationResult?: ValidationResult;
  modifiedFiles: string[];
}

export interface StagingOptions {
  runTypeScriptDiagnostics?: boolean;
  runPythonValidation?: boolean;
  runInvariants?: boolean;
  runSecurityScan?: boolean;
}

/**
 * Stages and verifies candidate modifications in an isolated temporary environment.
 * The live workspaceRoot is NEVER written to during verification.
 */
export function verifyCandidatePatchInSandbox(
  workspaceRoot: string,
  modifications: ProposedFileModification[] | string,
  options: StagingOptions = {}
): CandidateVerificationResult {
  const runTs = options.runTypeScriptDiagnostics ?? true;
  const runPy = options.runPythonValidation ?? true;
  const runInv = options.runInvariants ?? true;
  const runSec = options.runSecurityScan ?? true;

  const errors: string[] = [];
  const allDiagnostics: CodeDiagnostic[] = [];
  const allViolations: SecurityIssue[] = [];
  const allWarnings: SecurityIssue[] = [];
  const modifiedFiles: string[] = [];

  // Create isolated staging directory in temp
  const stageDir = path.join(os.tmpdir(), `rewind-stage-${randomUUID()}`);
  fs.mkdirSync(stageDir, { recursive: true });

  try {
    // 1. Copy permitted files from workspaceRoot into stageDir
    if (fs.existsSync(workspaceRoot)) {
      const workspaceFiles = listPermittedWorkspaceFiles(workspaceRoot);
      for (const f of workspaceFiles) {
        const srcPath = path.join(workspaceRoot, f.path);
        const dstPath = path.join(stageDir, f.path);
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    }

    // 2. Parse candidate modifications
    let normalizedMods: ProposedFileModification[] = [];

    if (typeof modifications === "string") {
      // It's a unified diff string!
      try {
        const patches = parseUnifiedDiff(modifications);
        for (const patch of patches) {
          const targetStagedPath = path.join(stageDir, patch.targetPath);
          let currentContent = "";
          if (fs.existsSync(targetStagedPath)) {
            currentContent = fs.readFileSync(targetStagedPath, "utf-8");
          }
          const patchedContent = applyPatchToString(currentContent, patch);
          normalizedMods.push({
            path: patch.targetPath,
            operation: fs.existsSync(targetStagedPath) ? "modify" : "create",
            replacementContent: patchedContent,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Unified diff parsing/application failed: ${msg}`);
        return {
          passed: false,
          errors,
          diagnostics: [],
          securityScan: { passed: false, violations: [], warnings: [] },
          modifiedFiles: [],
        };
      }
    } else {
      normalizedMods = modifications;
    }

    // 3. Apply modifications into stageDir ONLY
    for (const mod of normalizedMods) {
      if (!isPermittedFile(mod.path)) {
        errors.push(`File path '${mod.path}' violates permitted file security policy.`);
        continue;
      }

      let stagedFilePath: string;
      try {
        stagedFilePath = resolveAndValidatePath(stageDir, mod.path, {
          allowNonExistent: mod.operation === "create",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Invalid staged path '${mod.path}': ${msg}`);
        continue;
      }

      modifiedFiles.push(mod.path);

      if (mod.operation === "delete") {
        if (fs.existsSync(stagedFilePath)) {
          fs.unlinkSync(stagedFilePath);
        }
      } else {
        fs.mkdirSync(path.dirname(stagedFilePath), { recursive: true });
        fs.writeFileSync(stagedFilePath, mod.replacementContent, "utf-8");
      }
    }

    if (errors.length > 0) {
      return {
        passed: false,
        errors,
        diagnostics: allDiagnostics,
        securityScan: { passed: false, violations: [], warnings: [] },
        modifiedFiles,
      };
    }

    // 4. Security Content Scanning
    if (runSec) {
      for (const mod of normalizedMods) {
        if (mod.operation === "delete") continue;
        const scan = scanContentSecurity(mod.path, mod.replacementContent);
        if (scan.violations.length > 0) {
          allViolations.push(...scan.violations);
          for (const v of scan.violations) {
            errors.push(`[Security Violation in ${mod.path}] ${v.message}`);
          }
        }
        allWarnings.push(...scan.warnings);
        allDiagnostics.push(...scan.diagnostics);
      }
    }

    // 5. TypeScript Semantic Diagnostics
    if (runTs) {
      const tsFilesToDiagnose: { path: string; content: string }[] = [];
      for (const mod of normalizedMods) {
        if (mod.operation !== "delete" && /\.(ts|tsx)$/i.test(mod.path)) {
          tsFilesToDiagnose.push({ path: mod.path, content: mod.replacementContent });
        }
      }

      if (tsFilesToDiagnose.length > 0) {
        const tsDiags = diagnoseTypeScriptWorkspaceSemantic(tsFilesToDiagnose);
        for (const d of tsDiags) {
          allDiagnostics.push(d);
          if (d.severity === "error") {
            errors.push(`[TypeScript Error in ${d.filePath}:${d.line}] ${d.message}`);
          }
        }
      }
    }

    // 6. Python Runtime Syntax Validation
    if (runPy) {
      for (const mod of normalizedMods) {
        if (mod.operation !== "delete" && /\.py$/i.test(mod.path)) {
          const pyVal = validatePythonSyntaxNative(mod.path, mod.replacementContent);
          for (const d of pyVal.diagnostics) {
            allDiagnostics.push(d);
            if (d.severity === "error") {
              errors.push(`[Python Syntax Error in ${d.filePath}:${d.line}] ${d.message}`);
            }
          }
        }
      }
    }

    // 7. Workspace Invariant Validation
    let invariantResult: ValidationResult | undefined;
    if (runInv) {
      invariantResult = validateWorkspaceDeterministically(stageDir);
      if (!invariantResult.passed) {
        errors.push(`[Workspace Invariant Failure] ${invariantResult.summary}`);
      }
    }

    const passed = errors.length === 0 && allViolations.length === 0;

    return {
      passed,
      errors,
      diagnostics: allDiagnostics,
      securityScan: {
        passed: allViolations.length === 0,
        violations: allViolations,
        warnings: allWarnings,
      },
      validationResult: invariantResult,
      modifiedFiles,
    };
  } finally {
    // 8. Always clean up the sandbox directory
    try {
      if (fs.existsSync(stageDir)) {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    } catch {
      // ignore sandbox cleanup error
    }
  }
}

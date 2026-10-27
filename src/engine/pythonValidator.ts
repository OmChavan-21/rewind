/**
 * Native Python Syntax Validation Engine
 * Executes bounded, non-executing AST syntax checks using the local Python runtime.
 * Safely parses Python code without executing module-level statements.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CodeDiagnostic } from "../types/diagnostics";

export interface PythonValidationResult {
  valid: boolean;
  diagnostics: CodeDiagnostic[];
  runtimeAvailable: boolean;
  timedOut: boolean;
}

const PYTHON_VALIDATOR_SCRIPT = `
import ast, sys, json
target = sys.argv[1]
try:
    with open(target, 'rb') as f:
        ast.parse(f.read(), filename=target)
    print(json.dumps({"valid": True}))
except SyntaxError as e:
    print(json.dumps({
        "valid": False,
        "line": e.lineno if e.lineno is not None else 1,
        "column": e.offset if e.offset is not None else 1,
        "endLine": getattr(e, "end_lineno", None),
        "endColumn": getattr(e, "end_offset", None),
        "message": e.msg or "Syntax error",
        "text": e.text.strip() if e.text else ""
    }))
except Exception as e:
    print(json.dumps({"valid": False, "line": 1, "column": 1, "message": str(e), "text": ""}))
`.trim();

/**
 * Validates Python source code syntax using the local Python runtime AST parser.
 * Bounded by a strict execution timeout (default 3000ms).
 */
export function validatePythonSyntaxNative(
  relPath: string,
  content: string,
  timeoutMs: number = 3000
): PythonValidationResult {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `rewind_py_val_${randomUUID()}.py`);

  try {
    fs.writeFileSync(tempFile, content, "utf-8");

    const result = spawnSync("python", ["-c", PYTHON_VALIDATOR_SCRIPT, tempFile], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      windowsHide: true,
    });

    if (result.error) {
      const errCode = (result.error as NodeJS.ErrnoException).code;
      if (errCode === "ETIMEDOUT") {
        return {
          valid: false,
          runtimeAvailable: true,
          timedOut: true,
          diagnostics: [
            {
              id: `py_timeout_${relPath}`,
              filePath: relPath,
              line: 1,
              column: 1,
              severity: "error",
              category: "syntax",
              message: `Python syntax check timed out after ${timeoutMs}ms.`,
              ruleId: "python_validation_timeout",
              source: "python_compiler",
              suggestion: "Simplify the file or inspect for deeply nested recursive structures.",
            },
          ],
        };
      }

      // If python is not on PATH or cannot be spawned
      if (errCode === "ENOENT") {
        return {
          valid: true, // fallback to static analyzer
          runtimeAvailable: false,
          timedOut: false,
          diagnostics: [],
        };
      }
    }

    const stdout = (result.stdout || "").trim();
    if (!stdout) {
      // Empty stdout or exit error
      if (result.status !== 0 && result.stderr) {
        return {
          valid: false,
          runtimeAvailable: true,
          timedOut: false,
          diagnostics: [
            {
              id: `py_err_${relPath}_1`,
              filePath: relPath,
              line: 1,
              column: 1,
              severity: "error",
              category: "syntax",
              message: `Python syntax validation failure: ${result.stderr.split("\n")[0]}`,
              ruleId: "python_syntax_error",
              source: "python_compiler",
            },
          ],
        };
      }
      return { valid: true, diagnostics: [], runtimeAvailable: true, timedOut: false };
    }

    try {
      const parsed = JSON.parse(stdout);
      if (parsed.valid) {
        return { valid: true, diagnostics: [], runtimeAvailable: true, timedOut: false };
      }

      const line = Number(parsed.line) || 1;
      const column = Number(parsed.column) || 1;
      const message = parsed.message || "Invalid syntax";
      const snippet = parsed.text || content.split("\n")[line - 1]?.trim();

      const diag: CodeDiagnostic = {
        id: `py_native_${relPath}_${line}_${column}`,
        filePath: relPath,
        line,
        column,
        endLine: parsed.endLine || undefined,
        endColumn: parsed.endColumn || undefined,
        severity: "error",
        category: "syntax",
        message: `Python SyntaxError: ${message}`,
        ruleId: "python_syntax_error",
        source: "python_compiler",
        suggestion: `Check Python syntax around line ${line}, column ${column}.`,
        codeSnippet: snippet,
      };

      return {
        valid: false,
        diagnostics: [diag],
        runtimeAvailable: true,
        timedOut: false,
      };
    } catch {
      return { valid: true, diagnostics: [], runtimeAvailable: true, timedOut: false };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      runtimeAvailable: false,
      timedOut: false,
      diagnostics: [
        {
          id: `py_error_${relPath}`,
          filePath: relPath,
          line: 1,
          column: 1,
          severity: "error",
          category: "syntax",
          message: `Failed to invoke Python syntax validator: ${msg}`,
          ruleId: "python_validator_exception",
          source: "python_compiler",
        },
      ],
    };
  } finally {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // ignore temp file cleanup errors
    }
  }
}

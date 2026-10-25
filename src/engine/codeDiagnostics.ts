import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CodeDiagnostic,
  WorkspaceDiagnosticsResult,
} from "../types/diagnostics";
import { listPermittedWorkspaceFiles, validateWorkspaceDeterministically } from "./recoveryEngine";

/**
 * Extracts line and column number from an offset in text.
 */
function getLineAndColumn(
  content: string,
  offset: number
): { line: number; column: number } {
  const lines = content.slice(0, offset).split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

/**
 * Diagnoses TypeScript / JavaScript source files using TypeScript's AST parser.
 * This runs purely in static analysis mode without executing code.
 */
export function diagnoseTypeScriptFile(
  relPath: string,
  content: string
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];

  const sourceFile = ts.createSourceFile(
    relPath,
    content,
    ts.ScriptTarget.Latest,
    true, // setParentNodes
    relPath.endsWith(".tsx") || relPath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  );

  // Collect syntactic parse diagnostics
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics || [];

  for (const diag of parseDiagnostics) {
    let line = 1;
    let column = 1;

    if (diag.start !== undefined) {
      const pos = sourceFile.getLineAndCharacterOfPosition(diag.start);
      line = pos.line + 1;
      column = pos.character + 1;
    }

    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    const codeSnippet = content.split("\n")[line - 1]?.trim();

    diagnostics.push({
      id: `ts_${relPath}_${line}_${column}_${diag.code}`,
      filePath: relPath,
      line,
      column,
      severity: diag.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      category: "syntax",
      message: `Syntax Error (TS${diag.code}): ${message}`,
      ruleId: `TS${diag.code}`,
      source: "typescript",
      suggestion: "Inspect the file around line " + line + " to fix syntax syntax or missing delimiters.",
      codeSnippet,
    });
  }

  return diagnostics;
}

/**
 * Diagnoses JSON files with precise line and column error reporting.
 */
export function diagnoseJsonFile(
  relPath: string,
  content: string
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];

  try {
    JSON.parse(content);
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    let line = 1;
    let column = 1;

    // Extract line/column from common V8 error messages, e.g. "at position 42 (line 3 column 5)"
    const posMatch = rawMessage.match(/line (\d+) column (\d+)/i);
    const bytePosMatch = rawMessage.match(/position (\d+)/i);

    if (posMatch) {
      line = parseInt(posMatch[1], 10);
      column = parseInt(posMatch[2], 10);
    } else if (bytePosMatch) {
      const bytePos = parseInt(bytePosMatch[1], 10);
      const loc = getLineAndColumn(content, bytePos);
      line = loc.line;
      column = loc.column;
    } else {
      // Node 20+ V8 format: Unexpected token '}', ..."status": \n}" is not valid JSON
      const snippetMatch = rawMessage.match(/\.\.\.([\s\S]+?)" is not valid JSON/);
      if (snippetMatch) {
        const snippet = snippetMatch[1];
        const idx = content.indexOf(snippet);
        if (idx !== -1) {
          const loc = getLineAndColumn(content, idx + Math.max(0, snippet.length - 1));
          line = loc.line;
          column = loc.column;
        }
      }

      if (line === 1) {
        const tokenMatch = rawMessage.match(/Unexpected token '([^']+)'/);
        if (tokenMatch) {
          const token = tokenMatch[1];
          const idx = content.lastIndexOf(token);
          if (idx !== -1) {
            const loc = getLineAndColumn(content, idx);
            line = loc.line;
            column = loc.column;
          }
        }
      }
    }

    const codeSnippet = content.split("\n")[line - 1]?.trim();

    diagnostics.push({
      id: `json_${relPath}_${line}_${column}`,
      filePath: relPath,
      line,
      column,
      severity: "error",
      category: "syntax",
      message: `JSON Syntax Error: ${rawMessage}`,
      ruleId: "json_syntax",
      source: "json_parser",
      suggestion: "Fix trailing commas, unquoted keys, or mismatched brackets.",
      codeSnippet,
    });
  }

  return diagnostics;
}

/**
 * Diagnoses Python source files using pure static analysis.
 * Safely analyzes syntax, bracket pairing, indentation consistency, and quotes without executing code.
 */
export function diagnosePythonFile(
  relPath: string,
  content: string
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  const lines = content.split("\n");

  const stack: { char: string; line: number; col: number }[] = [];
  const matchingPairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  let inTripleDouble = false;
  let inTripleSingle = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    const line = lines[lineIdx];

    const indentMatch = line.match(/^[\t ]+/);
    if (indentMatch) {
      const indent = indentMatch[0];
      if (indent.includes("\t") && indent.includes(" ")) {
        diagnostics.push({
          id: `py_indent_${relPath}_${lineNum}`,
          filePath: relPath,
          line: lineNum,
          column: 1,
          severity: "warning",
          category: "syntax",
          message: "Mixed tabs and spaces in Python indentation.",
          ruleId: "python_indentation",
          source: "python_static_analyzer",
          suggestion: "Use 4 spaces consistently for Python indentation.",
          codeSnippet: line.trim(),
        });
      }
    }

    let i = 0;
    while (i < line.length) {
      if (!inTripleSingle && line.slice(i, i + 3) === '"""') {
        inTripleDouble = !inTripleDouble;
        i += 3;
        continue;
      }
      if (!inTripleDouble && line.slice(i, i + 3) === "'''") {
        inTripleSingle = !inTripleSingle;
        i += 3;
        continue;
      }

      if (inTripleDouble || inTripleSingle) {
        i++;
        continue;
      }

      if (line[i] === "#") {
        break;
      }

      if (line[i] === '"' || line[i] === "'") {
        const quoteChar = line[i];
        let j = i + 1;
        let escaped = false;
        while (j < line.length) {
          if (line[j] === "\\" && !escaped) {
            escaped = true;
          } else if (line[j] === quoteChar && !escaped) {
            break;
          } else {
            escaped = false;
          }
          j++;
        }
        if (j >= line.length) {
          diagnostics.push({
            id: `py_quote_${relPath}_${lineNum}_${i + 1}`,
            filePath: relPath,
            line: lineNum,
            column: i + 1,
            severity: "error",
            category: "syntax",
            message: `Unterminated string literal (missing closing ${quoteChar}).`,
            ruleId: "python_string",
            source: "python_static_analyzer",
            suggestion: `Add closing quote '${quoteChar}' before the end of the line.`,
            codeSnippet: line.trim(),
          });
        }
        i = j + 1;
        continue;
      }

      if (line[i] === "(" || line[i] === "[" || line[i] === "{") {
        stack.push({ char: line[i], line: lineNum, col: i + 1 });
      } else if (line[i] === ")" || line[i] === "]" || line[i] === "}") {
        const expectedOpen = matchingPairs[line[i]];
        if (stack.length === 0 || stack[stack.length - 1].char !== expectedOpen) {
          diagnostics.push({
            id: `py_bracket_${relPath}_${lineNum}_${i + 1}`,
            filePath: relPath,
            line: lineNum,
            column: i + 1,
            severity: "error",
            category: "syntax",
            message: `Mismatched closing bracket '${line[i]}'.`,
            ruleId: "python_brackets",
            source: "python_static_analyzer",
            suggestion:
              stack.length > 0
                ? `Expected closing bracket matching '${stack[stack.length - 1].char}' from line ${stack[stack.length - 1].line}.`
                : `Remove extraneous closing bracket '${line[i]}'.`,
            codeSnippet: line.trim(),
          });
        } else {
          stack.pop();
        }
      }

      i++;
    }

    const trimmed = line.trim();
    if (
      !inTripleDouble &&
      !inTripleSingle &&
      /^(def\s+[a-zA-Z0-9_]+\s*\(.*?\)|class\s+[a-zA-Z0-9_]+(\(.*?\))?|if\s+.+|elif\s+.+|else|for\s+.+\s+in\s+.+|while\s+.+|try|except(\s+.+)?|finally)$/.test(
        trimmed.replace(/#.*$/, "").trim()
      )
    ) {
      const cleanStmt = trimmed.replace(/#.*$/, "").trim();
      if (!cleanStmt.endsWith(":")) {
        diagnostics.push({
          id: `py_colon_${relPath}_${lineNum}`,
          filePath: relPath,
          line: lineNum,
          column: line.length,
          severity: "error",
          category: "syntax",
          message: `SyntaxError: expected ':' at end of '${cleanStmt.split(" ")[0]}' statement header.`,
          ruleId: "python_header_colon",
          source: "python_static_analyzer",
          suggestion: "Add a colon ':' at the end of the statement line.",
          codeSnippet: line.trim(),
        });
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      id: `py_unclosed_${relPath}_${unclosed.line}_${unclosed.col}`,
      filePath: relPath,
      line: unclosed.line,
      column: unclosed.col,
      severity: "error",
      category: "syntax",
      message: `Unclosed bracket '${unclosed.char}'.`,
      ruleId: "python_unclosed_bracket",
      source: "python_static_analyzer",
      suggestion: `Add matching closing bracket for '${unclosed.char}'.`,
      codeSnippet: lines[unclosed.line - 1]?.trim(),
    });
  }

  return diagnostics;
}

/**
 * Runs a comprehensive, non-executing diagnostics pass over all workspace files.
 */
export function runWorkspaceDiagnostics(
  workspaceRoot: string,
  projectId: string = "demo-workspace"
): WorkspaceDiagnosticsResult {
  const allDiagnostics: CodeDiagnostic[] = [];
  const fileSummariesMap = new Map<string, { errors: number; warnings: number }>();

  if (!fs.existsSync(workspaceRoot)) {
    return {
      timestamp: new Date().toISOString(),
      projectId,
      hasErrors: true,
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
      diagnostics: [
        {
          id: "workspace_missing",
          filePath: "",
          line: 1,
          column: 1,
          severity: "error",
          category: "validation",
          message: "Project workspace directory does not exist.",
          source: "rewind_validator",
        },
      ],
      fileSummaries: [],
    };
  }

  const files = listPermittedWorkspaceFiles(workspaceRoot);

  for (const file of files) {
    const fullPath = path.join(workspaceRoot, file.path);
    if (!fs.existsSync(fullPath)) continue;

    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const ext = path.extname(file.path).toLowerCase();
    let fileDiags: CodeDiagnostic[] = [];

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      fileDiags = diagnoseTypeScriptFile(file.path, content);
    } else if (ext === ".json") {
      fileDiags = diagnoseJsonFile(file.path, content);
    } else if (ext === ".py") {
      fileDiags = diagnosePythonFile(file.path, content);
    }

    let errCount = 0;
    let warnCount = 0;
    for (const d of fileDiags) {
      if (d.severity === "error") errCount++;
      if (d.severity === "warning") warnCount++;
    }

    fileSummariesMap.set(file.path, { errors: errCount, warnings: warnCount });
    allDiagnostics.push(...fileDiags);
  }

  // Also include deterministic invariant checks from Rewind's validator
  const validation = validateWorkspaceDeterministically(workspaceRoot);
  for (const check of validation.checks) {
    if (check.status === "fail") {
      allDiagnostics.push({
        id: `val_${check.name.toLowerCase().replace(/\s+/g, "_")}`,
        filePath: check.name.includes("agent-workflow")
          ? "agent-workflow.json"
          : check.name.includes("runtime")
          ? "config/runtime.json"
          : check.name.includes("evaluator")
          ? "src/evaluator.ts"
          : "workspace",
        line: 1,
        column: 1,
        severity: "error",
        category: "validation",
        message: `${check.name}: ${check.message}`,
        suggestion: check.details || "Restore workspace or fix invariant violation.",
        source: "rewind_validator",
      });
    }
  }

  const errorCount = allDiagnostics.filter((d) => d.severity === "error").length;
  const warningCount = allDiagnostics.filter((d) => d.severity === "warning").length;
  const infoCount = allDiagnostics.filter((d) => d.severity === "info").length;

  const fileSummaries = Array.from(fileSummariesMap.entries()).map(
    ([filePath, stats]) => ({
      filePath,
      errorCount: stats.errors,
      warningCount: stats.warnings,
    })
  );

  return {
    timestamp: new Date().toISOString(),
    projectId,
    hasErrors: errorCount > 0,
    errorCount,
    warningCount,
    infoCount,
    diagnostics: allDiagnostics,
    fileSummaries,
  };
}

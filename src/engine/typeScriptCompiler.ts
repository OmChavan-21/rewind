/**
 * TypeScript Semantic Diagnostics Engine
 * Evaluates full TypeScript type-checking semantics (type mismatches, missing properties,
 * unknown symbols, invalid arguments) using the TypeScript Compiler API.
 */

import path from "node:path";
import ts from "typescript";
import type { CodeDiagnostic } from "../types/diagnostics";

export interface TypeScriptDiagnosticOptions {
  strict?: boolean;
  workspaceRoot?: string;
  includeSyntactic?: boolean;
}

/**
 * Generates actionable suggestions based on common TypeScript error codes.
 */
function getSuggestionForTsError(code: number, message: string): string {
  switch (code) {
    case 2322: // Type 'A' is not assignable to type 'B'
      return "Type mismatch: verify that the assigned value matches the declared variable, parameter, or property type.";
    case 2339: // Property 'x' does not exist on type 'Y'
      return "Property does not exist on this type. Verify property spelling or extend the type/interface declaration.";
    case 2345: // Argument of type 'A' is not assignable to parameter of type 'B'
      return "Argument type mismatch. Ensure passed arguments match the function parameter signatures.";
    case 2304: // Cannot find name 'x'
      return "Unresolved symbol. Ensure the variable, function, or type is imported or declared in scope.";
    case 2741: // Property 'x' is missing in type 'A' but required in type 'B'
    case 2739: // Type 'A' is missing the following properties from type 'B'
      return "Required property is missing. Provide all required properties or mark optional ones with '?'.";
    case 7006: // Parameter 'x' implicitly has an 'any' type
      return "Implicit 'any' parameter. Add an explicit type annotation to the parameter.";
    case 2554: // Expected X arguments, but got Y
      return "Incorrect number of arguments. Verify the function signature.";
    case 2551: // Property 'x' does not exist on type 'Y'. Did you mean 'z'?
      return "Possible typo in property name. Check suggested alternative.";
    case 2307: // Cannot find module 'x'
      return "Module resolution failure. Verify the module import path or external dependency installation.";
    default:
      if (message.includes("not assignable")) {
        return "Type incompatibility detected. Review type definitions and conversions.";
      }
      return `Review TypeScript diagnostic TS${code} for compliance.`;
  }
}

/**
 * Normalizes file paths for consistent compiler host lookup across platforms.
 */
function normalizeCompilerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Creates a virtual TypeScript compiler host supporting in-memory file buffers
 * alongside system library files.
 */
function createVirtualCompilerHost(
  fileMap: Map<string, string>,
  options: ts.CompilerOptions
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(options);

  const customHost: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const norm = normalizeCompilerPath(fileName);

      // 1. Direct match
      if (fileMap.has(norm)) {
        return ts.createSourceFile(
          fileName,
          fileMap.get(norm)!,
          languageVersion,
          true,
          norm.endsWith(".tsx") || norm.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
      }

      // 2. Relative or base name suffix match
      for (const [key, content] of fileMap.entries()) {
        if (norm.endsWith("/" + key) || norm === key || key.endsWith("/" + norm) || key === norm) {
          return ts.createSourceFile(
            fileName,
            content,
            languageVersion,
            true,
            norm.endsWith(".tsx") || norm.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
          );
        }
      }

      // Fall back to default system host (e.g. for lib.es2022.full.d.ts)
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    fileExists: (fileName) => {
      const norm = normalizeCompilerPath(fileName);
      if (fileMap.has(norm)) return true;
      for (const key of fileMap.keys()) {
        if (norm.endsWith("/" + key) || norm === key || key.endsWith("/" + norm)) {
          return true;
        }
      }
      return defaultHost.fileExists(fileName);
    },
    readFile: (fileName) => {
      const norm = normalizeCompilerPath(fileName);
      if (fileMap.has(norm)) return fileMap.get(norm);
      for (const [key, content] of fileMap.entries()) {
        if (norm.endsWith("/" + key) || norm === key || key.endsWith("/" + norm)) {
          return content;
        }
      }
      return defaultHost.readFile(fileName);
    },
    resolveModuleNameLiterals: (moduleLiterals, containingFile) => {
      return moduleLiterals.map((literal) => {
        const moduleName = literal.text;

        if (moduleName.startsWith(".")) {
          const containingDir = normalizeCompilerPath(path.dirname(containingFile));
          const candidateBase = normalizeCompilerPath(path.posix.join(containingDir, moduleName));
          const candidates = [
            candidateBase + ".ts",
            candidateBase + ".tsx",
            candidateBase + ".d.ts",
            candidateBase + "/index.ts",
            candidateBase,
          ];

          for (const cand of candidates) {
            for (const key of fileMap.keys()) {
              if (
                cand === key ||
                cand.endsWith("/" + key) ||
                key.endsWith("/" + cand) ||
                normalizeCompilerPath(path.posix.normalize(cand)) === key
              ) {
                return {
                  resolvedModule: {
                    resolvedFileName: key,
                    extension: key.endsWith(".tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
                    isExternalLibraryImport: false,
                  },
                };
              }
            }
          }
        }

        const res = ts.resolveModuleName(
          moduleName,
          containingFile,
          options,
          defaultHost
        );
        return {
          resolvedModule: res.resolvedModule,
        };
      });
    },
    getDefaultLibFileName: (opts) => defaultHost.getDefaultLibFileName(opts),
    getCurrentDirectory: () => defaultHost.getCurrentDirectory(),
    getCanonicalFileName: (fileName) => defaultHost.getCanonicalFileName(fileName),
    useCaseSensitiveFileNames: () => defaultHost.useCaseSensitiveFileNames(),
    getNewLine: () => defaultHost.getNewLine(),
  };

  return customHost;
}

/**
 * Runs semantic (type-level) diagnostics across multiple TypeScript files in an isolated context.
 */
export function diagnoseTypeScriptWorkspaceSemantic(
  files: { path: string; content: string }[],
  options: TypeScriptDiagnosticOptions = {}
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    skipLibCheck: true,
    strict: options.strict ?? true,
    allowJs: true,
    checkJs: false,
    types: [], // isolate from external ambient @types
  };

  const fileMap = new Map<string, string>();
  const rootFileNames: string[] = [];

  for (const f of files) {
    const norm = normalizeCompilerPath(f.path);
    fileMap.set(norm, f.content);
    rootFileNames.push(norm);
  }

  const host = createVirtualCompilerHost(fileMap, compilerOptions);
  let program: ts.Program;

  try {
    program = ts.createProgram(rootFileNames, compilerOptions, host);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      id: "ts_compiler_init_error",
      filePath: files[0]?.path || "workspace",
      line: 1,
      column: 1,
      severity: "error",
      category: "type",
      message: `TypeScript Compiler Initialization Error: ${msg}`,
      source: "typescript",
    });
    return diagnostics;
  }

  // Collect diagnostics for all requested files
  for (const rootFile of rootFileNames) {
    const sourceFile = program.getSourceFile(rootFile);
    if (!sourceFile) continue;

    const tsDiagnostics: ts.Diagnostic[] = [];

    // Syntactic diagnostics if requested
    if (options.includeSyntactic) {
      tsDiagnostics.push(...program.getSyntacticDiagnostics(sourceFile));
    }

    // Semantic diagnostics (type errors, missing members, etc.)
    tsDiagnostics.push(...program.getSemanticDiagnostics(sourceFile));

    for (const diag of tsDiagnostics) {
      let line = 1;
      let column = 1;
      let endLine: number | undefined;
      let endColumn: number | undefined;

      if (diag.file && diag.start !== undefined) {
        const startPos = diag.file.getLineAndCharacterOfPosition(diag.start);
        line = startPos.line + 1;
        column = startPos.character + 1;

        if (diag.length) {
          const endPos = diag.file.getLineAndCharacterOfPosition(diag.start + diag.length);
          endLine = endPos.line + 1;
          endColumn = endPos.character + 1;
        }
      }

      const rawMessage = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      const fileContent = fileMap.get(rootFile) || "";
      const codeSnippet = fileContent.split("\n")[line - 1]?.trim();

      const isError = diag.category === ts.DiagnosticCategory.Error;
      const category = diag.category === ts.DiagnosticCategory.Error && diag.code < 2000
        ? "syntax"
        : "type";

      diagnostics.push({
        id: `ts_${rootFile}_${line}_${column}_${diag.code}`,
        filePath: rootFile,
        line,
        column,
        endLine,
        endColumn,
        severity: isError ? "error" : "warning",
        category,
        message: `TypeScript ${category === "syntax" ? "Syntax" : "Semantic"} Error (TS${diag.code}): ${rawMessage}`,
        ruleId: `TS${diag.code}`,
        source: "typescript",
        suggestion: getSuggestionForTsError(diag.code, rawMessage),
        codeSnippet,
      });
    }
  }

  return diagnostics;
}

/**
 * Runs semantic (type-level) diagnostics on a single TypeScript file.
 */
export function diagnoseTypeScriptSemantic(
  relPath: string,
  content: string,
  options: TypeScriptDiagnosticOptions = {}
): CodeDiagnostic[] {
  return diagnoseTypeScriptWorkspaceSemantic([{ path: relPath, content }], options);
}

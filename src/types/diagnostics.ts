/**
 * Coding file diagnostics and error visibility types.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCategory =
  | "syntax"
  | "type"
  | "lint"
  | "validation"
  | "security"
  | "ai_suggestion";

export interface CodeDiagnostic {
  id: string;
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  ruleId?: string;
  source:
    | "typescript"
    | "json_parser"
    | "python_static_analyzer"
    | "python_compiler"
    | "security_scanner"
    | "rewind_validator"
    | "ai_assistant"
    | "patch_sandbox";
  suggestion?: string;
  codeSnippet?: string;
}

export interface WorkspaceDiagnosticsResult {
  timestamp: string;
  projectId: string;
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  diagnostics: CodeDiagnostic[];
  fileSummaries: {
    filePath: string;
    errorCount: number;
    warningCount: number;
  }[];
}

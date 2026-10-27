/**
 * Security Content Scanner for Code Modifications & Patches
 * Scans file contents for dangerous execution sinks, command injection vulnerabilities,
 * and leaked credentials/tokens.
 *
 * Strictly separates:
 * 1. Confirmed Vulnerabilities (critical / blocking)
 * 2. Security Warnings (advisory / non-blocking)
 */

import type { CodeDiagnostic } from "../types/diagnostics";

export type SecurityIssueSeverity = "critical" | "warning";
export type SecurityIssueType = "vulnerability" | "warning";

export interface SecurityIssue {
  id: string;
  filePath: string;
  line: number;
  column: number;
  severity: SecurityIssueSeverity;
  type: SecurityIssueType;
  ruleId: string;
  message: string;
  snippet?: string;
  suggestion?: string;
}

export interface ContentSecurityScanResult {
  passed: boolean;
  violations: SecurityIssue[]; // Confirmed vulnerabilities
  warnings: SecurityIssue[]; // Advisory warnings
  summary: string;
  diagnostics: CodeDiagnostic[];
}

interface SecurityRule {
  id: string;
  name: string;
  severity: SecurityIssueSeverity;
  type: SecurityIssueType;
  pattern: RegExp;
  message: string;
  suggestion: string;
  checkInComments?: boolean; // Default false (comments stripped)
  fileExtensions?: string[]; // Empty means all
}

const SECURITY_RULES: SecurityRule[] = [
  // -------------------------------------------------------------
  // CONFIRMED VULNERABILITIES (Critical / Sinks / Leaks)
  // -------------------------------------------------------------
  {
    id: "SEC001_DANGEROUS_EVAL",
    name: "Dynamic Code Evaluation",
    severity: "critical",
    type: "vulnerability",
    pattern: /\beval\s*\(/,
    message: "Use of dangerous 'eval()' execution sink detected. This allows arbitrary code execution.",
    suggestion: "Refactor to use safe JSON parsing, structured schema validation, or deterministic functions.",
  },
  {
    id: "SEC002_FUNCTION_CONSTRUCTOR",
    name: "Dynamic Function Constructor",
    severity: "critical",
    type: "vulnerability",
    pattern: /\bnew\s+Function\s*\(|\b(?<!\w)Function\s*\([^)]*?\)\s*\(/,
    message: "Dynamic Function constructor invokes code from arbitrary string inputs.",
    suggestion: "Avoid dynamic code generation. Use predefined, static functions.",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    id: "SEC003_CHILD_PROCESS_EXEC",
    name: "Command Injection Sink (Node.js)",
    severity: "critical",
    type: "vulnerability",
    pattern: /\b(?:child_process\s*\.\s*(?:exec|execSync)|(?<!\w)(?:exec|execSync))\s*\(/,
    message: "Shell command execution sink ('exec' / 'execSync') detected. Vulnerable to command injection.",
    suggestion: "Use parameterized 'execFile' or 'spawn' with explicit argument arrays and shell: false.",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    id: "SEC004_PYTHON_OS_SYSTEM",
    name: "Command Injection Sink (Python os.system)",
    severity: "critical",
    type: "vulnerability",
    pattern: /\bos\s*\.\s*(?:system|popen)\s*\(/,
    message: "Unsafe Python shell command execution sink ('os.system' / 'os.popen') detected.",
    suggestion: "Use 'subprocess.run' with an argument list and shell=False.",
    fileExtensions: [".py"],
  },
  {
    id: "SEC005_PYTHON_SUBPROCESS_SHELL",
    name: "Subprocess with Shell=True",
    severity: "critical",
    type: "vulnerability",
    pattern: /\bsubprocess\s*\.\s*(?:Popen|call|run|check_output|check_call)\s*\([^)]*shell\s*=\s*(?:True|1)/,
    message: "Python subprocess called with shell=True. This exposes the process to shell injection.",
    suggestion: "Set shell=False and pass command and arguments as a sequence of strings.",
    fileExtensions: [".py"],
  },
  {
    id: "SEC006_PROTOTYPE_POLLUTION",
    name: "Prototype Pollution Sink",
    severity: "critical",
    type: "vulnerability",
    pattern: /(?:__proto__|constructor\s*\.\s*prototype)\s*(?:\[|\.|=)/,
    message: "Potential prototype pollution via '__proto__' or 'constructor.prototype' mutation.",
    suggestion: "Use Map or Object.create(null) for unconstrained keys, or freeze object prototypes.",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    id: "SEC007_LEAKED_PRIVATE_KEY",
    name: "Leaked Private Key",
    severity: "critical",
    type: "vulnerability",
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+)?PRIVATE\s+KEY-----/,
    message: "Plaintext private cryptographic key detected in source code.",
    suggestion: "Store private keys in environment variables or a secure secrets manager. Never commit keys.",
    checkInComments: true,
  },
  {
    id: "SEC008_LEAKED_API_KEY",
    name: "Leaked API Key / Secret Token",
    severity: "critical",
    type: "vulnerability",
    pattern: /\b(?:sk-[a-zA-Z0-9_-]{24,}|nvapi-[a-zA-Z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{36,}|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16})\b/,
    message: "Confirmed API key or secret token detected in source content.",
    suggestion: "Remove hardcoded credentials immediately. Pass via environment variables.",
    checkInComments: true,
  },

  // -------------------------------------------------------------
  // SECURITY WARNINGS (Advisory / Non-blocking)
  // -------------------------------------------------------------
  {
    id: "WARN001_INSECURE_HTTP",
    name: "Insecure HTTP Protocol",
    severity: "warning",
    type: "warning",
    // Matches http:// excluding localhost, 127.0.0.1, w3.org, and schemas
    pattern: /http:\/\/(?!(?:localhost|127\.0\.0\.1|www\.w3\.org|schemas\.))[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    message: "Unencrypted HTTP endpoint detected. Communication may be susceptible to interception.",
    suggestion: "Upgrade endpoint to HTTPS for encrypted transit.",
  },
  {
    id: "WARN002_PROCESS_ENV_MUTATION",
    name: "Environment Variable Mutation",
    severity: "warning",
    type: "warning",
    pattern: /\bprocess\s*\.\s*env\s*\.[A-Z0-9_]+\s*=/,
    message: "Dynamic mutation of process.env detected. This may cause unexpected side-effects across threads.",
    suggestion: "Pass configuration as explicit parameters rather than mutating global process state.",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    id: "WARN003_RECURSIVE_DELETE",
    name: "Broad File Deletion",
    severity: "warning",
    type: "warning",
    pattern: /\bfs\s*\.\s*(?:rmSync|rmdirSync|rm)\s*\([^)]*recursive\s*:\s*true|\bshutil\s*\.\s*rmtree\s*\(/,
    message: "Broad recursive directory deletion detected. Verify path safety boundaries.",
    suggestion: "Ensure target path is strictly validated and contained within project workspace.",
  },
];

/**
 * Strips comments from code to prevent false positives when rules should only match active code.
 */
function stripComments(content: string, ext: string): string {
  const isPython = ext === ".py";

  if (isPython) {
    // Strip python single-line comments
    return content
      .split("\n")
      .map((line) => {
        // preserve strings, remove # comment
        const commentIdx = line.indexOf("#");
        if (commentIdx !== -1) {
          // If not inside quotes
          const before = line.slice(0, commentIdx);
          const singleQuotes = (before.match(/'/g) || []).length;
          const doubleQuotes = (before.match(/"/g) || []).length;
          if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
            return before;
          }
        }
        return line;
      })
      .join("\n");
  }

  // JS/TS: remove block comments and single-line comments
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) || []).length))
    .split("\n")
    .map((line) => {
      const slashIdx = line.indexOf("//");
      if (slashIdx !== -1) {
        const before = line.slice(0, slashIdx);
        const singleQuotes = (before.match(/'/g) || []).length;
        const doubleQuotes = (before.match(/"/g) || []).length;
        if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
          return before;
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Scans a file's content for security issues, separating confirmed vulnerabilities from warnings.
 */
export function scanContentSecurity(
  filePath: string,
  content: string
): ContentSecurityScanResult {
  const violations: SecurityIssue[] = [];
  const warnings: SecurityIssue[] = [];
  const diagnostics: CodeDiagnostic[] = [];

  const ext = (filePath.includes(".") ? "." + filePath.split(".").pop() : "").toLowerCase();
  const rawLines = content.split(/\r?\n/);
  const strippedContent = stripComments(content, ext);
  const strippedLines = strippedContent.split(/\r?\n/);

  for (const rule of SECURITY_RULES) {
    if (rule.fileExtensions && rule.fileExtensions.length > 0 && !rule.fileExtensions.includes(ext)) {
      continue;
    }

    const targetLines = rule.checkInComments ? rawLines : strippedLines;

    for (let lineIdx = 0; lineIdx < targetLines.length; lineIdx++) {
      const line = targetLines[lineIdx];
      const match = rule.pattern.exec(line);

      if (match) {
        const lineNum = lineIdx + 1;
        const column = match.index + 1;
        const snippet = rawLines[lineIdx]?.trim();

        const issue: SecurityIssue = {
          id: `${rule.id.toLowerCase()}_${lineNum}_${column}`,
          filePath,
          line: lineNum,
          column,
          severity: rule.severity,
          type: rule.type,
          ruleId: rule.id,
          message: `[${rule.name}] ${rule.message}`,
          snippet,
          suggestion: rule.suggestion,
        };

        if (rule.type === "vulnerability") {
          violations.push(issue);
        } else {
          warnings.push(issue);
        }

        diagnostics.push({
          id: `sec_${issue.id}`,
          filePath,
          line: lineNum,
          column,
          severity: rule.severity === "critical" ? "error" : "warning",
          category: "security",
          message: issue.message,
          ruleId: rule.id,
          source: "security_scanner",
          suggestion: rule.suggestion,
          codeSnippet: snippet,
        });
      }
    }
  }

  const passed = violations.length === 0;
  const summary = passed
    ? warnings.length === 0
      ? "Security content scan passed: no vulnerabilities or warnings detected."
      : `Security content scan passed with ${warnings.length} advisory warning(s).`
    : `Security content scan FAILED: ${violations.length} confirmed critical vulnerability(ies) detected.`;

  return {
    passed,
    violations,
    warnings,
    summary,
    diagnostics,
  };
}

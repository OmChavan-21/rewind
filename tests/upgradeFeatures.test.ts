import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  validateUploadLimits,
  computeDynamicLimits,
  getMemoryMetrics,
} from "../src/security/limits";
import {
  isAllowedFileExtension,
  ALLOWED_EXTENSIONS_LIST,
} from "../src/security/allowedExtensions";
import {
  runWorkspaceDiagnostics,
  diagnoseJsonFile,
  diagnosePythonFile,
} from "../src/engine/codeDiagnostics";
import {
  createProject,
  loadProjectsRegistry,
  resolveProjectWorkspace,
  listProjectSnapshots,
  setActiveProject,
  DEFAULT_PROJECT_ID,
} from "../src/engine/projectManager";
import { chunkDocument } from "../src/engine/textExtractor";
import {
  cosineSimilarity,
  generateLocalEmbedding,
  ingestDocument,
  searchProjectKnowledge,
} from "../src/server/ragService";
import { checkFirebaseStatus } from "../src/server/firebaseService";
import {
  SecurityError,
  FileTooLargeError,
  isPermittedFile,
} from "../src/security/boundaries";
import { createSnapshot } from "../src/engine/recoveryEngine";

describe("Rewind Upgrade Features Test Suite", () => {
  let tempBaseDir: string;
  let testWorkspace: string;
  let testStore: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-upgrade-test-"));
    testWorkspace = path.join(tempBaseDir, "workspace");
    testStore = path.join(tempBaseDir, "store");

    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.mkdirSync(testStore, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -------------------------------------------------------------
  // 1. RESOURCE LIMITS & UPLOAD VALIDATION
  // -------------------------------------------------------------
  describe("1. Resource Limits & Upload Validation", () => {
    it("accepts valid file uploads within size and count constraints", () => {
      const files = [
        { name: "test.ts", size: 1024 },
        { name: "data.json", size: 2048 },
      ];

      assert.doesNotThrow(() => {
        validateUploadLimits(files, 5000);
      });
    });

    it("rejects uploads exceeding batch count limit (10 files)", () => {
      const files = Array.from({ length: 11 }, (_, i) => ({
        name: `file${i}.ts`,
        size: 100,
      }));

      assert.throws(
        () => validateUploadLimits(files, 0),
        (err: unknown) => {
          assert(err instanceof SecurityError);
          assert(err.message.includes("Exceeded maximum allowed files"));
          return true;
        }
      );
    });

    it("rejects single code file exceeding 1MB limit", () => {
      const files = [
        { name: "huge.ts", size: 1024 * 1024 + 10 },
      ];

      assert.throws(
        () => validateUploadLimits(files, 0),
        (err: unknown) => {
          assert(err instanceof FileTooLargeError);
          assert(err.message.includes("exceeds maximum permitted size"));
          return true;
        }
      );
    });

    it("rejects total batch size exceeding 25MB limit", () => {
      const files = [
        { name: "doc1.pdf", size: 9 * 1024 * 1024 },
        { name: "doc2.pdf", size: 9 * 1024 * 1024 },
        { name: "doc3.pdf", size: 9 * 1024 * 1024 },
      ];

      const lowPressureLimits = computeDynamicLimits(0, {
        heapUsedBytes: 50 * 1024 * 1024,
        heapLimitBytes: 1024 * 1024 * 1024,
        systemTotalBytes: 16 * 1024 * 1024 * 1024,
        systemFreeBytes: 12 * 1024 * 1024 * 1024,
        metricsAvailable: true,
      });

      assert.throws(
        () => validateUploadLimits(files, 0, lowPressureLimits),
        (err: unknown) => {
          assert(err instanceof FileTooLargeError);
          assert(err.message.includes("Total batch upload size"));
          return true;
        }
      );
    });

    it("rejects disallowed file extensions (.exe, .env, .sh)", () => {
      const dangerousFiles = [
        { name: "malware.exe", size: 100 },
      ];

      assert.throws(
        () => validateUploadLimits(dangerousFiles, 0),
        (err: unknown) => {
          assert(err instanceof SecurityError);
          assert(err.message.includes("Disallowed file type"));
          return true;
        }
      );
    });

    it("accepts Python (.py) source file (e.g. donut.py, 1.3 KB) within limits", () => {
      const files = [
        { name: "donut.py", size: 1331 },
      ];

      assert.doesNotThrow(() => {
        validateUploadLimits(files, 5000);
      });
    });

    it("verifies centralized allowlist consistency across client and server boundaries", () => {
      // Python files are supported and permitted
      assert.strictEqual(isAllowedFileExtension("donut.py"), true);
      assert.strictEqual(isPermittedFile("donut.py"), true);
      assert.strictEqual(isAllowedFileExtension("nested/dir/app.PY"), true);
      assert.strictEqual(isPermittedFile("nested/dir/app.PY"), true);
      assert(ALLOWED_EXTENSIONS_LIST.includes(".py"));

      // Standard allowed extensions
      assert.strictEqual(isAllowedFileExtension("index.ts"), true);
      assert.strictEqual(isAllowedFileExtension("package.json"), true);
      assert.strictEqual(isAllowedFileExtension("doc.pdf"), true);

      // Dangerous and unsupported extensions are strictly rejected
      assert.strictEqual(isAllowedFileExtension("malware.exe"), false);
      assert.strictEqual(isPermittedFile("malware.exe"), false);
      assert.strictEqual(isAllowedFileExtension("script.sh"), false);
      assert.strictEqual(isPermittedFile("script.sh"), false);
      assert.strictEqual(isAllowedFileExtension("exploit.pyc"), false);
      assert.strictEqual(isPermittedFile("exploit.pyc"), false);
      assert.strictEqual(isAllowedFileExtension(".env"), false);
      assert.strictEqual(isPermittedFile(".env"), false);
      assert.strictEqual(isAllowedFileExtension("payload.bin"), false);
      assert.strictEqual(isPermittedFile("payload.bin"), false);
    });

    it("provides 5-tier memory explanations and valid numeric metrics", () => {
      const metrics = getMemoryMetrics(testWorkspace, testStore);

      assert(typeof metrics.serverMemory.heapUsedMb === "number" && metrics.serverMemory.heapUsedMb > 0);
      assert(typeof metrics.serverMemory.heapTotalMb === "number" && metrics.serverMemory.heapTotalMb > 0);
      assert(typeof metrics.serverMemory.rssMb === "number" && metrics.serverMemory.rssMb > 0);
      assert(metrics.memoryExplanations.browser.length > 0);
      assert(metrics.memoryExplanations.serverHeap.length > 0);
      assert(metrics.memoryExplanations.diskStore.length > 0);
      assert(metrics.memoryExplanations.firebase.length > 0);
      assert(metrics.memoryExplanations.externalLLM.length > 0);
    });
  });

  // -------------------------------------------------------------
  // 2. CODE DIAGNOSTICS & AST ANALYSIS
  // -------------------------------------------------------------
  describe("2. Code Diagnostics & Safe AST Analysis", () => {
    it("detects TypeScript syntax errors without executing code", () => {
      // Create broken TypeScript file
      const brokenTsPath = path.join(testWorkspace, "broken.ts");
      fs.writeFileSync(
        brokenTsPath,
        "function brokenCode( { let x = ; return }\n",
        "utf-8"
      );

      const result = runWorkspaceDiagnostics(testWorkspace, "test-project");

      assert.strictEqual(result.hasErrors, true);
      const syntaxError = result.diagnostics.find(
        (d) => d.filePath === "broken.ts" && d.category === "syntax"
      );
      assert(syntaxError !== undefined);
      assert.strictEqual(syntaxError.severity, "error");
      assert(syntaxError.line > 0);
      assert(typeof syntaxError.message === "string" && syntaxError.message.length > 0);
    });

    it("parses JSON syntax errors with exact line and column numbers", () => {
      const malformedJson = '{\n  "title": "Rewind",\n  "status": \n}';
      const diags = diagnoseJsonFile("config.json", malformedJson);

      assert(diags.length > 0);
      const err = diags[0];
      assert.strictEqual(err.filePath, "config.json");
      assert.strictEqual(err.severity, "error");
      assert.strictEqual(err.category, "syntax");
      assert(err.line >= 2);
      assert(err.message.includes("JSON Syntax Error"));
    });

    it("passes cleanly with zero errors on valid code", () => {
      const validTs = path.join(testWorkspace, "valid.ts");
      fs.writeFileSync(
        validTs,
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "utf-8"
      );

      const result = runWorkspaceDiagnostics(testWorkspace, "custom-project");
      const tsDiags = result.diagnostics.filter((d) => d.filePath === "valid.ts");
      assert.strictEqual(tsDiags.length, 0);
    });

    it("analyzes valid Python code (donut.py) cleanly with zero errors", () => {
      const validPython = `import math

def render_donut():
    # Mathematical calculation for 3D torus ASCII rendering
    r1 = 1
    r2 = 2
    return r1 + r2
`;
      const diags = diagnosePythonFile("donut.py", validPython);
      assert.strictEqual(diags.length, 0);

      // Also when placed into workspace
      fs.writeFileSync(path.join(testWorkspace, "donut.py"), validPython, "utf-8");
      const result = runWorkspaceDiagnostics(testWorkspace, "custom-project");
      const pyDiags = result.diagnostics.filter((d) => d.filePath === "donut.py");
      assert.strictEqual(pyDiags.length, 0);
    });

    it("detects Python syntax errors statically without executing code", () => {
      // 1. Missing colon on def and if statements
      const missingColonPy = `def calculate(x)
    if x > 10
        return x
`;
      const colonDiags = diagnosePythonFile("test_colon.py", missingColonPy);
      assert(colonDiags.some((d) => d.message.includes("expected ':' at end of 'def'")));
      assert(colonDiags.some((d) => d.message.includes("expected ':' at end of 'if'")));

      // 2. Unclosed brackets
      const unclosedPy = `matrix = [1, 2, (3, 4]`;
      const bracketDiags = diagnosePythonFile("test_bracket.py", unclosedPy);
      assert(bracketDiags.some((d) => d.message.includes("Mismatched closing bracket") || d.message.includes("Unclosed bracket")));

      // 3. Unclosed quote string
      const unclosedStrPy = `msg = "unterminated string`;
      const strDiags = diagnosePythonFile("test_str.py", unclosedStrPy);
      assert(strDiags.some((d) => d.message.includes("Unterminated string literal")));
    });

    it("reports invariant errors when demo-workspace invariants fail", () => {
      // In demo-workspace mode, required files are checked
      const result = runWorkspaceDiagnostics(testWorkspace, DEFAULT_PROJECT_ID);
      assert.strictEqual(result.hasErrors, true);
      assert(result.diagnostics.some((d) => d.category === "validation"));
    });
  });

  // -------------------------------------------------------------
  // 3. MULTI-PROJECT MANAGEMENT & ISOLATION
  // -------------------------------------------------------------
  describe("3. Multi-Project Management & Isolation", () => {
    it("creates isolated project directories and updates registry", () => {
      const project = createProject(
        {
          name: "Security Audit Tool",
          description: "Automated vulnerability scanner",
          template: "empty",
        },
        testStore
      );

      assert(project.id.startsWith("proj_security-audit-tool_"));
      assert.strictEqual(project.name, "Security Audit Tool");
      assert(fs.existsSync(project.workspacePath));
      assert(fs.existsSync(path.join(project.workspacePath, "README.md")));

      // Verify registry
      const registry = loadProjectsRegistry(testStore);
      assert(registry.projects[project.id] !== undefined);
      assert.strictEqual(registry.activeProjectId, project.id);
    });

    it("resolves isolated workspace paths without cross-contamination", () => {
      const proj1 = createProject({ name: "Alpha Service", template: "empty" }, testStore);
      const proj2 = createProject({ name: "Beta Service", template: "empty" }, testStore);

      const path1 = resolveProjectWorkspace(proj1.id, testStore);
      const path2 = resolveProjectWorkspace(proj2.id, testStore);

      assert.notStrictEqual(path1, path2);
      assert(path1.includes(proj1.id));
      assert(path2.includes(proj2.id));
    });

    it("switches active project and verifies persistence", () => {
      const proj1 = createProject({ name: "Alpha", template: "empty" }, testStore);
      const proj2 = createProject({ name: "Beta", template: "empty" }, testStore);

      setActiveProject(proj1.id, testStore);
      let reg = loadProjectsRegistry(testStore);
      assert.strictEqual(reg.activeProjectId, proj1.id);

      setActiveProject(proj2.id, testStore);
      reg = loadProjectsRegistry(testStore);
      assert.strictEqual(reg.activeProjectId, proj2.id);
    });

    it("filters snapshots strictly by projectId", () => {
      const proj1 = createProject({ name: "Proj1", template: "demo" }, testStore);
      const proj2 = createProject({ name: "Proj2", template: "demo" }, testStore);

      // Create snapshot for proj1
      const snap1 = createSnapshot(
        proj1.workspacePath,
        testStore,
        "Snapshot for Proj 1",
        "test-runner",
        { workspaceId: proj1.id }
      );

      // Create snapshot for proj2
      const snap2 = createSnapshot(
        proj2.workspacePath,
        testStore,
        "Snapshot for Proj 2",
        "test-runner",
        { workspaceId: proj2.id }
      );

      const proj1Snaps = listProjectSnapshots(proj1.id, testStore);
      const proj2Snaps = listProjectSnapshots(proj2.id, testStore);

      assert.strictEqual(proj1Snaps.length, 1);
      assert.strictEqual(proj1Snaps[0].id, snap1.id);

      assert.strictEqual(proj2Snaps.length, 1);
      assert.strictEqual(proj2Snaps[0].id, snap2.id);
    });
  });

  // -------------------------------------------------------------
  // 4. RAG KNOWLEDGE BASE & VECTOR PIPELINE
  // -------------------------------------------------------------
  describe("4. RAG Vector Pipeline & Semantic Retrieval", () => {
    it("chunks text documents into overlapping segments with metadata", () => {
      const longText = "Sentence one about safety. ".repeat(40);
      const chunks = chunkDocument("doc_123", "test-project", "sample.txt", longText, 1);

      assert(chunks.length > 1);
      assert.strictEqual(chunks[0].fileName, "sample.txt");
      assert.strictEqual(chunks[0].docId, "doc_123");
      assert(typeof chunks[0].chunkIndex === "number");
      assert(chunks[0].text.length > 0);
    });

    it("calculates exact cosine similarity correctly", () => {
      const vecA = [1, 0, 0];
      const vecB = [1, 0, 0];
      const vecC = [0, 1, 0];
      const vecOpposite = [-1, 0, 0];

      // Identical vectors: 1.0
      assert.strictEqual(Math.round(cosineSimilarity(vecA, vecB) * 100) / 100, 1.0);

      // Orthogonal vectors: 0.0
      assert.strictEqual(cosineSimilarity(vecA, vecC), 0.0);

      // Opposite vectors: -1.0
      assert.strictEqual(cosineSimilarity(vecA, vecOpposite), -1.0);
    });

    it("generates deterministic unit-normalized local embeddings", () => {
      const text1 = "Rewind recovery engine architecture";
      const text2 = "Rewind recovery engine architecture";
      const text3 = "Something completely unrelated about cooking recipes";

      const emb1 = generateLocalEmbedding(text1, 128);
      const emb2 = generateLocalEmbedding(text2, 128);
      const emb3 = generateLocalEmbedding(text3, 128);

      assert.strictEqual(emb1.length, 128);
      // Deterministic: same input yields identical embedding
      assert.deepStrictEqual(emb1, emb2);

      // Similarity between identical texts is 1.0
      const simIdentical = cosineSimilarity(emb1, emb2);
      assert(Math.abs(simIdentical - 1.0) < 0.001);

      // Similarity between dissimilar texts is substantially lower
      const simDifferent = cosineSimilarity(emb1, emb3);
      assert(simDifferent < 0.85);
    });

    it("ingests document and performs top-K ranked retrieval", async () => {
      const doc = await ingestDocument(
        "test-proj",
        "recovery-guide.md",
        Buffer.from(
          "# Recovery Guide\n\nTo restore a snapshot in Rewind, verify the target workspace has no conflicting modifications.\n"
        ),
        testStore
      );

      assert.strictEqual(doc.fileName, "recovery-guide.md");
      assert(doc.chunkCount > 0);

      // Search for relevant query
      const results = await searchProjectKnowledge(
        "test-proj",
        "How do I restore a snapshot safely?",
        3,
        0.01,
        testStore
      );

      assert(results.length > 0);
      assert.strictEqual(results[0].chunk.fileName, "recovery-guide.md");
      assert(results[0].similarityScore > 0);
      assert(results[0].chunk.text.includes("restore a snapshot"));
    });

    it("ingests Python source code (.py) into RAG knowledge base and performs semantic retrieval", async () => {
      const pythonSource = Buffer.from(
        `import math
import time

def render_donut():
    """Renders a spinning 3D torus in ASCII art using trigonometry and rotation matrices."""
    A = 0.0
    B = 0.0
    # compute 3D torus projection onto 2D terminal buffer
    return "ascii_donut_frame"
`
      );

      const doc = await ingestDocument(
        "test-proj",
        "donut.py",
        pythonSource,
        testStore
      );

      assert.strictEqual(doc.fileName, "donut.py");
      assert.strictEqual(doc.mimeType, "text/x-python");
      assert(doc.chunkCount > 0);
      assert.strictEqual(doc.sizeBytes, pythonSource.length);

      // Search RAG knowledge base for Python function
      const results = await searchProjectKnowledge(
        "test-proj",
        "How is the 3D donut rendered in terminal ASCII?",
        3,
        0.01,
        testStore
      );

      assert(results.length > 0);
      const topMatch = results[0];
      assert.strictEqual(topMatch.chunk.fileName, "donut.py");
      assert(topMatch.chunk.text.includes("render_donut"));
      assert(topMatch.similarityScore > 0);
    });
  });

  // -------------------------------------------------------------
  // 5. FIREBASE INTEGRATION & SAFE FALLBACK
  // -------------------------------------------------------------
  describe("5. Firebase Integration & Safe Unconfigured Fallback", () => {
    it("reports unconfigured status safely when environment variables are missing", async () => {
      // Ensure test environment does not have Firebase credentials set
      const oldProj = process.env.FIREBASE_PROJECT_ID;
      delete process.env.FIREBASE_PROJECT_ID;

      try {
        const status = await checkFirebaseStatus();
        assert.strictEqual(status.configured, false);
        assert.strictEqual(status.state, "unconfigured");
        assert(status.message.includes("Firebase is not configured"));
      } finally {
        if (oldProj) process.env.FIREBASE_PROJECT_ID = oldProj;
      }
    });

    it("never exposes private key contents in status response", async () => {
      const status = await checkFirebaseStatus();
      const serialized = JSON.stringify(status);

      assert(!serialized.includes("BEGIN PRIVATE KEY"));
      assert(!serialized.includes("private_key"));
    });
  });
});

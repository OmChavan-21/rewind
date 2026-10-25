import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { POST } from "../src/app/api/workspace/upload/route";
import {
  createProject,
} from "../src/engine/projectManager";
import {
  loadProjectVectorStore,
  searchProjectKnowledge,
} from "../src/server/ragService";

describe("Rewind Upload Regression & Bugfix Test Suite", () => {
  let tempBaseDir: string;
  let testStore: string;
  let originalStoreDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-upload-test-"));
    testStore = path.join(tempBaseDir, "store");
    fs.mkdirSync(testStore, { recursive: true });

    originalStoreDir = process.env.REWIND_STORE_DIR;
    process.env.REWIND_STORE_DIR = testStore;
  });

  afterEach(() => {
    if (originalStoreDir !== undefined) {
      process.env.REWIND_STORE_DIR = originalStoreDir;
    } else {
      delete process.env.REWIND_STORE_DIR;
    }

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  const SAMPLE_PYTHON_CODE = `import math

def render_donut():
    """Renders a spinning 3D ASCII torus."""
    A, B = 0.0, 0.0
    return f"donut_frame_{A}_{B}"

if __name__ == "__main__":
    print(render_donut())
`;

  // 1 & 2. Real multipart upload of donut.py into project workspace
  it("1 & 2. performs real multipart upload of donut.py, saving to target project workspace with exact matching bytes", async () => {
    const project = createProject(
      { name: "Python Vision Demo", template: "empty" },
      testStore
    );

    const formData = new FormData();
    const fileBlob = new Blob([SAMPLE_PYTHON_CODE], { type: "text/x-python" });
    formData.append("files", fileBlob, "donut.py");
    formData.append("projectId", project.id);
    formData.append("ingestToRAG", "true");

    const req = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert(Array.isArray(data.uploadedFiles));
    assert(data.uploadedFiles.includes("donut.py"));
    assert(typeof data.safetySnapshotId === "string");

    // Verify file is saved in the correct project workspace
    const targetFilePath = path.join(project.workspacePath, "donut.py");
    assert(fs.existsSync(targetFilePath), "Target file must exist in project workspace");

    const savedContent = fs.readFileSync(targetFilePath, "utf-8");
    assert.strictEqual(savedContent, SAMPLE_PYTHON_CODE);
  });

  // 3. RAG ingestion succeeds when enabled
  it("3. ingests uploaded Python file into RAG knowledge base when ingestToRAG is enabled", async () => {
    const project = createProject(
      { name: "RAG Python Test", template: "empty" },
      testStore
    );

    const formData = new FormData();
    const fileBlob = new Blob([SAMPLE_PYTHON_CODE], { type: "text/x-python" });
    formData.append("files", fileBlob, "donut.py");
    formData.append("projectId", project.id);
    formData.append("ingestToRAG", "true");

    const req = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert(data.ragIndexedFiles.includes("donut.py"));

    // Verify RAG vector store contains the document and chunks
    const store = loadProjectVectorStore(project.id, testStore);
    const docEntry = Object.values(store.documents).find((d) => d.fileName === "donut.py");
    assert(docEntry !== undefined);
    assert.strictEqual(docEntry.mimeType, "text/x-python");

    // Perform semantic search
    const results = await searchProjectKnowledge(
      project.id,
      "How is the 3D donut rendered in ASCII?",
      3,
      0.01,
      testStore
    );
    assert(results.length > 0);
    assert.strictEqual(results[0].chunk.fileName, "donut.py");
    assert(results[0].chunk.text.includes("render_donut"));
    assert(results[0].similarityScore > 0);
  });

  // 4. Upload succeeds when RAG ingestion is disabled
  it("4. successfully uploads file without indexing when ingestToRAG is disabled", async () => {
    const project = createProject(
      { name: "No RAG Project", template: "empty" },
      testStore
    );

    const formData = new FormData();
    const fileBlob = new Blob([SAMPLE_PYTHON_CODE], { type: "text/x-python" });
    formData.append("files", fileBlob, "helper.py");
    formData.append("projectId", project.id);
    formData.append("ingestToRAG", "false");

    const req = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert(data.uploadedFiles.includes("helper.py"));
    assert(!data.ragIndexedFiles || !data.ragIndexedFiles.includes("helper.py"));

    // Verify file exists on disk
    assert(fs.existsSync(path.join(project.workspacePath, "helper.py")));

    // Verify vector store has NOT indexed helper.py
    const store = loadProjectVectorStore(project.id, testStore);
    const docEntry = Object.values(store.documents).find((d) => d.fileName === "helper.py");
    assert.strictEqual(docEntry, undefined);
  });

  // 5. Missing or malformed upload fields return clear validation error
  it("5. returns clear validation error for empty or malformed upload requests", async () => {
    // Empty multipart form (no files attached)
    const emptyFormData = new FormData();
    emptyFormData.append("projectId", "demo-workspace");

    const req1 = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: emptyFormData,
    });

    const res1 = await POST(req1);
    assert.strictEqual(res1.status, 400);
    const data1 = await res1.json();
    assert(data1.error.includes("No valid files received"));

    // Empty JSON body
    const req2 = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });

    const res2 = await POST(req2);
    assert.strictEqual(res2.status, 400);
    const data2 = await res2.json();
    assert(data2.error.includes("No valid files received"));
  });

  // 6. Uploading to wrong project is prevented
  it("6. prevents uploading to non-existent or invalid projects", async () => {
    const formData = new FormData();
    const fileBlob = new Blob([SAMPLE_PYTHON_CODE], { type: "text/x-python" });
    formData.append("files", fileBlob, "donut.py");
    formData.append("projectId", "non_existent_project_xyz");

    const req = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert(data.error.includes("does not exist"));
  });

  // 7. Unsupported extensions and path traversal are rejected
  it("7. strictly rejects unsupported extensions and path traversal attacks", async () => {
    const project = createProject(
      { name: "Security Check", template: "empty" },
      testStore
    );

    // Dangerous extension .exe
    const formExe = new FormData();
    formExe.append("files", new Blob(["MZ..."], { type: "application/octet-stream" }), "malware.exe");
    formExe.append("projectId", project.id);

    const resExe = await POST(new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formExe,
    }));
    assert.strictEqual(resExe.status, 400);
    const dataExe = await resExe.json();
    assert(dataExe.error.includes("unsupported file type") || dataExe.error.includes("Disallowed"));

    // Path traversal sequence
    const formTraversal = new FormData();
    formTraversal.append("files", new Blob(["escaped"], { type: "text/plain" }), "../../escape.txt");
    formTraversal.append("projectId", project.id);

    const resTraversal = await POST(new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formTraversal,
    }));
    await resTraversal.json();
    // Verify no file was written outside project workspace
    assert(!fs.existsSync(path.join(testStore, "escape.txt")));
    assert(!fs.existsSync(path.join(tempBaseDir, "escape.txt")));
  });

  // 8. RAG failures reported accurately without losing saved files
  it("8. accurately reports partial RAG failure without losing saved file on disk", async () => {
    const project = createProject(
      { name: "Partial RAG Test", template: "empty" },
      testStore
    );

    // Empty content produces RAG extraction failure ("Document contains no readable text content.")
    const emptyBlob = new Blob(["   \n\t   \n"], { type: "text/x-python" });
    const formData = new FormData();
    formData.append("files", emptyBlob, "whitespace.py");
    formData.append("projectId", project.id);
    formData.append("ingestToRAG", "true");

    const req = new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert(data.uploadedFiles.includes("whitespace.py"));

    // File MUST be safely saved on disk
    assert(fs.existsSync(path.join(project.workspacePath, "whitespace.py")));

    // Partial RAG failure must be reported
    assert(Array.isArray(data.ragErrors));
    assert(data.ragErrors.some((e: { file: string; error: string }) => e.file === "whitespace.py"));
  });

  // 9. Deduplication on retry
  it("9. updates existing RAG document on re-upload without creating duplicate chunks", async () => {
    const project = createProject(
      { name: "Deduplication Test", template: "empty" },
      testStore
    );

    // First upload
    const form1 = new FormData();
    form1.append("files", new Blob([SAMPLE_PYTHON_CODE], { type: "text/x-python" }), "donut.py");
    form1.append("projectId", project.id);
    form1.append("ingestToRAG", "true");

    const res1 = await POST(new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: form1,
    }));
    assert.strictEqual(res1.status, 200);

    const store1 = loadProjectVectorStore(project.id, testStore);
    const chunkCount1 = store1.chunks.filter((c) => c.fileName === "donut.py").length;
    assert(chunkCount1 > 0);

    // Re-upload with overwrite
    const updatedCode = SAMPLE_PYTHON_CODE + "\n# Extra revision\ndef new_func(): pass\n";
    const form2 = new FormData();
    form2.append("files", new Blob([updatedCode], { type: "text/x-python" }), "donut.py");
    form2.append("projectId", project.id);
    form2.append("overwrite", "true");
    form2.append("ingestToRAG", "true");

    const res2 = await POST(new Request("http://localhost/api/workspace/upload", {
      method: "POST",
      body: form2,
    }));
    assert.strictEqual(res2.status, 200);

    const store2 = loadProjectVectorStore(project.id, testStore);
    const chunkCount2 = store2.chunks.filter((c) => c.fileName === "donut.py").length;
    // Chunk count must NOT have doubled (e.g. 81 + 80 = 161), old chunks must be replaced
    assert(chunkCount2 > 0);
    assert(chunkCount2 < chunkCount1 * 1.5, `Chunk count should not be additive (got ${chunkCount2}, previous was ${chunkCount1})`);
    const docEntries = Object.values(store2.documents).filter((d) => d.fileName === "donut.py");
    assert.strictEqual(docEntries.length, 1, "There must only be 1 document entry for donut.py in the vector store");
  });
});

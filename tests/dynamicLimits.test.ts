import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  computeDynamicLimits,
  validateUploadLimits,
  getSystemResourceMetrics,
  getResourceLimits,
} from "../src/security/limits";
import { FileTooLargeError, SecurityError } from "../src/security/boundaries";
import {
  ingestDocument,
  getRAGProcessingStatus,
  loadProjectVectorStore,
} from "../src/server/ragService";
import { POST as uploadRouteHandler } from "../src/app/api/workspace/upload/route";
import { GET as limitsRouteHandler } from "../src/app/api/system/limits/route";
import { createProject } from "../src/engine/projectManager";

describe("Dynamic Resource Intelligence & Limits Test Suite", () => {
  let tempBaseDir: string;
  let testStore: string;
  let originalStoreDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-dynamic-limits-"));
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

  // 1. Low memory pressure
  it("1. low memory pressure maintains full 100% configured caps with no reduction reasons", () => {
    const limits = computeDynamicLimits(1024, {
      heapUsedBytes: 100 * 1024 * 1024,
      heapLimitBytes: 1024 * 1024 * 1024, // ~9.7% used
      systemTotalBytes: 16 * 1024 * 1024 * 1024,
      systemFreeBytes: 12 * 1024 * 1024 * 1024, // 75% free
      metricsAvailable: true,
    });

    assert.strictEqual(limits.status.pressureLevel, "low");
    assert.strictEqual(limits.effective.maxFileSizeBytes, limits.configured.maxFileSizeBytes);
    assert.strictEqual(limits.effective.maxDocumentSizeBytes, limits.configured.maxDocumentSizeBytes);
    assert.strictEqual(limits.effective.maxFilesPerUpload, limits.configured.maxFilesPerUpload);
    assert.strictEqual(limits.effective.maxTotalUploadSizeBytes, limits.configured.maxTotalUploadSizeBytes);
    assert.strictEqual(limits.reasonsForReduction.length, 0);
  });

  // 2. Moderate memory pressure
  it("2. moderate memory pressure scales batch count and file sizes safely", () => {
    const limits = computeDynamicLimits(1024, {
      heapUsedBytes: 650 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024, // 65% heap used
      systemTotalBytes: 16 * 1024 * 1024 * 1024,
      systemFreeBytes: 8 * 1024 * 1024 * 1024,
      metricsAvailable: true,
    });

    assert.strictEqual(limits.status.pressureLevel, "moderate");
    assert.strictEqual(limits.effective.maxFilesPerUpload, 7);
    assert.strictEqual(
      limits.effective.maxFileSizeBytes,
      Math.floor(limits.configured.maxFileSizeBytes * 0.8)
    );
    assert.ok(limits.reasonsForReduction.length > 0);
    assert.ok(limits.reasonsForReduction.some((r) => r.includes("Moderate resource pressure")));
  });

  // 3. High memory pressure
  it("3. high memory pressure scales limits down by 50% with explanatory reason", () => {
    const limits = computeDynamicLimits(1024, {
      heapUsedBytes: 780 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024, // 78% heap used
      systemTotalBytes: 16 * 1024 * 1024 * 1024,
      systemFreeBytes: 4 * 1024 * 1024 * 1024,
      metricsAvailable: true,
    });

    assert.strictEqual(limits.status.pressureLevel, "high");
    assert.strictEqual(
      limits.effective.maxFileSizeBytes,
      Math.floor(limits.configured.maxFileSizeBytes * 0.5)
    );
    assert.strictEqual(limits.effective.maxDocumentSizeBytes, 5 * 1024 * 1024);
    assert.strictEqual(limits.effective.maxFilesPerUpload, 5);
    assert.strictEqual(limits.effective.maxTotalUploadSizeBytes, 10 * 1024 * 1024);
    assert.ok(limits.reasonsForReduction.some((r) => r.includes("High resource pressure")));
  });

  // 4. Critical memory pressure
  it("4. critical memory pressure aggressively reduces limits to protect process stability", () => {
    const limits = computeDynamicLimits(1024, {
      heapUsedBytes: 920 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024, // 92% heap used
      systemTotalBytes: 16 * 1024 * 1024 * 1024,
      systemFreeBytes: 400 * 1024 * 1024, // 2.5% free
      metricsAvailable: true,
    });

    assert.strictEqual(limits.status.pressureLevel, "critical");
    assert.strictEqual(
      limits.effective.maxFileSizeBytes,
      Math.floor(limits.configured.maxFileSizeBytes * 0.25)
    );
    assert.strictEqual(limits.effective.maxDocumentSizeBytes, 1024 * 1024);
    assert.strictEqual(limits.effective.maxFilesPerUpload, 2);
    assert.strictEqual(limits.effective.maxTotalUploadSizeBytes, 2 * 1024 * 1024);
    assert.ok(limits.reasonsForReduction.some((r) => r.includes("Critical memory pressure")));
  });

  // 5. Storage headroom clamping
  it("5. storage headroom clamps total batch and file limits when space is low", () => {
    const configured = getResourceLimits();
    const remainingHeadroom = 500 * 1024; // 500 KB remaining
    const usedBytes = configured.maxProjectStorageBytes - remainingHeadroom;

    const limits = computeDynamicLimits(usedBytes, {
      heapUsedBytes: 50 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024,
      metricsAvailable: true,
    });

    assert.strictEqual(limits.effective.remainingStorageBytes, remainingHeadroom);
    assert.ok(limits.effective.maxFileSizeBytes <= remainingHeadroom);
    assert.ok(limits.effective.maxTotalUploadSizeBytes <= remainingHeadroom);
    assert.ok(limits.reasonsForReduction.some((r) => r.includes("Storage headroom")));
  });

  // 6. Project storage quota exhausted
  it("6. project storage exhaustion zeroes effective limits and rejects upload before writing", () => {
    const configured = getResourceLimits();
    const limits = computeDynamicLimits(configured.maxProjectStorageBytes, {
      heapUsedBytes: 50 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024,
      metricsAvailable: true,
    });

    assert.strictEqual(limits.status.pressureLevel, "critical");
    assert.strictEqual(limits.effective.remainingStorageBytes, 0);
    assert.strictEqual(limits.effective.maxFileSizeBytes, 0);
    assert.strictEqual(limits.effective.maxFilesPerUpload, 0);
    assert.strictEqual(limits.effective.maxTotalUploadSizeBytes, 0);
    assert.ok(limits.reasonsForReduction.some((r) => r.includes("quota exhausted")));

    // validateUploadLimits must throw FileTooLargeError
    assert.throws(
      () => {
        validateUploadLimits(
          [{ name: "app.ts", size: 100 }],
          configured.maxProjectStorageBytes,
          limits
        );
      },
      (err: unknown) => {
        return (
          err instanceof FileTooLargeError &&
          err.message.includes("Project storage quota exhausted")
        );
      }
    );
  });

  // 7. Hard caps invariance
  it("7. effective limits never exceed administrator configured hard caps", () => {
    const configured = getResourceLimits();
    const limits = computeDynamicLimits(0, {
      heapUsedBytes: 1,
      heapLimitBytes: 100 * 1024 * 1024 * 1024,
      systemFreeBytes: 100 * 1024 * 1024 * 1024,
      systemTotalBytes: 100 * 1024 * 1024 * 1024,
      metricsAvailable: true,
    });

    assert.ok(limits.effective.maxFileSizeBytes <= configured.maxFileSizeBytes);
    assert.ok(limits.effective.maxDocumentSizeBytes <= configured.maxDocumentSizeBytes);
    assert.ok(limits.effective.maxFilesPerUpload <= configured.maxFilesPerUpload);
    assert.ok(limits.effective.maxTotalUploadSizeBytes <= configured.maxTotalUploadSizeBytes);
    assert.ok(limits.effective.maxProjectStorageBytes <= configured.maxProjectStorageBytes);
  });

  // 8. Missing / unsupported metrics fallback
  it("8. gracefully falls back to safe defaults when server metrics are unavailable", () => {
    const metrics = getSystemResourceMetrics({ metricsAvailable: false });
    assert.strictEqual(metrics.metricsAvailable, false);

    const limits = computeDynamicLimits(0, { metricsAvailable: false });
    assert.strictEqual(limits.status.metricsAvailable, false);
    assert.ok(limits.effective.maxFileSizeBytes > 0);
    assert.ok(limits.effective.maxFilesPerUpload > 0);
  });

  // 9. Client/server consistency under dynamic pressure
  it("9. validateUploadLimits enforces dynamic limits and explains reduction in error message", () => {
    // Under critical pressure, maxFileSizeBytes is reduced to ~25% (256 KB)
    const criticalLimits = computeDynamicLimits(1000, {
      heapUsedBytes: 950 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024,
      metricsAvailable: true,
    });

    // A 300 KB file is under the 1 MB configured cap, but exceeds the dynamic 256 KB cap
    assert.throws(
      () => {
        validateUploadLimits(
          [{ name: "largeScript.ts", size: 300 * 1024 }],
          1000,
          criticalLimits
        );
      },
      (err: unknown) => {
        return (
          err instanceof FileTooLargeError &&
          err.message.includes("exceeds dynamic limit") &&
          err.message.includes("Critical memory pressure")
        );
      }
    );

    // Too many files under critical pressure (maxFilesPerUpload = 2)
    assert.throws(
      () => {
        validateUploadLimits(
          [
            { name: "f1.ts", size: 100 },
            { name: "f2.ts", size: 100 },
            { name: "f3.ts", size: 100 },
          ],
          1000,
          criticalLimits
        );
      },
      (err: unknown) => {
        return (
          err instanceof SecurityError &&
          err.message.includes("Exceeded maximum allowed files per upload (3 > 2)")
        );
      }
    );
  });

  // 10. System limits API endpoint returns dynamicLimits and ragStatus
  it("10. GET /api/system/limits returns dynamic limits, memory metrics, and RAG status", async () => {
    const req = new Request("http://localhost:3000/api/system/limits");
    const res = await limitsRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.ok(body.limits);
    assert.ok(body.dynamicLimits);
    assert.ok(body.dynamicLimits.configured);
    assert.ok(body.dynamicLimits.effective);
    assert.ok(body.dynamicLimits.status);
    assert.ok(Array.isArray(body.dynamicLimits.reasonsForReduction));
    assert.ok(body.memoryMetrics);
    assert.ok(body.ragStatus);
    assert.strictEqual(typeof body.ragStatus.activeJobs, "number");
    assert.strictEqual(typeof body.ragStatus.maxConcurrency, "number");
    assert.strictEqual(typeof body.ragStatus.totalIndexedDocuments, "number");
  });

  // 11. RAG Bounded Concurrency and Index Tracking
  it("11. RAG ingestion indexes documents with bounded concurrency and updates status", async () => {
    const project = createProject({ name: "RAG Test Project", template: "empty" }, testStore);
    const initialStatus = getRAGProcessingStatus(testStore);
    assert.strictEqual(initialStatus.activeJobs, 0);
    assert.strictEqual(initialStatus.maxConcurrency, 4);

    const docContent = Buffer.from(
      "Rewind provides autonomous reliability engineering with dynamic resource intelligence. " +
        "It protects against memory leaks, CPU starvation, and filesystem quota overflow.\n\n" +
        "Section 2: Snapshots are captured before file modifications and stored immutably."
    );

    const ragDoc = await ingestDocument(project.id, "architecture.md", docContent, testStore);
    assert.strictEqual(ragDoc.status, "indexed");
    assert.ok(ragDoc.chunkCount > 0);

    const updatedStatus = getRAGProcessingStatus(testStore);
    assert.strictEqual(updatedStatus.activeJobs, 0); // Finished
    assert.ok(updatedStatus.totalIndexedDocuments >= 1);
    assert.ok(updatedStatus.totalChunks >= ragDoc.chunkCount);

    const store = loadProjectVectorStore(project.id, testStore);
    assert.ok(store.documents[ragDoc.id]);
    assert.strictEqual(store.chunks.length, ragDoc.chunkCount);
    // Every chunk has a computed unit embedding vector
    assert.ok(store.chunks.every((c) => Array.isArray(c.vector) && c.vector.length === 384));
  });

  // 12. Upload route returns dynamic limits in response
  it("12. POST /api/workspace/upload enforces dynamic limits and returns dynamicLimits in response", async () => {
    const project = createProject({ name: "Upload Dynamic Test", template: "empty" }, testStore);

    const formData = new FormData();
    formData.append("projectId", project.id);
    formData.append("ingestToRAG", "false");
    const file = new File(["console.log('hello dynamic limits');\n"], "testDynamic.ts", {
      type: "text/typescript",
    });
    formData.append("files", file);

    const req = new Request("http://localhost:3000/api/workspace/upload", {
      method: "POST",
      body: formData,
    });

    const res = await uploadRouteHandler(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(body.dynamicLimits);
    assert.ok(body.dynamicLimits.effective);
    assert.strictEqual(body.uploadedFiles.length, 1);
  });
});

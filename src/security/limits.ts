import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import v8 from "node:v8";
import type {
  ResourceLimits,
  MemoryMetrics,
  EffectiveResourceLimits,
  ResourcePressureLevel,
  DynamicResourceStatus,
} from "../types/limits";
import { FileTooLargeError, SecurityError, ALLOWED_EXTENSIONS } from "./boundaries";

function parseEnvInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

/**
 * Returns configured administrator hard caps from environment variables or secure defaults.
 * These act as immutable upper bounds for dynamic calculations.
 */
export function getResourceLimits(): ResourceLimits {
  return {
    maxFileSizeBytes: parseEnvInt(process.env.REWIND_MAX_FILE_SIZE_BYTES, 1024 * 1024), // 1 MB
    maxDocumentSizeBytes: parseEnvInt(process.env.REWIND_MAX_DOCUMENT_SIZE_BYTES, 10 * 1024 * 1024), // 10 MB
    maxFilesPerUpload: parseEnvInt(process.env.REWIND_MAX_FILES_PER_UPLOAD, 10),
    maxTotalUploadSizeBytes: parseEnvInt(process.env.REWIND_MAX_TOTAL_UPLOAD_SIZE_BYTES, 25 * 1024 * 1024), // 25 MB
    maxProjectStorageBytes: parseEnvInt(process.env.REWIND_MAX_PROJECT_STORAGE_BYTES, 100 * 1024 * 1024), // 100 MB
    maxSnapshotsPerProject: parseEnvInt(process.env.REWIND_MAX_SNAPSHOTS_PER_PROJECT, 50),
    maxWorkspaceFiles: parseEnvInt(process.env.REWIND_MAX_WORKSPACE_FILES, 500),
    maxAIContextFiles: parseEnvInt(process.env.REWIND_MAX_AI_CONTEXT_FILES, 20),
    maxAIContextBytes: parseEnvInt(process.env.REWIND_MAX_AI_CONTEXT_BYTES, 200 * 1024), // 200 KB
    maxDocumentPages: parseEnvInt(process.env.REWIND_MAX_DOCUMENT_PAGES, 100),
    maxExtractedTextBytes: parseEnvInt(process.env.REWIND_MAX_EXTRACTED_TEXT_BYTES, 1024 * 1024), // 1 MB
    ragChunkSizeChars: parseEnvInt(process.env.REWIND_RAG_CHUNK_SIZE_CHARS, 500),
    ragChunkOverlapChars: parseEnvInt(process.env.REWIND_RAG_CHUNK_OVERLAP_CHARS, 100),
    requestTimeoutMs: parseEnvInt(process.env.REWIND_REQUEST_TIMEOUT_MS, 60000), // 60s
  };
}

export interface SystemResourceMetrics {
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  rssBytes: number;
  systemTotalBytes?: number;
  systemFreeBytes?: number;
  metricsAvailable: boolean;
}

/**
 * Accurately measures genuine server memory metrics via process.memoryUsage(),
 * v8.getHeapStatistics(), and node:os. Gracefully handles restricted environments.
 */
export function getSystemResourceMetrics(
  customMock?: Partial<SystemResourceMetrics>
): SystemResourceMetrics {
  if (customMock) {
    return {
      heapUsedBytes: customMock.heapUsedBytes ?? 50 * 1024 * 1024,
      heapTotalBytes: customMock.heapTotalBytes ?? 100 * 1024 * 1024,
      heapLimitBytes: customMock.heapLimitBytes ?? 1024 * 1024 * 1024,
      rssBytes: customMock.rssBytes ?? 80 * 1024 * 1024,
      systemTotalBytes: customMock.systemTotalBytes ?? 16 * 1024 * 1024 * 1024,
      systemFreeBytes: customMock.systemFreeBytes ?? 8 * 1024 * 1024 * 1024,
      metricsAvailable: customMock.metricsAvailable ?? true,
    };
  }

  try {
    const mem = process.memoryUsage();
    let heapLimitBytes = mem.heapTotal * 2;
    try {
      const stats = v8.getHeapStatistics();
      if (stats && typeof stats.heap_size_limit === "number" && stats.heap_size_limit > 0) {
        heapLimitBytes = stats.heap_size_limit;
      }
    } catch {
      // Fallback if v8.getHeapStatistics is restricted
    }

    let systemTotalBytes: number | undefined;
    let systemFreeBytes: number | undefined;
    try {
      const total = os.totalmem();
      const free = os.freemem();
      if (typeof total === "number" && total > 0 && typeof free === "number" && free >= 0) {
        systemTotalBytes = total;
        systemFreeBytes = free;
      }
    } catch {
      // Fallback if os metrics unavailable
    }

    return {
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      heapLimitBytes,
      rssBytes: mem.rss,
      systemTotalBytes,
      systemFreeBytes,
      metricsAvailable: true,
    };
  } catch {
    return {
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      heapLimitBytes: 512 * 1024 * 1024,
      rssBytes: 0,
      metricsAvailable: false,
    };
  }
}

/**
 * Computes dynamic, resource-aware effective upload limits.
 * Considers configured hard caps, remaining project storage, and server memory pressure.
 */
export function computeDynamicLimits(
  currentProjectStorageBytes: number,
  customMetrics?: Partial<SystemResourceMetrics>
): EffectiveResourceLimits {
  const configured = getResourceLimits();
  const sysMetrics = getSystemResourceMetrics(customMetrics);

  const reasonsForReduction: string[] = [];
  const statusReasons: string[] = [];

  const remainingStorageBytes = Math.max(
    0,
    configured.maxProjectStorageBytes - currentProjectStorageBytes
  );
  const storageUsedRatio = configured.maxProjectStorageBytes > 0
    ? Math.min(1.0, currentProjectStorageBytes / configured.maxProjectStorageBytes)
    : 1.0;

  // Heap ratio from genuine V8 heap statistics
  const heapUsedRatio = sysMetrics.metricsAvailable && sysMetrics.heapLimitBytes > 0
    ? Math.min(1.0, sysMetrics.heapUsedBytes / sysMetrics.heapLimitBytes)
    : 0.1;

  // Host system free RAM ratio from node:os
  const systemFreeRatio = sysMetrics.metricsAvailable &&
    sysMetrics.systemTotalBytes &&
    sysMetrics.systemTotalBytes > 0 &&
    sysMetrics.systemFreeBytes !== undefined
      ? Math.max(0.0, Math.min(1.0, sysMetrics.systemFreeBytes / sysMetrics.systemTotalBytes))
      : undefined;

  const freeBytes = sysMetrics.systemFreeBytes;
  const isCriticalSystemRam =
    freeBytes !== undefined &&
    freeBytes < 100 * 1024 * 1024 &&
    (systemFreeRatio === undefined || systemFreeRatio <= 0.02);
  const isHighSystemRam =
    freeBytes !== undefined &&
    freeBytes < 200 * 1024 * 1024 &&
    (systemFreeRatio === undefined || systemFreeRatio <= 0.04);
  const isModerateSystemRam =
    freeBytes !== undefined &&
    freeBytes < 400 * 1024 * 1024 &&
    (systemFreeRatio === undefined || systemFreeRatio <= 0.06);

  // Determine resource pressure level
  let pressureLevel: ResourcePressureLevel = "low";

  if (
    remainingStorageBytes <= 0 ||
    heapUsedRatio >= 0.88 ||
    isCriticalSystemRam
  ) {
    pressureLevel = "critical";
  } else if (
    storageUsedRatio >= 0.90 ||
    heapUsedRatio >= 0.75 ||
    isHighSystemRam
  ) {
    pressureLevel = "high";
  } else if (
    storageUsedRatio >= 0.75 ||
    heapUsedRatio >= 0.60 ||
    isModerateSystemRam
  ) {
    pressureLevel = "moderate";
  }

  // Base values start at configured hard caps
  let effectiveFileSizeBytes = configured.maxFileSizeBytes;
  let effectiveDocumentSizeBytes = configured.maxDocumentSizeBytes;
  let effectiveFilesPerUpload = configured.maxFilesPerUpload;
  let effectiveTotalUploadSizeBytes = configured.maxTotalUploadSizeBytes;

  // 1. Dynamic scaling by server memory pressure
  if (pressureLevel === "critical") {
    effectiveFileSizeBytes = Math.min(effectiveFileSizeBytes, Math.floor(configured.maxFileSizeBytes * 0.25));
    effectiveDocumentSizeBytes = Math.min(effectiveDocumentSizeBytes, 1024 * 1024);
    effectiveFilesPerUpload = Math.min(effectiveFilesPerUpload, 2);
    effectiveTotalUploadSizeBytes = Math.min(effectiveTotalUploadSizeBytes, 2 * 1024 * 1024);
    const heapPct = Math.round(heapUsedRatio * 100);
    const reason = `Critical memory pressure detected (V8 heap: ${heapPct}%); upload sizes aggressively reduced to protect process stability.`;
    reasonsForReduction.push(reason);
    statusReasons.push(reason);
  } else if (pressureLevel === "high") {
    effectiveFileSizeBytes = Math.min(effectiveFileSizeBytes, Math.floor(configured.maxFileSizeBytes * 0.50));
    effectiveDocumentSizeBytes = Math.min(effectiveDocumentSizeBytes, 5 * 1024 * 1024);
    effectiveFilesPerUpload = Math.min(effectiveFilesPerUpload, 5);
    effectiveTotalUploadSizeBytes = Math.min(effectiveTotalUploadSizeBytes, 10 * 1024 * 1024);
    const heapPct = Math.round(heapUsedRatio * 100);
    const reason = `High resource pressure (V8 heap: ${heapPct}%); file and batch limits scaled down by 50%.`;
    reasonsForReduction.push(reason);
    statusReasons.push(reason);
  } else if (pressureLevel === "moderate") {
    effectiveFileSizeBytes = Math.min(effectiveFileSizeBytes, Math.floor(configured.maxFileSizeBytes * 0.80));
    effectiveDocumentSizeBytes = Math.min(effectiveDocumentSizeBytes, configured.maxDocumentSizeBytes);
    effectiveFilesPerUpload = Math.min(effectiveFilesPerUpload, 7);
    effectiveTotalUploadSizeBytes = Math.min(effectiveTotalUploadSizeBytes, 18 * 1024 * 1024);
    const reason = `Moderate resource pressure; batch count scaled to ${effectiveFilesPerUpload} files.`;
    reasonsForReduction.push(reason);
    statusReasons.push(reason);
  }

  // 2. Storage headroom constraint
  if (remainingStorageBytes <= 0) {
    effectiveFileSizeBytes = 0;
    effectiveDocumentSizeBytes = 0;
    effectiveFilesPerUpload = 0;
    effectiveTotalUploadSizeBytes = 0;
    const reason = `Project storage quota exhausted (100% used of ${(configured.maxProjectStorageBytes / (1024 * 1024)).toFixed(0)} MB). Uploads are disabled until space is freed.`;
    reasonsForReduction.push(reason);
    statusReasons.push(reason);
  } else if (effectiveTotalUploadSizeBytes > remainingStorageBytes) {
    effectiveTotalUploadSizeBytes = remainingStorageBytes;
    effectiveFileSizeBytes = Math.min(effectiveFileSizeBytes, remainingStorageBytes);
    effectiveDocumentSizeBytes = Math.min(effectiveDocumentSizeBytes, remainingStorageBytes);
    const reason = `Storage headroom is ${(remainingStorageBytes / (1024 * 1024)).toFixed(2)} MB (${Math.round((1 - storageUsedRatio) * 100)}% remaining); batch and file limits clamped to available space.`;
    reasonsForReduction.push(reason);
    statusReasons.push(reason);
  }

  // Hard guarantee: effective limits NEVER exceed configured administrator hard caps
  effectiveFileSizeBytes = Math.min(effectiveFileSizeBytes, configured.maxFileSizeBytes);
  effectiveDocumentSizeBytes = Math.min(effectiveDocumentSizeBytes, configured.maxDocumentSizeBytes);
  effectiveFilesPerUpload = Math.min(effectiveFilesPerUpload, configured.maxFilesPerUpload);
  effectiveTotalUploadSizeBytes = Math.min(effectiveTotalUploadSizeBytes, configured.maxTotalUploadSizeBytes);

  const status: DynamicResourceStatus = {
    pressureLevel,
    heapUsedRatio: Math.round(heapUsedRatio * 100) / 100,
    systemFreeRatio: systemFreeRatio !== undefined ? Math.round(systemFreeRatio * 100) / 100 : undefined,
    storageUsedRatio: Math.round(storageUsedRatio * 100) / 100,
    reasons: statusReasons,
    metricsAvailable: sysMetrics.metricsAvailable,
  };

  return {
    configured,
    effective: {
      maxFileSizeBytes: effectiveFileSizeBytes,
      maxDocumentSizeBytes: effectiveDocumentSizeBytes,
      maxFilesPerUpload: effectiveFilesPerUpload,
      maxTotalUploadSizeBytes: effectiveTotalUploadSizeBytes,
      maxProjectStorageBytes: configured.maxProjectStorageBytes,
      remainingStorageBytes,
    },
    status,
    reasonsForReduction,
  };
}

/**
 * Validates a batch of files before accepting them for upload,
 * enforcing dynamic resource-aware limits and storage headroom.
 */
export function validateUploadLimits(
  files: { name: string; size: number }[],
  currentProjectStorageBytes: number,
  dynamicLimitsOverride?: EffectiveResourceLimits
): void {
  const dynamicLimits = dynamicLimitsOverride || computeDynamicLimits(currentProjectStorageBytes);
  const { configured, effective, reasonsForReduction } = dynamicLimits;

  if (files.length === 0) {
    throw new SecurityError("Upload request contains no files.");
  }

  if (effective.remainingStorageBytes <= 0) {
    throw new FileTooLargeError(
      `Project storage quota exhausted (100% utilized). No additional files can be uploaded.`
    );
  }

  if (files.length > effective.maxFilesPerUpload) {
    const isReduced = effective.maxFilesPerUpload < configured.maxFilesPerUpload;
    const reasonContext = isReduced
      ? ` (dynamically reduced from configured cap of ${configured.maxFilesPerUpload} due to: ${reasonsForReduction.join("; ")})`
      : "";
    throw new SecurityError(
      `Exceeded maximum allowed files per upload (${files.length} > ${effective.maxFilesPerUpload})${reasonContext}.`
    );
  }

  let batchTotalBytes = 0;
  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new SecurityError(
        `Disallowed file type '${ext || "unknown"}'. Permitted extensions: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`
      );
    }

    const isDoc = ext === ".pdf";
    const allowedLimit = isDoc ? effective.maxDocumentSizeBytes : effective.maxFileSizeBytes;
    const configuredLimit = isDoc ? configured.maxDocumentSizeBytes : configured.maxFileSizeBytes;

    if (file.size > allowedLimit) {
      const limitMb = (allowedLimit / (1024 * 1024)).toFixed(1);
      const actualMb = (file.size / (1024 * 1024)).toFixed(2);
      const configuredMb = (configuredLimit / (1024 * 1024)).toFixed(1);

      if (allowedLimit < configuredLimit) {
        throw new FileTooLargeError(
          `File '${file.name}' (${actualMb} MB) exceeds maximum permitted size and exceeds dynamic limit of ${limitMb} MB (reduced from configured ${configuredMb} MB due to: ${reasonsForReduction.join("; ")}).`
        );
      } else {
        throw new FileTooLargeError(
          `File '${file.name}' (${actualMb} MB) exceeds maximum permitted size of ${configuredMb} MB.`
        );
      }
    }

    batchTotalBytes += file.size;
  }

  if (batchTotalBytes > effective.maxTotalUploadSizeBytes) {
    const limitMb = (effective.maxTotalUploadSizeBytes / (1024 * 1024)).toFixed(1);
    const actualMb = (batchTotalBytes / (1024 * 1024)).toFixed(2);
    const configuredMb = (configured.maxTotalUploadSizeBytes / (1024 * 1024)).toFixed(1);

    if (effective.maxTotalUploadSizeBytes < configured.maxTotalUploadSizeBytes) {
      throw new FileTooLargeError(
        `Total batch upload size (${actualMb} MB) exceeds dynamic limit of ${limitMb} MB (reduced from configured ${configuredMb} MB due to: ${reasonsForReduction.join("; ")}).`
      );
    } else {
      throw new FileTooLargeError(
        `Total batch upload size (${actualMb} MB) exceeds maximum limit of ${configuredMb} MB.`
      );
    }
  }

  if (currentProjectStorageBytes + batchTotalBytes > configured.maxProjectStorageBytes) {
    const limitMb = (configured.maxProjectStorageBytes / (1024 * 1024)).toFixed(1);
    throw new FileTooLargeError(
      `Project storage quota exceeded. Upload would surpass maximum limit of ${limitMb} MB.`
    );
  }
}

/**
 * Calculates directory size recursively without following symlinks.
 */
export function getDirectorySizeBytes(dirPath: string): { totalBytes: number; fileCount: number } {
  let totalBytes = 0;
  let fileCount = 0;

  if (!fs.existsSync(dirPath)) {
    return { totalBytes, fileCount };
  }

  function walk(current: string) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          continue; // Prevent following symlinks
        }
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          totalBytes += stat.size;
          fileCount += 1;
        }
      }
    } catch {
      // Ignore unreadable entries
    }
  }

  walk(dirPath);
  return { totalBytes, fileCount };
}

/**
 * Accurately measures Node server memory and disk storage metrics.
 */
export function getMemoryMetrics(workspaceRoot?: string, storeRoot?: string): MemoryMetrics {
  const wsRoot = workspaceRoot || process.cwd();
  const stRoot = storeRoot || path.join(process.cwd(), ".rewind_store");
  const mem = process.memoryUsage();
  const workspaceStats = getDirectorySizeBytes(wsRoot);
  const snapshotsDir = path.join(stRoot, "snapshots");
  const snapshotsStats = getDirectorySizeBytes(snapshotsDir);
  const vectorsDir = path.join(stRoot, "vectors");
  const vectorsStats = getDirectorySizeBytes(vectorsDir);

  const entries = fs.existsSync(snapshotsDir)
    ? fs.readdirSync(snapshotsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    : [];

  const isFirebaseActive = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      (process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );

  let heapLimitMb: number | undefined;
  try {
    const stats = v8.getHeapStatistics();
    if (stats?.heap_size_limit) {
      heapLimitMb = Math.round((stats.heap_size_limit / (1024 * 1024)) * 10) / 10;
    }
  } catch {
    // Ignore if unavailable
  }

  let systemMemory: MemoryMetrics["systemMemory"] | undefined;
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (typeof total === "number" && total > 0) {
      const totalMb = Math.round(total / (1024 * 1024));
      const freeMb = Math.round(free / (1024 * 1024));
      const usedMb = totalMb - freeMb;
      const freePercent = Math.round((free / total) * 100);
      systemMemory = { totalMb, freeMb, usedMb, freePercent };
    }
  } catch {
    // Ignore if unavailable
  }

  const dynamicLimits = computeDynamicLimits(workspaceStats.totalBytes);

  return {
    serverMemory: {
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      externalMb: Math.round((mem.external / (1024 * 1024)) * 10) / 10,
      heapLimitMb,
    },
    systemMemory,
    pressureLevel: dynamicLimits.status.pressureLevel,
    storageMetrics: {
      workspaceDiskUsedBytes: workspaceStats.totalBytes,
      snapshotsDiskUsedBytes: snapshotsStats.totalBytes,
      vectorStoreDiskUsedBytes: vectorsStats.totalBytes,
      snapshotCount: entries.length,
      workspaceFileCount: workspaceStats.fileCount,
      remainingQuotaBytes: dynamicLimits.effective.remainingStorageBytes,
    },
    persistenceBackend: isFirebaseActive ? "hybrid" : "local",
    memoryExplanations: {
      browser:
        "Browser memory: Client-side V8 heap used by the React DOM, state stores, and Diff viewer rendering in the user's web browser.",
      serverHeap:
        "Node.js server memory: Memory consumed by the Next.js API server process, including file buffers, AST parsing, and request handling.",
      diskStore:
        "Local disk storage: Persistent filesystem storage on the server hosting project workspaces, file trees, and immutable snapshot archives in .rewind_store/.",
      firebase:
        "Firebase Firestore storage: Cloud NoSQL document storage for project metadata, audit logs, and RAG document indexing states.",
      externalLLM:
        "External model provider usage: Context token budgets, prompt allocations, and rate limits governed by NVIDIA NIM / Nebius API endpoints.",
    },
  };
}

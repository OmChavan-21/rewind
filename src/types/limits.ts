/**
 * Resource limits and memory metrics specifications for Rewind.
 */

export interface ResourceLimits {
  /** Maximum size for individual code or text file in bytes (default: 1 MB) */
  maxFileSizeBytes: number;
  /** Maximum size for document / PDF uploads in bytes (default: 10 MB) */
  maxDocumentSizeBytes: number;
  /** Maximum number of files permitted per single upload request (default: 10) */
  maxFilesPerUpload: number;
  /** Maximum aggregate payload size per upload request in bytes (default: 25 MB) */
  maxTotalUploadSizeBytes: number;
  /** Maximum storage allocated per project workspace in bytes (default: 100 MB) */
  maxProjectStorageBytes: number;
  /** Maximum snapshots retained per project (default: 50) */
  maxSnapshotsPerProject: number;
  /** Maximum total files in workspace (default: 500) */
  maxWorkspaceFiles: number;
  /** Maximum files included in AI proposal context (default: 20) */
  maxAIContextFiles: number;
  /** Maximum total bytes included in AI proposal context (default: 200 KB) */
  maxAIContextBytes: number;
  /** Maximum pages processed per PDF document (default: 100) */
  maxDocumentPages: number;
  /** Maximum extracted text size per document in bytes (default: 1 MB) */
  maxExtractedTextBytes: number;
  /** RAG chunk size in characters (approx 150-200 tokens) */
  ragChunkSizeChars: number;
  /** RAG chunk overlap in characters */
  ragChunkOverlapChars: number;
  /** Server request timeout in milliseconds */
  requestTimeoutMs: number;
}

export type ResourcePressureLevel = "low" | "moderate" | "high" | "critical";

export interface DynamicResourceStatus {
  pressureLevel: ResourcePressureLevel;
  heapUsedRatio: number;
  systemFreeRatio?: number;
  storageUsedRatio: number;
  reasons: string[];
  metricsAvailable: boolean;
}

export interface EffectiveResourceLimits {
  configured: ResourceLimits;
  effective: {
    maxFileSizeBytes: number;
    maxDocumentSizeBytes: number;
    maxFilesPerUpload: number;
    maxTotalUploadSizeBytes: number;
    maxProjectStorageBytes: number;
    remainingStorageBytes: number;
  };
  status: DynamicResourceStatus;
  reasonsForReduction: string[];
}

export interface RAGProcessingStatus {
  activeJobs: number;
  maxConcurrency: number;
  queuedChunks: number;
  totalIndexedDocuments: number;
  totalChunks: number;
}

export interface MemoryMetrics {
  /** Browser heap estimation (reported from client where window.performance.memory is available) */
  browserMemory?: {
    usedJSHeapSizeMb: number;
    totalJSHeapSizeMb: number;
    jsHeapSizeLimitMb: number;
  };
  /** Node.js server process memory (from process.memoryUsage() & v8.getHeapStatistics()) */
  serverMemory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    heapLimitMb?: number;
  };
  /** Host operating system memory (from node:os) where reliably available */
  systemMemory?: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    freePercent: number;
  };
  /** Current calculated resource pressure level */
  pressureLevel?: ResourcePressureLevel;
  /** Local disk storage on server */
  storageMetrics: {
    workspaceDiskUsedBytes: number;
    snapshotsDiskUsedBytes: number;
    vectorStoreDiskUsedBytes: number;
    snapshotCount: number;
    workspaceFileCount: number;
    remainingQuotaBytes?: number;
  };
  /** Persistence backend description */
  persistenceBackend: "local" | "firebase" | "hybrid";
  /** Explanations of each memory boundary */
  memoryExplanations: {
    browser: string;
    serverHeap: string;
    diskStore: string;
    firebase: string;
    externalLLM: string;
  };
}

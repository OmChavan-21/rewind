/**
 * Retrieval-Augmented Generation (RAG) types.
 */

export interface DocumentChunk {
  chunkId: string;
  docId: string;
  projectId: string;
  fileName: string;
  chunkIndex: number;
  totalChunks: number;
  pageNumber?: number;
  text: string;
  vector?: number[];
  charCount: number;
  tokenCountEstimate: number;
  createdAt: string;
}

export interface RAGDocument {
  id: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount?: number;
  chunkCount: number;
  createdAt: string;
  status: "indexed" | "failed" | "processing";
  error?: string;
  embeddingModel: string;
  vectorDimensions: number;
}

export interface VectorSearchResult {
  chunk: DocumentChunk;
  similarityScore: number;
}

export interface RAGAnswer {
  question: string;
  answer: string;
  citations: {
    sourceId: string;
    fileName: string;
    pageNumber?: number;
    chunkIndex: number;
    relevantExcerpt: string;
    similarityScore: number;
  }[];
  retrievedCount: number;
  model: string;
  createdAt: string;
  grounded: boolean;
}

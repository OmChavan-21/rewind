import path from "node:path";
import crypto from "node:crypto";
// Dynamic or safe import of pdf-parse
import type { DocumentChunk } from "../types/rag";
import { getResourceLimits } from "../security/limits";
import { FileTooLargeError, SecurityError } from "../security/boundaries";

/**
 * Extracts raw text from supported document types (Text, MD, JSON, TS/JS, and PDF).
 */
export async function extractDocumentText(
  filePath: string,
  buffer: Buffer
): Promise<{ text: string; pageCount?: number }> {
  const ext = path.extname(filePath).toLowerCase();
  const limits = getResourceLimits();

  if (buffer.length > limits.maxDocumentSizeBytes) {
    throw new FileTooLargeError(
      `Document exceeds maximum size of ${(limits.maxDocumentSizeBytes / (1024 * 1024)).toFixed(1)} MB.`
    );
  }

  if (ext === ".pdf") {
    try {
      // Dynamic import to avoid Turbopack native binary bundling issues
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse");
      const pdfData = await pdfParse(buffer, {
        max: limits.maxDocumentPages,
      });

      const text = pdfData.text || "";
      if (text.length > limits.maxExtractedTextBytes) {
        return {
          text: text.slice(0, limits.maxExtractedTextBytes),
          pageCount: pdfData.numpages,
        };
      }
      return { text, pageCount: pdfData.numpages };
    } catch (pdfErr) {
      const errMsg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      throw new SecurityError(`Failed to parse PDF document: ${errMsg}`);
    }
  }

  // Text, Markdown, JSON, Code
  const text = buffer.toString("utf-8");
  if (text.length > limits.maxExtractedTextBytes) {
    return { text: text.slice(0, limits.maxExtractedTextBytes), pageCount: 1 };
  }
  return { text, pageCount: 1 };
}

/**
 * Cleans extracted text (normalizes whitespace, strips control chars).
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/ +/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

/**
 * Splits document text into overlapping chunks with metadata.
 */
export function chunkDocument(
  docId: string,
  projectId: string,
  fileName: string,
  text: string,
  pageCount?: number
): DocumentChunk[] {
  const limits = getResourceLimits();
  const chunkSize = limits.ragChunkSizeChars; // default ~500 chars (~150-200 tokens)
  const overlap = limits.ragChunkOverlapChars; // default ~100 chars

  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const chunks: DocumentChunk[] = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < cleaned.length) {
    const endIndex = Math.min(startIndex + chunkSize, cleaned.length);
    let chunkText = cleaned.slice(startIndex, endIndex);

    // Try to break at a sentence or newline boundary if not at end
    if (endIndex < cleaned.length) {
      const lastBreak = Math.max(
        chunkText.lastIndexOf(". "),
        chunkText.lastIndexOf("\n"),
        chunkText.lastIndexOf("; ")
      );
      if (lastBreak > chunkSize * 0.5) {
        chunkText = chunkText.slice(0, lastBreak + 1);
      }
    }

    const trimmed = chunkText.trim();
    if (trimmed.length > 20) {
      // Estimate page number if pageCount is known
      const pageNumber =
        pageCount && pageCount > 1
          ? Math.min(Math.floor((startIndex / cleaned.length) * pageCount) + 1, pageCount)
          : 1;

      chunks.push({
        chunkId: `chk_${docId}_${chunkIndex}_${crypto.randomBytes(3).toString("hex")}`,
        docId,
        projectId,
        fileName,
        chunkIndex,
        totalChunks: 0, // Assigned below
        pageNumber,
        text: trimmed,
        charCount: trimmed.length,
        tokenCountEstimate: Math.round(trimmed.length / 3.5),
        createdAt: new Date().toISOString(),
      });
      chunkIndex++;
    }

    startIndex += Math.max(chunkText.length - overlap, 1);
  }

  // Update totalChunks
  for (const chk of chunks) {
    chk.totalChunks = chunks.length;
  }

  return chunks;
}

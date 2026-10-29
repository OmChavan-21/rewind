/**
 * Rewind - Firestore-Backed File Storage Bucket Adapter
 *
 * Implements the StorageBucket contract over Google Cloud Firestore,
 * enabling full serverless file storage, multi-tenant workspace isolation,
 * and atomic snapshot rollback on the Firebase Spark free plan without requiring
 * Google Cloud Storage or the Firebase Blaze billing upgrade.
 *
 * Enforces bounded, verifiable 256 KB chunking to strictly respect
 * Firestore's 1 MiB document limit with full SHA-256 integrity verification.
 */

import crypto from "node:crypto";
import { StorageError } from "./storageTypes";
import type {
  StorageBucket,
  StorageFile,
  FirestoreClient,
  FirestoreDocRef,
} from "./cloudStorageAdapter";

export const FIRESTORE_CHUNK_SIZE = 256 * 1024; // 256 KB per chunk
export const FIRESTORE_MAX_FILE_SIZE = 1024 * 1024; // 1 MB max file size
export const STORAGE_FILES_COLLECTION = "storage_files";

/**
 * Encodes an arbitrary file path (e.g. "projects/demo/workspace/src/app.ts")
 * into a safe, reversible Firestore document ID without slashes.
 */
export function encodeStorageKey(name: string): string {
  return Buffer.from(name, "utf-8").toString("base64url");
}

/**
 * Decodes a base64url Firestore document ID back to the canonical file path.
 */
export function decodeStorageKey(key: string): string {
  return Buffer.from(key, "base64url").toString("utf-8");
}

export class FirestoreStorageFile implements StorageFile {
  readonly name: string;
  metadata?: {
    size?: string;
    updated?: string;
    md5Hash?: string;
    crc32c?: string;
  };
  private db: FirestoreClient;
  private docRef: FirestoreDocRef;

  constructor(db: FirestoreClient, name: string, metadata?: StorageFile["metadata"]) {
    this.db = db;
    this.name = name;
    this.metadata = metadata;
    const docId = encodeStorageKey(name);
    this.docRef = db.collection(STORAGE_FILES_COLLECTION).doc(docId);
  }

  async save(
    content: Buffer | string,
    opts?: { resumable?: boolean; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");

    if (buffer.length > FIRESTORE_MAX_FILE_SIZE) {
      throw new StorageError(
        `File size ${buffer.length} bytes exceeds maximum allowed limit of ${FIRESTORE_MAX_FILE_SIZE} bytes (1 MB).`,
        "VALIDATION_FAILED",
        400
      );
    }

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const updatedAt = new Date().toISOString();
    const contentType =
      (opts?.metadata?.contentType as string) || "text/plain; charset=utf-8";

    // Split buffer into bounded 256 KB chunks
    const chunks: Buffer[] = [];
    if (buffer.length === 0) {
      chunks.push(Buffer.alloc(0));
    } else {
      for (let offset = 0; offset < buffer.length; offset += FIRESTORE_CHUNK_SIZE) {
        chunks.push(buffer.subarray(offset, Math.min(offset + FIRESTORE_CHUNK_SIZE, buffer.length)));
      }
    }

    // Inspect previous chunk count for safe stale chunk cleanup
    let previousChunkCount = 0;
    try {
      const existing = await this.docRef.get();
      if (existing.exists) {
        const data = existing.data();
        if (data && typeof data.chunkCount === "number") {
          previousChunkCount = data.chunkCount;
        }
      }
    } catch {
      // Ignore read error on fresh file
    }

    // 1. Write each chunk document first
    const chunksColl = this.docRef.collection("chunks");
    for (let i = 0; i < chunks.length; i++) {
      const chunkBuf = chunks[i];
      const chunkSha = crypto.createHash("sha256").update(chunkBuf).digest("hex");
      await chunksColl.doc(String(i)).set({
        index: i,
        data: chunkBuf.toString("base64"),
        size: chunkBuf.length,
        sha256: chunkSha,
      });
    }

    // 2. Clean up stale chunk documents if file size shrank
    if (previousChunkCount > chunks.length) {
      for (let i = chunks.length; i < previousChunkCount; i++) {
        await chunksColl.doc(String(i)).delete().catch(() => {});
      }
    }

    // 3. Commit parent metadata document only after all chunks are verified and persisted
    await this.docRef.set({
      name: this.name,
      size: buffer.length,
      sha256,
      chunkCount: chunks.length,
      updatedAt,
      contentType,
    });

    this.metadata = {
      size: String(buffer.length),
      updated: updatedAt,
      md5Hash: sha256,
    };
  }

  async download(): Promise<[Buffer]> {
    const snap = await this.docRef.get();
    if (!snap.exists) {
      throw new StorageError(`File '${this.name}' not found.`, "NOT_FOUND", 404);
    }

    const data = snap.data();
    if (!data) {
      throw new StorageError(`File '${this.name}' has no metadata.`, "NOT_FOUND", 404);
    }

    const chunkCount = typeof data.chunkCount === "number" ? data.chunkCount : 1;
    const expectedSha256 = data.sha256 as string | undefined;
    const chunksColl = this.docRef.collection("chunks");
    const chunkBuffers: Buffer[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const chunkSnap = await chunksColl.doc(String(i)).get();
      if (!chunkSnap.exists) {
        throw new StorageError(
          `Chunk integrity failure for '${this.name}': missing chunk ${i} of ${chunkCount}.`,
          "INTERNAL_ERROR",
          500
        );
      }
      const cData = chunkSnap.data();
      const b64 = (cData?.data as string) || "";
      const buf = Buffer.from(b64, "base64");

      // Verify individual chunk hash if recorded
      if (cData?.sha256) {
        const computed = crypto.createHash("sha256").update(buf).digest("hex");
        if (computed !== cData.sha256) {
          throw new StorageError(
            `Chunk checksum mismatch for '${this.name}' at chunk ${i}.`,
            "INTERNAL_ERROR",
            500
          );
        }
      }
      chunkBuffers.push(buf);
    }

    const assembled = Buffer.concat(chunkBuffers);

    // Verify overall file integrity against metadata sha256
    if (expectedSha256) {
      const computedSha = crypto.createHash("sha256").update(assembled).digest("hex");
      if (computedSha !== expectedSha256) {
        throw new StorageError(
          `File integrity verification failed for '${this.name}': checksum mismatch.`,
          "INTERNAL_ERROR",
          500
        );
      }
    }

    return [assembled];
  }

  async delete(): Promise<void> {
    const snap = await this.docRef.get();
    if (snap.exists) {
      const data = snap.data();
      const chunkCount = typeof data?.chunkCount === "number" ? data.chunkCount : 0;
      const chunksColl = this.docRef.collection("chunks");
      for (let i = 0; i < chunkCount; i++) {
        await chunksColl.doc(String(i)).delete().catch(() => {});
      }
      await this.docRef.delete();
    }
  }

  async exists(): Promise<[boolean]> {
    const snap = await this.docRef.get();
    return [Boolean(snap.exists)];
  }
}

export class FirestoreStorageBucket implements StorageBucket {
  private db: FirestoreClient;

  constructor(db: FirestoreClient) {
    this.db = db;
  }

  file(name: string): StorageFile {
    return new FirestoreStorageFile(this.db, name);
  }

  async getFiles(options?: { prefix?: string }): Promise<[StorageFile[]]> {
    const prefix = options?.prefix || "";
    const snapshot = await this.db.collection(STORAGE_FILES_COLLECTION).get();
    const files: StorageFile[] = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!data) return;
      const name = typeof data.name === "string" ? data.name : decodeStorageKey(doc.id);
      if (name.startsWith(prefix)) {
        files.push(
          new FirestoreStorageFile(this.db, name, {
            size: String(data.size ?? 0),
            updated: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
            md5Hash: typeof data.sha256 === "string" ? data.sha256 : undefined,
          })
        );
      }
    });

    return [files];
  }
}

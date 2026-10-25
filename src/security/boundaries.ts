import path from "node:path";
import fs from "node:fs";

/**
 * Custom error types for security and boundary violations
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(`[Security Violation] ${message}`);
    this.name = "SecurityError";
  }
}

export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(`[Unsupported File Type] ${message}`);
    this.name = "UnsupportedFileTypeError";
  }
}

export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(`[File Size Limit Exceeded] ${message}`);
    this.name = "FileTooLargeError";
  }
}

// Maximum permitted file size: 1 MB
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_EXTENSIONS_LIST,
  isAllowedFileExtension,
} from "./allowedExtensions";

export { ALLOWED_EXTENSIONS, ALLOWED_EXTENSIONS_LIST, isAllowedFileExtension };

// Directories and patterns that must never be read, snapshotted, or modified
export const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".rewind_store",
]);

export const FORBIDDEN_FILE_PREFIXES = [
  ".env", // Never snapshot or expose env secrets
];

// Server-side allowlist of agent actions
export const ALLOWED_ACTION_TYPES = new Set([
  "snapshot_create",
  "file_modify",
  "file_upload",
  "demo_break",
  "restore",
  "validate",
  "workspace_init",
]);

/**
 * Sanitizes and normalizes relative path.
 * Rejects path traversal, null bytes, absolute paths, and drive letters.
 */
export function sanitizeRelativePath(rawRelativePath: string): string {
  if (typeof rawRelativePath !== "string" || !rawRelativePath.trim()) {
    throw new SecurityError("Path must be a non-empty string.");
  }

  // Reject null bytes
  if (rawRelativePath.includes("\0")) {
    throw new SecurityError("Null bytes are strictly forbidden in path.");
  }

  // Reject Windows drive letter roots (e.g. C:) or absolute paths
  if (/^[a-zA-Z]:/.test(rawRelativePath) || rawRelativePath.startsWith("/") || rawRelativePath.startsWith("\\")) {
    throw new SecurityError("Absolute paths and drive letters are not permitted.");
  }

  // Normalize separators to standard POSIX slash for inspection
  const normalized = path.normalize(rawRelativePath).replace(/\\/g, "/");

  // Reject any path traversal attempts ("..")
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new SecurityError("Path traversal sequences ('..' or '.') are not permitted.");
  }

  // Reconstruct clean relative path
  return parts.join("/");
}

/**
 * Resolves and strictly validates that a path lies inside the designated workspace.
 * Prevents directory traversal and symbolic link escapes.
 */
export function resolveAndValidatePath(
  workspaceRoot: string,
  relativePath: string,
  options: { allowNonExistent?: boolean } = {}
): string {
  const cleanRelative = sanitizeRelativePath(relativePath);
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const resolvedFull = path.resolve(canonicalRoot, cleanRelative);

  // Must start with canonical workspace root + separator
  if (!resolvedFull.startsWith(canonicalRoot + path.sep) && resolvedFull !== canonicalRoot) {
    throw new SecurityError(`Target path escapes workspace boundaries: ${cleanRelative}`);
  }

  // If path exists, verify its real canonical path to defeat symlink escapes
  if (fs.existsSync(resolvedFull)) {
    const canonicalTarget = fs.realpathSync(resolvedFull);
    if (!canonicalTarget.startsWith(canonicalRoot + path.sep) && canonicalTarget !== canonicalRoot) {
      throw new SecurityError(`Symbolic-link escape detected: ${cleanRelative}`);
    }

    // Check if it's a symlink directly
    const lstat = fs.lstatSync(resolvedFull);
    if (lstat.isSymbolicLink()) {
      throw new SecurityError(`Symbolic links are not permitted in workspace: ${cleanRelative}`);
    }

    return canonicalTarget;
  }

  if (!options.allowNonExistent) {
    throw new Error(`File not found: ${cleanRelative}`);
  }

  // For non-existent files (e.g. new file creation), ensure parent directory is valid
  const parentDir = path.dirname(resolvedFull);
  if (fs.existsSync(parentDir)) {
    const canonicalParent = fs.realpathSync(parentDir);
    if (!canonicalParent.startsWith(canonicalRoot) && canonicalParent !== canonicalRoot) {
      throw new SecurityError(`Parent directory escapes workspace root: ${cleanRelative}`);
    }
  }

  return resolvedFull;
}

/**
 * Checks whether a given relative file path is allowlisted for reading and snapshotting.
 */
export function isPermittedFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const fileName = segments[segments.length - 1];

  // Exclude ignored directories
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_DIR_NAMES.has(segment)) {
      return false;
    }
  }

  // Check forbidden prefixes (like .env, .env.local) except .env.example
  for (const prefix of FORBIDDEN_FILE_PREFIXES) {
    if (fileName.startsWith(prefix) && fileName !== ".env.example") {
      return false;
    }
  }

  // Hidden files check (starting with dot) except explicitly allowed configs
  if (fileName.startsWith(".") && fileName !== ".gitignore") {
    return false;
  }

  // Check allowed extensions
  const ext = path.extname(fileName).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Asserts that a file size is within safety limits.
 */
export function validateFileSize(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new FileTooLargeError(
      `File size (${sizeBytes} bytes) exceeds safety limit of ${MAX_FILE_SIZE_BYTES} bytes.`
    );
  }
}

/**
 * Validates action type against server allowlist.
 */
export function validateActionType(actionType: string): void {
  if (!ALLOWED_ACTION_TYPES.has(actionType)) {
    throw new SecurityError(`Action type '${actionType}' is not permitted.`);
  }
}

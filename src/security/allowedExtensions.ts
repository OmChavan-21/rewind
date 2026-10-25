/**
 * Centralized, shared allowlisted file extensions for Rewind.
 * Used by both client-side upload validation and server-side security boundaries.
 */
export const ALLOWED_EXTENSIONS_LIST = [
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".yaml",
  ".yml",
  ".pdf",
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS_LIST)[number];

export const ALLOWED_EXTENSIONS = new Set<string>(ALLOWED_EXTENSIONS_LIST);

/**
 * Returns true if the file name has an allowlisted extension.
 * Safe for execution in both client-side React and server-side runtimes.
 */
export function isAllowedFileExtension(fileName: string): boolean {
  if (!fileName || typeof fileName !== "string") return false;
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = fileName.slice(lastDot).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

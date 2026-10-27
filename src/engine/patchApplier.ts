/**
 * Minimal Unified-Diff Parser and Patch Applier
 * Enforces strict validation, path containment, malformed-patch rejection,
 * and ambiguous hunk detection.
 */

import { isPermittedFile } from "../security/boundaries";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export class MalformedPatchError extends PatchError {
  constructor(message: string) {
    super(`[Malformed Patch] ${message}`);
    this.name = "MalformedPatchError";
  }
}

export class AmbiguousHunkError extends PatchError {
  constructor(message: string) {
    super(`[Ambiguous Hunk] ${message}`);
    this.name = "AmbiguousHunkError";
  }
}

export class PathContainmentError extends PatchError {
  constructor(message: string) {
    super(`[Security Boundary Violation] ${message}`);
    this.name = "PathContainmentError";
  }
}

export interface DiffHunk {
  oldStart: number;
  oldLinesCount: number;
  newStart: number;
  newLinesCount: number;
  header: string;
  lines: string[];
}

export interface ParsedPatch {
  oldPath: string;
  newPath: string;
  targetPath: string;
  hunks: DiffHunk[];
}

export interface AppliedPatchResult {
  path: string;
  originalContent: string;
  patchedContent: string;
  hunksApplied: number;
}

/**
 * Sanitizes and validates a file path extracted from a patch header.
 */
function sanitizePatchPath(rawPath: string): string {
  let cleaned = rawPath.trim();
  // Strip standard git prefix prefixes a/ or b/
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) {
    cleaned = cleaned.slice(2);
  }
  cleaned = cleaned.replace(/\\/g, "/");

  // Reject empty or /dev/null
  if (!cleaned || cleaned === "/dev/null") {
    return cleaned;
  }

  // Security containment check
  if (
    cleaned.startsWith("/") ||
    cleaned.startsWith("../") ||
    cleaned.includes("/../") ||
    cleaned.endsWith("/..") ||
    cleaned.includes("..") ||
    cleaned.includes(":") ||
    cleaned.includes("\0")
  ) {
    throw new PathContainmentError(`Patch path '${rawPath}' attempts directory traversal or invalid protocol.`);
  }

  if (!isPermittedFile(cleaned)) {
    throw new PathContainmentError(`Patch path '${cleaned}' violates permitted file security policy.`);
  }

  return cleaned;
}

/**
 * Parses unified diff text into structured, validated patch representations.
 */
export function parseUnifiedDiff(diffText: string): ParsedPatch[] {
  if (!diffText || !diffText.trim()) {
    throw new MalformedPatchError("Diff content is empty.");
  }

  const lines = diffText.split(/\r?\n/);
  const patches: ParsedPatch[] = [];

  let currentOldPath = "";
  let currentNewPath = "";
  let currentTargetPath = "";
  let currentHunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  function finalizeCurrentHunk() {
    if (!currentHunk) return;

    // Verify line counts
    let actualOld = 0;
    let actualNew = 0;

    for (const l of currentHunk.lines) {
      if (l.startsWith(" ")) {
        actualOld++;
        actualNew++;
      } else if (l.startsWith("-")) {
        actualOld++;
      } else if (l.startsWith("+")) {
        actualNew++;
      }
    }

    if (actualOld !== currentHunk.oldLinesCount || actualNew !== currentHunk.newLinesCount) {
      throw new MalformedPatchError(
        `Hunk header declared -${currentHunk.oldStart},${currentHunk.oldLinesCount} +${currentHunk.newStart},${currentHunk.newLinesCount}, but found ${actualOld} old lines and ${actualNew} new lines.`
      );
    }

    currentHunks.push(currentHunk);
    currentHunk = null;
  }

  function finalizePatch() {
    finalizeCurrentHunk();
    if (currentTargetPath && currentHunks.length > 0) {
      patches.push({
        oldPath: currentOldPath,
        newPath: currentNewPath,
        targetPath: currentTargetPath,
        hunks: currentHunks,
      });
    }
    currentOldPath = "";
    currentNewPath = "";
    currentTargetPath = "";
    currentHunks = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      finalizeCurrentHunk();
      currentOldPath = line.slice(4).trim();
      continue;
    }

    if (line.startsWith("+++ ")) {
      finalizeCurrentHunk();
      currentNewPath = line.slice(4).trim();
      // Target path is from new path, or old path if new is /dev/null
      const target = currentNewPath !== "/dev/null" ? currentNewPath : currentOldPath;
      currentTargetPath = sanitizePatchPath(target);
      continue;
    }

    if (line.startsWith("@@")) {
      finalizeCurrentHunk();

      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (!match) {
        throw new MalformedPatchError(`Malformed hunk header: '${line}'`);
      }

      const oldStart = parseInt(match[1], 10);
      const oldLinesCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newLinesCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

      currentHunk = {
        oldStart,
        oldLinesCount,
        newStart,
        newLinesCount,
        header: line,
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("\\")
      ) {
        currentHunk.lines.push(line);
      } else if (line.trim() === "" && currentHunk.lines.length < currentHunk.oldLinesCount + currentHunk.newLinesCount) {
        // Tolerantly handle empty context line
        currentHunk.lines.push(" " + line);
      } else {
        throw new MalformedPatchError(`Invalid line in hunk body: '${line}'`);
      }
    }
  }

  finalizePatch();

  if (patches.length === 0) {
    throw new MalformedPatchError("No valid patch or hunks found in diff text.");
  }

  return patches;
}

/**
 * Searches for matching locations in targetLines for the hunk's old lines.
 */
function findMatchingLocations(
  targetLines: string[],
  expectedOldLines: string[]
): number[] {
  if (expectedOldLines.length === 0) {
    return [0];
  }

  const matches: number[] = [];
  const maxStart = targetLines.length - expectedOldLines.length;

  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let j = 0; j < expectedOldLines.length; j++) {
      if (targetLines[start + j] !== expectedOldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
    }
  }

  return matches;
}

/**
 * Applies a parsed patch to a single file's content string.
 * Strictly verifies context matching and detects ambiguous hunks.
 */
export function applyPatchToString(
  originalContent: string,
  patch: ParsedPatch
): string {
  // Normalize newlines to \n for uniform patching
  const lines = originalContent.split(/\r?\n/);
  // Keep track of line offset shifts caused by prior hunks
  let lineOffset = 0;

  for (let hunkIdx = 0; hunkIdx < patch.hunks.length; hunkIdx++) {
    const hunk = patch.hunks[hunkIdx];

    const expectedOldLines: string[] = [];
    const replacementLines: string[] = [];

    for (const l of hunk.lines) {
      if (l.startsWith(" ")) {
        expectedOldLines.push(l.slice(1));
        replacementLines.push(l.slice(1));
      } else if (l.startsWith("-")) {
        expectedOldLines.push(l.slice(1));
      } else if (l.startsWith("+")) {
        replacementLines.push(l.slice(1));
      }
    }

    const preferredPos = hunk.oldStart - 1 + lineOffset;
    const matches = findMatchingLocations(lines, expectedOldLines);

    let matchPos = -1;

    if (matches.length === 0) {
      throw new PatchError(
        `Hunk #${hunkIdx + 1} (${hunk.header}) context failed to match target '${patch.targetPath}'. Content differed from patch baseline.`
      );
    } else if (matches.length === 1) {
      matchPos = matches[0];
    } else {
      // Multiple matching locations found!
      // Check if one match is exactly at preferred position and other matches are far away
      const exactPreferred = matches.filter((m) => Math.abs(m - preferredPos) <= 2);
      if (exactPreferred.length === 1 && expectedOldLines.length >= 3) {
        matchPos = exactPreferred[0];
      } else {
        throw new AmbiguousHunkError(
          `Hunk #${hunkIdx + 1} matches ${matches.length} candidate positions ambiguously in '${patch.targetPath}'. Cannot reliably place changes without ambiguous edits.`
        );
      }
    }

    // Apply the replacement at matchPos
    lines.splice(matchPos, expectedOldLines.length, ...replacementLines);
    lineOffset += replacementLines.length - expectedOldLines.length;
  }

  return lines.join("\n");
}

/**
 * Parses and applies a unified diff to an original content string.
 */
export function applyUnifiedDiff(
  originalContent: string,
  diffText: string
): string {
  const patches = parseUnifiedDiff(diffText);
  if (patches.length === 0) {
    throw new MalformedPatchError("No patches found.");
  }
  return applyPatchToString(originalContent, patches[0]);
}

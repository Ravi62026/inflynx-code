/**
 * @inflynx/patch-engine
 * Atomic changeset transactions & AST node transformations.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ─── Existing Types ───────────────────────────────────────────────────────────

export interface FilePatch {
  filePath: string;
  absolutePath: string;
  oldContent: string;
  newContent: string;
  oldContentHash: string;
  newContentHash: string;
  diff: string;
}

export interface EditTransaction {
  id: string;
  timestamp: number;
  patches: FilePatch[];
  status: "pending" | "committed" | "rolled_back";
}

export interface AstTransformSpec {
  filePath: string;
  targetNodeKind: string;
  targetNodeName: string;
  replacementNodeCode: string;
}

export interface PatchResult {
  patchedContent: string;
  applied: boolean;
  targetLineStart: number;
  targetLineEnd: number;
  replacedLinesCount: number;
  newLinesCount: number;
}

// ─── 1. Surgical Patch Engine ─────────────────────────────────────────────────

function sha256(str: string): string {
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * Replaces targetCode inside originalContent with replacementCode.
 * Performs exact match lookup first, falls back to line-trimmed matching.
 */
export function applySurgicalPatch(
  originalContent: string,
  targetCode: string,
  replacementCode: string
): PatchResult {
  const normOriginal = originalContent.replace(/\r\n/g, "\n");
  const normTarget = targetCode.replace(/\r\n/g, "\n").trim();
  const normReplacement = replacementCode.replace(/\r\n/g, "\n");

  if (!normTarget) {
    throw new Error("Target code snippet cannot be empty.");
  }

  // 1. Exact Substring Match
  const exactIndex = normOriginal.indexOf(normTarget);
  if (exactIndex !== -1) {
    // Verify uniqueness
    const secondIndex = normOriginal.indexOf(normTarget, exactIndex + normTarget.length);
    if (secondIndex !== -1) {
      throw new Error(
        "Target code snippet is ambiguous (found multiple occurrences). Provide more surrounding context lines in target_code."
      );
    }

    const before = normOriginal.slice(0, exactIndex);
    const after = normOriginal.slice(exactIndex + normTarget.length);
    const patchedContent = before + normReplacement + after;

    const startLine = before.split("\n").length;
    const targetLines = normTarget.split("\n").length;
    const replacementLines = normReplacement.split("\n").length;

    return {
      patchedContent,
      applied: true,
      targetLineStart: startLine,
      targetLineEnd: startLine + targetLines - 1,
      replacedLinesCount: targetLines,
      newLinesCount: replacementLines,
    };
  }

  // 2. Line-by-Line Trimmed Sequence Match (Whitespace Tolerance)
  const origLines = normOriginal.split("\n");
  const targetLines = normTarget.split("\n").map((l) => l.trim());

  let matchStart = -1;
  let matchCount = 0;

  for (let i = 0; i <= origLines.length - targetLines.length; i++) {
    let matches = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (origLines[i + j].trim() !== targetLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchCount++;
      if (matchStart === -1) matchStart = i;
    }
  }

  if (matchCount > 1) {
    throw new Error("Target code snippet matches multiple locations after whitespace normalization. Provide more context lines.");
  }

  if (matchStart !== -1) {
    const beforeLines = origLines.slice(0, matchStart);
    const afterLines = origLines.slice(matchStart + targetLines.length);
    const newPatchLines = normReplacement.split("\n");
    const patchedLines = [...beforeLines, ...newPatchLines, ...afterLines];

    return {
      patchedContent: patchedLines.join("\n"),
      applied: true,
      targetLineStart: matchStart + 1,
      targetLineEnd: matchStart + targetLines.length,
      replacedLinesCount: targetLines.length,
      newLinesCount: newPatchLines.length,
    };
  }

  throw new Error("Target code snippet not found in file. Ensure exact code lines are passed in target_code.");
}

// ─── 2. Line-by-Line Unified Diff Algorithm ─────────────────────────────────

export function computeUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = 3
): string {
  const oldLines = oldContent.replace(/\r\n/g, "\n").split("\n");
  const newLines = newContent.replace(/\r\n/g, "\n").split("\n");

  if (oldContent === newContent) return "";

  const diffOutput: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  // Fast line comparison & chunk generator
  let i = 0, j = 0;
  const changes: Array<{ type: "same" | "add" | "del"; oldLine?: number; newLine?: number; line: string }> = [];

  // Compute simple diff array
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      changes.push({ type: "same", oldLine: i + 1, newLine: j + 1, line: oldLines[i] });
      i++; j++;
    } else if (j < newLines.length && (i >= oldLines.length || !oldLines.slice(i).includes(newLines[j]))) {
      changes.push({ type: "add", newLine: j + 1, line: newLines[j] });
      j++;
    } else {
      changes.push({ type: "del", oldLine: i + 1, line: oldLines[i] });
      i++;
    }
  }

  // Format into chunks
  let inChunk = false;
  let chunkLines: string[] = [];
  let chunkOldStart = 0, chunkOldCount = 0;
  let chunkNewStart = 0, chunkNewCount = 0;

  for (let k = 0; k < changes.length; k++) {
    const c = changes[k];
    const isChange = c.type !== "same";

    if (isChange) {
      if (!inChunk) {
        inChunk = true;
        const startContext = Math.max(0, k - contextLines);
        chunkLines = [];
        chunkOldStart = changes[startContext].oldLine ?? 1;
        chunkNewStart = changes[startContext].newLine ?? 1;
        chunkOldCount = 0;
        chunkNewCount = 0;

        for (let ctx = startContext; ctx < k; ctx++) {
          chunkLines.push(` ${changes[ctx].line}`);
          chunkOldCount++;
          chunkNewCount++;
        }
      }

      if (c.type === "del") {
        chunkLines.push(`-${c.line}`);
        chunkOldCount++;
      } else if (c.type === "add") {
        chunkLines.push(`+${c.line}`);
        chunkNewCount++;
      }
    } else if (inChunk) {
      // Lookahead to see if next change is within context lines
      const nextChangeIdx = changes.slice(k).findIndex((item) => item.type !== "same");
      if (nextChangeIdx !== -1 && nextChangeIdx <= contextLines * 2) {
        chunkLines.push(` ${c.line}`);
        chunkOldCount++;
        chunkNewCount++;
      } else {
        // End chunk with context
        const endContext = Math.min(changes.length, k + contextLines);
        for (let ctx = k; ctx < endContext; ctx++) {
          chunkLines.push(` ${changes[ctx].line}`);
          chunkOldCount++;
          chunkNewCount++;
        }
        diffOutput.push(`@@ -${chunkOldStart},${chunkOldCount} +${chunkNewStart},${chunkNewCount} @@`);
        diffOutput.push(...chunkLines);
        inChunk = false;
        k = endContext - 1;
      }
    }
  }

  if (inChunk && chunkLines.length > 0) {
    diffOutput.push(`@@ -${chunkOldStart},${chunkOldCount} +${chunkNewStart},${chunkNewCount} @@`);
    diffOutput.push(...chunkLines);
  }

  return diffOutput.join("\n");
}

// ─── 3. Atomic Multi-File Edit Transaction Manager ─────────────────────────────

export class EditTransactionManager {
  private stagedPatches = new Map<string, FilePatch>();
  private currentTransactionId: string;

  constructor() {
    this.currentTransactionId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  get transactionId(): string {
    return this.currentTransactionId;
  }

  /**
   * Stages a surgical code patch for a file.
   */
  stagePatch(filePath: string, targetCode: string, replacementCode: string): FilePatch {
    const root = process.env.INFLYNX_WORKSPACE_ROOT || process.cwd();
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    const relPath = path.relative(root, absPath);

    const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
    const patchResult = applySurgicalPatch(oldContent, targetCode, replacementCode);
    const newContent = patchResult.patchedContent;

    const filePatch: FilePatch = {
      filePath: relPath,
      absolutePath: absPath,
      oldContent,
      newContent,
      oldContentHash: sha256(oldContent),
      newContentHash: sha256(newContent),
      diff: computeUnifiedDiff(relPath, oldContent, newContent),
    };

    this.stagedPatches.set(absPath, filePatch);
    return filePatch;
  }

  /**
   * Stages a full file write for multi-file transactions.
   */
  stageFileWrite(filePath: string, newContent: string): FilePatch {
    const root = process.env.INFLYNX_WORKSPACE_ROOT || process.cwd();
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    const relPath = path.relative(root, absPath);

    // Guard: if path exists but is a directory, raise clear error
    if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
      throw new Error(
        `Cannot write file: "${absPath}" is an existing directory. ` +
        `Check the path — you may have passed a directory path instead of a file path.`
      );
    }

    const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
    const filePatch: FilePatch = {
      filePath: relPath,
      absolutePath: absPath,
      oldContent,
      newContent,
      oldContentHash: sha256(oldContent),
      newContentHash: sha256(newContent),
      diff: computeUnifiedDiff(relPath, oldContent, newContent),
    };

    this.stagedPatches.set(absPath, filePatch);
    return filePatch;
  }

  getStagedPatches(): FilePatch[] {
    return Array.from(this.stagedPatches.values());
  }

  getCombinedDiff(): string {
    return this.getStagedPatches()
      .map((p) => p.diff)
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Two-phase atomic commit: writes all staged files using temporary files,
   * verifies hashes, and renames atomically.
   */
  commit(): void {
    const patches = this.getStagedPatches();
    if (patches.length === 0) return;

    const tempFiles: Array<{ tmpPath: string; targetPath: string }> = [];

    try {
      // Phase 1: Write all new contents to .inflynx_tmp files
      for (const patch of patches) {
        fs.mkdirSync(path.dirname(patch.absolutePath), { recursive: true });
        const tmpPath = patch.absolutePath + `.inflynx_tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, patch.newContent, "utf-8");

        // Verify written content hash
        const writtenHash = sha256(fs.readFileSync(tmpPath, "utf-8"));
        if (writtenHash !== patch.newContentHash) {
          throw new Error(`Hash mismatch while writing staged patch for ${patch.filePath}`);
        }
        tempFiles.push({ tmpPath, targetPath: patch.absolutePath });
      }

      // Phase 2: Atomic rename
      for (const { tmpPath, targetPath } of tempFiles) {
        fs.renameSync(tmpPath, targetPath);
      }

      this.stagedPatches.clear();
    } catch (err: any) {
      // Clean up temporary files on failure
      for (const { tmpPath } of tempFiles) {
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }
      throw new Error(`Transaction commit failed: ${err?.message || String(err)}`);
    }
  }

  rollback(): void {
    this.stagedPatches.clear();
  }
}

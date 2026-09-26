/**
 * @inflynx/patch-engine
 * Atomic changeset transactions & AST node transformations.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CanonicalPathGuard } from "@inflynx/policy-engine";
import { formatUnifiedPatch } from "./diff.js";

export * from "./diff.js";
export * from "./checkpoints.js";

// ─── Existing Types ───────────────────────────────────────────────────────────

export interface FilePatch {
  filePath: string;
  absolutePath: string;
  oldContent: string;
  newContent: string;
  oldContentHash: string;
  newContentHash: string;
  diff: string;
  /**
   * Whether the file existed when it was staged. `oldContent: ""` cannot answer that —
   * it is both "absent" and "present but empty" — and the difference decides whether a
   * commit should create, replace, or refuse.
   */
  existedAtStage: boolean;
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

export interface CommitResult {
  /** Workspace-relative paths that were written, in commit order. */
  written: string[];
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
 * Line endings are metadata, not content: a one-line fix must not rewrite every
 * line of a CRLF file. Matching happens on normalized text and the file's own
 * dominant ending is restored on the way out (backlog F1).
 */
export function detectEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) || []).length;
  const totalNewlines = (content.match(/\n/g) || []).length;
  return crlf > 0 && crlf * 2 >= totalNewlines ? "\r\n" : "\n";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** Assumes `lfContent` is already LF-normalized. */
function applyEol(lfContent: string, eol: "\r\n" | "\n"): string {
  return eol === "\r\n" ? lfContent.replace(/\n/g, "\r\n") : lfContent;
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
  const eol = detectEol(originalContent);
  const normOriginal = normalizeLineEndings(originalContent);
  const normTarget = normalizeLineEndings(targetCode).trim();
  const normReplacement = normalizeLineEndings(replacementCode);

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
      patchedContent: applyEol(patchedContent, eol),
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
      patchedContent: applyEol(patchedLines.join("\n"), eol),
      applied: true,
      targetLineStart: matchStart + 1,
      targetLineEnd: matchStart + targetLines.length,
      replacedLinesCount: targetLines.length,
      newLinesCount: newPatchLines.length,
    };
  }

  throw new Error("Target code snippet not found in file. Ensure exact code lines are passed in target_code.");
}

// ─── 2. Line-by-Line Unified Diff ───────────────────────────────────────────

/**
 * Kept as the historical entry point; the implementation is now the Myers-based engine in
 * `./diff.ts`. The previous version walked both files with
 * `oldLines.slice(i).includes(newLines[j])` — quadratic, and wrong about hunk starts and
 * trailing newlines (backlog F5, Phase 29).
 */
export function computeUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = 3
): string {
  return formatUnifiedPatch(filePath, oldContent, newContent, { contextLines });
}

// ─── 3. Atomic Multi-File Edit Transaction Manager ─────────────────────────────

export class EditTransactionManager {
  private stagedPatches = new Map<string, FilePatch>();
  private currentTransactionId: string;
  private readonly pathGuard: CanonicalPathGuard;

  /**
   * Accepts an already-resolved guard (preferred: share the gateway's instance so
   * validation and execution cannot disagree) or an explicit root. There is
   * deliberately no `process.env`/`process.cwd()` fallback — a transaction must
   * never silently target a different workspace than the caller's guard (H1).
   */
  constructor(workspaceRoot: string | CanonicalPathGuard) {
    if (typeof workspaceRoot === "string") {
      if (!workspaceRoot.trim()) {
        throw new Error(
          "EditTransactionManager requires a non-empty workspace root; env/cwd fallback was removed (backlog H1)."
        );
      }
      this.pathGuard = new CanonicalPathGuard(workspaceRoot);
    } else if (workspaceRoot) {
      this.pathGuard = workspaceRoot;
    } else {
      throw new Error("EditTransactionManager requires a workspace root or a CanonicalPathGuard instance.");
    }
    this.currentTransactionId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  get transactionId(): string {
    return this.currentTransactionId;
  }

  /**
   * Stages a surgical code patch for a file.
   */
  stagePatch(filePath: string, targetCode: string, replacementCode: string): FilePatch {
    const root = this.pathGuard.getWorkspaceRoot();
    const absPath = this.pathGuard.validateAndResolve(filePath);
    const relPath = path.relative(root, absPath);

    if (fs.existsSync(absPath) && fs.lstatSync(absPath).isDirectory()) {
      throw new Error(`Cannot patch file: "${absPath}" is an existing directory.`);
    }

    const existedAtStage = fs.existsSync(absPath);
    const oldContent = existedAtStage ? fs.readFileSync(absPath, "utf-8") : "";
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
      existedAtStage,
    };

    this.stagedPatches.set(absPath, filePatch);
    return filePatch;
  }

  /**
   * Stages a full file write for multi-file transactions.
   */
  stageFileWrite(filePath: string, newContent: string): FilePatch {
    const root = this.pathGuard.getWorkspaceRoot();
    const absPath = this.pathGuard.validateAndResolve(filePath);
    const relPath = path.relative(root, absPath);

    // Guard: if path exists but is a directory, raise clear error
    if (fs.existsSync(absPath) && fs.lstatSync(absPath).isDirectory()) {
      throw new Error(
        `Cannot write file: "${absPath}" is an existing directory. ` +
        `Check the path — you may have passed a directory path instead of a file path.`
      );
    }

    const existedAtStage = fs.existsSync(absPath);
    const oldContent = existedAtStage ? fs.readFileSync(absPath, "utf-8") : "";
    // Overwriting a file that already exists must not silently change its line
    // endings; brand-new files default to LF.
    const eol = oldContent ? detectEol(oldContent) : "\n";
    const normalizedNewContent = applyEol(normalizeLineEndings(newContent), eol);
    const filePatch: FilePatch = {
      filePath: relPath,
      absolutePath: absPath,
      oldContent,
      newContent: normalizedNewContent,
      oldContentHash: sha256(oldContent),
      newContentHash: sha256(normalizedNewContent),
      diff: computeUnifiedDiff(relPath, oldContent, normalizedNewContent),
      existedAtStage,
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
   * Three-phase commit: verify everything, write everything to temporaries, then rename.
   *
   * The order is the whole point. The previous version re-checked paths inside phase 1
   * and renamed in a loop with no undo, so a conflict discovered on file 2 of 3 left
   * file 1 already changed on disk while the error said the transaction failed — and a
   * human editing a staged file in between was never noticed at all (backlog F3, F4).
   */
  commit(): CommitResult {
    const patches = this.getStagedPatches();
    if (patches.length === 0) return { written: [] };

    // Phase 0 — nothing has touched disk yet, so a conflict here costs nothing. Every
    // staged file must still be exactly what it was when staged: same content hash, same
    // existence. A mismatch means somebody else edited (or deleted) the file, and the
    // honest answer is to refuse all of it and let the caller re-read and re-stage.
    for (const patch of patches) {
      const resolvedPath = this.pathGuard.validateAndResolve(patch.absolutePath);
      if (resolvedPath !== patch.absolutePath) {
        throw new Error(
          `Transaction aborted before writing anything: path changed after staging for ${patch.filePath} ` +
          `(a symlink may have been introduced).`
        );
      }
      const existsNow = fs.existsSync(patch.absolutePath);
      if (patch.existedAtStage && !existsNow) {
        throw new Error(`Transaction aborted before writing anything: ${patch.filePath} was deleted after it was staged.`);
      }
      if (!patch.existedAtStage && existsNow) {
        throw new Error(`Transaction aborted before writing anything: ${patch.filePath} was created by someone else after it was staged.`);
      }
      if (existsNow) {
        const hashNow = sha256(fs.readFileSync(patch.absolutePath, "utf-8"));
        if (hashNow !== patch.oldContentHash) {
          throw new Error(
            `Transaction aborted before writing anything: ${patch.filePath} changed on disk after it was ` +
            `staged (concurrent edit). Re-read the file and stage against its current content — the ` +
            `staged edit was not applied to any file in this transaction.`
          );
        }
      }
    }

    const tempFiles: Array<{ tmpPath: string; patch: FilePatch }> = [];
    const done: Array<{ absolutePath: string; restoreTo: string | null }> = [];

    try {
      // Phase 1 — write all new contents to .inflynx_tmp files and verify them.
      for (const patch of patches) {
        fs.mkdirSync(path.dirname(patch.absolutePath), { recursive: true });
        const tmpPath = patch.absolutePath + `.inflynx_tmp_${Date.now()}_${this.currentTransactionId}`;
        fs.writeFileSync(tmpPath, patch.newContent, "utf-8");

        const writtenHash = sha256(fs.readFileSync(tmpPath, "utf-8"));
        if (writtenHash !== patch.newContentHash) {
          throw new Error(`Hash mismatch while writing staged patch for ${patch.filePath}`);
        }
        tempFiles.push({ tmpPath, patch });
      }

      // Phase 2 — atomic rename per file, remembering what to put back if one fails.
      for (const { tmpPath, patch } of tempFiles) {
        fs.renameSync(tmpPath, patch.absolutePath);
        done.push({
          absolutePath: patch.absolutePath,
          restoreTo: patch.existedAtStage ? patch.oldContent : null,
        });
      }

      this.stagedPatches.clear();
      return { written: patches.map((p) => p.filePath) };
    } catch (err: any) {
      // Discard temporaries that never made it to a rename.
      for (const { tmpPath } of tempFiles) {
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }

      // Put back what phase 2 already renamed, newest first. This is best-effort by
      // definition — if a restore itself fails there is nowhere safe to continue — so the
      // failure is *named* in the error rather than folded into a generic apology.
      const restored: string[] = [];
      const unrecoverable: string[] = [];
      for (const written of [...done].reverse()) {
        try {
          if (written.restoreTo === null) fs.rmSync(written.absolutePath, { force: true });
          else fs.writeFileSync(written.absolutePath, written.restoreTo, "utf-8");
          restored.push(path.relative(this.pathGuard.getWorkspaceRoot(), written.absolutePath));
        } catch {
          unrecoverable.push(written.absolutePath);
        }
      }

      throw new Error(
        `Transaction commit failed: ${err?.message || String(err)}. ` +
        `${restored.length}/${done.length} already-written file(s) were reverted to their staged content.` +
        (unrecoverable.length
          ? ` ⚠ NOT restored, manual repair required: ${unrecoverable.join(", ")}`
          : "")
      );
    }
  }

  rollback(): void {
    this.stagedPatches.clear();
  }
}

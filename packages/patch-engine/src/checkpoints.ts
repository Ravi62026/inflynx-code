/**
 * Per-turn checkpoints (backlog Phase 30).
 *
 * The class that already existed — `EditTransactionManager` — only ever protected a
 * *single* tool call: `rollback()` discards staged-but-unwritten patches, and once
 * `commit()` has run there is nothing left to roll back and no record that anything was
 * ever written (backlog F2). Reversibility needs a durable pre-image, taken *before* the
 * write, that outlives the process.
 *
 * What is persisted per turn, per file: a **reverse patch** produced by the Phase 29
 * engine, plus the hash of the content that patch expects to be applied to. Not the whole
 * old file — a 2-line edit to a 20k-line source would otherwise copy the source, per turn,
 * per file, forever. Patches are the small representation and, because the engine is now
 * byte-faithful, they are also the exact one.
 *
 * Undo therefore *refuses* rather than guesses: if the file's current hash is not the hash
 * the reverse patch expects, something else edited it since, and force-applying would
 * destroy that work — the very thing this phase exists to prevent.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CanonicalPathGuard } from "@inflynx/policy-engine";
import { applyParsedPatch, formatUnifiedPatch } from "./diff.js";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface CheckpointEntry {
  /** Workspace-relative path, so a checkpoint stays meaningful if the root moves. */
  path: string;
  /** Patch that turns the post-edit content back into the pre-edit content. */
  reversePatch: string;
  /** Hash the reverse patch expects to be applied to (the post-edit content). */
  afterHash: string;
  /** Hash the file should have once the undo succeeds. */
  beforeHash: string;
  existedBefore: boolean;
  /**
   * The edit removed the file, so undoing it must recreate it rather than write to a
   * path that may meanwhile have become a directory.
   */
  removedByEdit: boolean;
  /** The edit created the file, so undoing it must unlink rather than empty it. */
  createdByEdit: boolean;
  /**
   * Set when the operation *moved* the file (rename, or delete-by-rename-to-trash) rather
   * than changing its contents. Undo is then a rename back, which is lossless for content
   * a patch would have to re-encode — and for a directory, which no content patch covers
   * at all.
   */
  movedTo?: string;
}

export interface TurnCheckpoint {
  sessionId: string;
  turnId: string;
  createdAt: number;
  /** Short human-facing description of what the turn was asked to do. */
  label: string;
  entries: CheckpointEntry[];
  /** Set once undone, so a second `/undo` cannot double-apply. */
  undoneAt?: number;
}

export interface EditRecord {
  content: string;
  exists: boolean;
}

export interface UndoOutcome {
  turnId: string;
  restored: string[];
  /** Entries refused because the file no longer matches what the turn left behind. */
  conflicts: Array<{ path: string; reason: string }>;
  /** True when nothing at all could be restored. */
  refused: boolean;
}

/**
 * How many turns of history to keep on disk. A checkpoint is a patch, so 20 is small;
 * unbounded is how `.inflynx/` becomes the thing users complain about.
 */
const DEFAULT_RETAINED_TURNS = 20;

export class TurnCheckpointStore {
  private readonly guard: CanonicalPathGuard;
  private readonly keep: number;
  /** The turn currently being recorded, if any. */
  private current: TurnCheckpoint | null = null;

  constructor(
    workspaceRoot: string | CanonicalPathGuard,
    options: { retainTurns?: number } = {}
  ) {
    if (typeof workspaceRoot === "string") {
      if (!workspaceRoot.trim()) {
        throw new Error("TurnCheckpointStore requires a non-empty workspace root (no cwd/env fallback).");
      }
      this.guard = new CanonicalPathGuard(workspaceRoot);
    } else if (workspaceRoot) {
      this.guard = workspaceRoot;
    } else {
      throw new Error("TurnCheckpointStore requires a workspace root or a CanonicalPathGuard instance.");
    }
    this.keep = Math.max(1, options.retainTurns ?? DEFAULT_RETAINED_TURNS);
  }

  private get dir(): string {
    return path.join(this.guard.getWorkspaceRoot(), ".inflynx", "checkpoints");
  }

  private fileFor(sessionId: string, turnId: string): string {
    // Both ids are generated here (`session_…`, `turn_…`), but this is a path built from
    // strings, so it goes through the same resolution as everything else in the engine.
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.dir, `${safe(sessionId)}__${safe(turnId)}.json`);
  }

  /** Starts recording. Anything not covered by an open turn is not checkpointed. */
  beginTurn(sessionId: string, turnId: string, label: string): void {
    this.current = { sessionId, turnId, createdAt: Date.now(), label, entries: [] };
  }

  /** The open checkpoint, for callers (tests, status lines) that want to inspect it. */
  get openTurn(): TurnCheckpoint | null {
    return this.current;
  }

  /**
   * Records one file mutation. Called *after* the write succeeded, with the bytes from
   * *before* it — the caller has both, and no later reader would reliably recover the
   * first.
   *
   * Idempotent per path within a turn: the first pre-image is the one undo needs, so a
   * turn that edits the same file four times is restored to what it was before the first.
   */
  recordEdit(relPath: string, before: EditRecord, after: EditRecord): void {
    if (!this.current) return;
    if (this.current.entries.some((e) => e.path === relPath)) return;

    const reversePatch = formatUnifiedPatch(relPath, after.content, before.content);
    this.current.entries.push({
      path: relPath,
      reversePatch,
      afterHash: sha256(after.content),
      beforeHash: sha256(before.content),
      existedBefore: before.exists,
      removedByEdit: before.exists && !after.exists,
      createdByEdit: !before.exists && after.exists,
    });
  }

  /**
   * Records a path-level move (`move_path`, or `delete_path`'s rename into the trash).
   * The entry names the *original* location and where the file now is, so undo renames it
   * back instead of trying to patch a whole directory tree through a content diff.
   * No content hash is taken: a move changes no bytes, and directories have no content to
   * hash.
   */
  recordMove(relFrom: string, relTo: string): void {
    if (!this.current) return;
    if (this.current.entries.some((e) => e.path === relFrom)) return;
    this.current.entries.push({
      path: relFrom,
      reversePatch: "",
      afterHash: "",
      beforeHash: "",
      existedBefore: true,
      removedByEdit: false,
      createdByEdit: false,
      movedTo: relTo,
    });
  }

  /**
   * Persists the open turn. A turn that touched no file produces no checkpoint — an empty
   * one would make `/undo` silently consume a keystroke instead of reverting real work.
   */
  async commitTurn(): Promise<TurnCheckpoint | null> {
    const turn = this.current;
    this.current = null;
    if (!turn || turn.entries.length === 0) return null;

    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(turn.sessionId, turn.turnId), JSON.stringify(turn, null, 2), "utf-8");
    this.prune();
    return turn;
  }

  /** Discard the open turn (e.g. it was interrupted before any write). */
  cancelTurn(): void {
    this.current = null;
  }

  list(sessionId: string): TurnCheckpoint[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: TurnCheckpoint[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json") || !name.startsWith(`${sessionId}__`)) continue;
      const cp = this.read(path.join(this.dir, name));
      if (cp) out.push(cp);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The newest not-yet-undone checkpoint for a session — what `/undo` reverts. */
  latest(sessionId: string): TurnCheckpoint | null {
    return this.list(sessionId).find((c) => !c.undoneAt) ?? null;
  }

  private read(file: string): TurnCheckpoint | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return null;
      return parsed as TurnCheckpoint;
    } catch {
      // A corrupt checkpoint must not take down `/undo`, `/status`, or startup. It is
      // reported by being absent from every listing, and left on disk for a human.
      return null;
    }
  }

  private prune(): void {
    if (!fs.existsSync(this.dir)) return;
    // Per session, not overall: one session working hard must not delete the only undo
    // history another session still has. Ordered by the checkpoint's own `createdAt`,
    // because mtimes collide inside a single millisecond and a test that depends on that
    // is a coin toss.
    const bySession = new Map<string, Array<{ name: string; createdAt: number }>>();
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const cp = this.read(path.join(this.dir, name));
      const session = name.split("__")[0];
      const list = bySession.get(session) ?? [];
      list.push({ name, createdAt: cp?.createdAt ?? 0 });
      bySession.set(session, list);
    }
    for (const list of bySession.values()) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      for (const stale of list.slice(this.keep)) {
        try { fs.unlinkSync(path.join(this.dir, stale.name)); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Revert one turn, newest change first. Each file is checked against the hash the
   * reverse patch expects before anything is written, and files that do not match are
   * reported rather than overwritten.
   *
   * Not all-or-nothing, and deliberately so: rolling back a *successful* restore because a
   * later file conflicted would destroy good work to preserve a lie about atomicity. The
   * outcome lists both halves, which is what the user needs to act on.
   */
  undo(turn: TurnCheckpoint): UndoOutcome {
    const root = this.guard.getWorkspaceRoot();
    const restored: string[] = [];
    const conflicts: Array<{ path: string; reason: string }> = [];

    for (const entry of [...turn.entries].reverse()) {
      const abs = path.resolve(root, entry.path);
      if (!abs.startsWith(root + path.sep)) {
        conflicts.push({ path: entry.path, reason: "checkpoint path escaped the workspace" });
        continue;
      }

      if (entry.movedTo) {
        // A move undoes as a move. Nothing is overwritten: if the original path is occupied
        // again, or the moved file has gone, the entry is refused and explained.
        const movedAbs = path.resolve(root, entry.movedTo);
        if (!movedAbs.startsWith(root + path.sep)) {
          conflicts.push({ path: entry.path, reason: "checkpoint's move target escaped the workspace" });
          continue;
        }
        if (!fs.existsSync(movedAbs)) {
          conflicts.push({ path: entry.path, reason: `${entry.movedTo} no longer exists, so there is nothing to move back` });
          continue;
        }
        if (fs.existsSync(abs)) {
          conflicts.push({ path: entry.path, reason: `${entry.path} exists again — not overwriting what is there now` });
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        try {
          fs.renameSync(movedAbs, abs);
        } catch {
          // Cross-device trash staging (`delete_path` falls back to copy+unlink there), so
          // the rename back can fail exactly where the move out did.
          try {
            if (fs.statSync(movedAbs).isDirectory()) throw new Error("directory");
            fs.copyFileSync(movedAbs, abs);
            fs.unlinkSync(movedAbs);
          } catch {
            conflicts.push({ path: entry.path, reason: `could not move ${entry.movedTo} back to ${entry.path}` });
            continue;
          }
        }
        restored.push(entry.path);
        continue;
      }

      if (entry.createdByEdit) {
        // Undoing a creation is an unlink, not a write of nothing. Refused if the file has
        // since been edited by hand — deleting someone's work is not a revert.
        if (fs.existsSync(abs)) {
          const now = fs.readFileSync(abs, "utf-8");
          if (sha256(now) !== entry.afterHash) {
            conflicts.push({ path: entry.path, reason: "changed since the turn that created it — not deleting" });
            continue;
          }
          fs.rmSync(abs, { force: true });
        }
        restored.push(entry.path);
        continue;
      }

      if (!fs.existsSync(abs)) {
        if (entry.removedByEdit || !entry.existedBefore) {
          // Recreating a deleted file: the reverse patch runs against empty content.
          const rebuilt = applyParsedPatch("", entry.reversePatch, entry.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, rebuilt, "utf-8");
          if (sha256(fs.readFileSync(abs, "utf-8")) !== entry.beforeHash) {
            conflicts.push({ path: entry.path, reason: "restore did not reproduce the original bytes" });
          } else {
            restored.push(entry.path);
          }
          continue;
        }
        conflicts.push({ path: entry.path, reason: "file no longer exists, so the checkpoint cannot revert it" });
        continue;
      }

      const currentContent = fs.readFileSync(abs, "utf-8");
      if (sha256(currentContent) !== entry.afterHash) {
        conflicts.push({
          path: entry.path,
          reason: "file has been edited since this turn — leaving it alone",
        });
        continue;
      }

      const reverted = applyParsedPatch(currentContent, entry.reversePatch, entry.path);
      fs.writeFileSync(abs, reverted, "utf-8");
      const after = fs.readFileSync(abs, "utf-8");
      if (sha256(after) !== entry.beforeHash) {
        // Should be unreachable given Phase 29's round-trip guarantee. If it ever happens,
        // say so out loud instead of leaving a plausible-looking file behind.
        conflicts.push({ path: entry.path, reason: "reverse patch did not reproduce the original bytes" });
        continue;
      }
      restored.push(entry.path);
    }

    const file = this.fileFor(turn.sessionId, turn.turnId);
    if (restored.length > 0 && fs.existsSync(file)) {
      const finished: TurnCheckpoint = { ...turn, undoneAt: Date.now() };
      try { fs.writeFileSync(file, JSON.stringify(finished, null, 2), "utf-8"); } catch { /* status only */ }
    }

    return { turnId: turn.turnId, restored, conflicts, refused: restored.length === 0 };
  }

  /** Total bytes on disk, so `/status` can report the cost instead of guessing. */
  sizeOnDisk(): number {
    if (!fs.existsSync(this.dir)) return 0;
    return fs
      .readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .reduce((sum, n) => sum + fs.statSync(path.join(this.dir, n)).size, 0);
  }
}

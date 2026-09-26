/**
 * The diff engine (backlog Phase 29).
 *
 * Replaces the hand-rolled walk that `computeUnifiedDiff` used to do, which had two
 * separate problems worth being precise about:
 *
 * - It was **quadratic**: `oldLines.slice(i).includes(newLines[j])` allocated a fresh
 *   array and scanned the rest of the file *per line*, so a 10k-line file cost tens of
 *   millions of string comparisons inside a single tool call.
 * - It was **wrong where it mattered**: hunk starts fell back to `?? 1` when a hunk
 *   began with an insertion, so a patch deep in a file claimed to start at line 1, and
 *   no `\ No newline at end of file` marker was ever emitted, so a file whose last line
 *   lost (or gained) its newline produced a diff that described no change at all.
 *
 * What this module guarantees, and what the tests assert:
 *
 * 1. **Validity over minimality.** Output is a syntactically valid unified diff that
 *    `git apply --check` accepts. The edit script is minimal *within* an edit-distance
 *    budget; past the budget it degrades to delete-all/insert-all, which is larger but
 *    still correct — that trade is stated rather than hidden.
 * 2. **Byte fidelity.** `applyParsedPatch(old, patch) === new`, including line endings
 *    and the presence or absence of a final newline.
 * 3. **No silent fuzzy match.** Applying a patch to content it was not generated for is
 *    an error, not a best-effort merge. A tool that writes source cannot guess.
 */

// ─── Line model ───────────────────────────────────────────────────────────────

/**
 * Marker appended to the *last* line of a file that has no trailing newline.
 *
 * Git treats "no final newline" as a property of the line, not of the file, and so must
 * we: without this, `"a\nb"` and `"a\nb\n"` diff to nothing while being different bytes.
 * Encoding it into the comparable string makes a newline-only change a real, visible
 * change and lets the `\ No newline at end of file` marker fall out of the emitter
 * automatically — only a line carrying the marker can be a file's last line.
 */
const NO_NEWLINE = "\u0000\u0000nonl";

export interface SplitContent {
  /** Lines without their terminators; empty for an empty file. */
  lines: string[];
  endsWithNewline: boolean;
}

export function splitContent(content: string): SplitContent {
  if (content === "") return { lines: [], endsWithNewline: false };
  const raw = content.split("\n");
  if (raw[raw.length - 1] === "") {
    raw.pop();
    return { lines: raw, endsWithNewline: true };
  }
  return { lines: raw, endsWithNewline: false };
}

export function joinContent(split: SplitContent): string {
  if (split.lines.length === 0) return "";
  return split.lines.join("\n") + (split.endsWithNewline ? "\n" : "");
}

/** Comparable lines: the file's own endings and newline flag folded in. */
function keyLines(content: string): string[] {
  const { lines, endsWithNewline } = splitContent(content);
  if (lines.length === 0) return [];
  const keyed = lines.slice();
  if (!endsWithNewline) keyed[keyed.length - 1] += NO_NEWLINE;
  return keyed;
}

/** A NUL byte in the first kilobyte is how `git` decides a file is binary; same rule. */
export function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\u0000");
}

// ─── 1. The edit script ───────────────────────────────────────────────────────

export type DiffOpKind = "equal" | "insert" | "delete";

export interface DiffOp {
  kind: DiffOpKind;
  /** The keyed line — may carry the `NO_NEWLINE` marker; strip it before display. */
  line: string;
}

/**
 * How many single-line edits the search will look for before giving up on minimality.
 *
 * The trace costs O(budget) memory, and after the common-prefix/suffix trim real edits
 * are tens of lines, so this is generous in practice and bounded in the worst case.
 * Exceeding it means the two sides are *radically* different, where a minimal script is
 * not what anybody wanted anyway.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * Myers' O(ND) greedy diff, with the standard prefix/suffix trim and a short-circuit for
 * inputs that share no line at all.
 *
 * The trim matters more than it looks: every edit a coding agent makes is local, so the
 * residual this algorithm actually sees is a handful of lines.
 */
export function diffLines(oldContent: string, newContent: string): DiffOp[] {
  const a = keyLines(oldContent);
  const b = keyLines(newContent);

  const ops: DiffOp[] = [];

  // Common prefix / suffix.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length, tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }

  for (let i = 0; i < head; i++) ops.push({ kind: "equal", line: a[i] });

  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  const middle = myersMiddle(midA, midB);
  ops.push(...middle);

  for (let i = tailA; i < a.length; i++) ops.push({ kind: "equal", line: a[i] });

  return ops;
}

/** Diff over already-keyed line ranges that share no common prefix or suffix. */
function myersMiddle(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ kind: "insert" as const, line }));
  if (m === 0) return a.map((line) => ({ kind: "delete" as const, line }));

  // Nothing in common: an exhaustive rewrite. Without this the search below would spend
  // its whole budget proving what this set intersection already says.
  const inB = new Set(b);
  let sharesAny = false;
  for (const line of a) if (inB.has(line)) { sharesAny = true; break; }
  if (!sharesAny) {
    return [
      ...a.map((line) => ({ kind: "delete" as const, line })),
      ...b.map((line) => ({ kind: "insert" as const, line })),
    ];
  }

  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = MAX_EDIT_DISTANCE + 1;
  const width = 2 * MAX_EDIT_DISTANCE + 3;
  const v = new Int32Array(width);
  v[offset + 1] = 0;
  /** `trace[d]` is the furthest-reaching x per diagonal *before* round `d`. */
  const trace: Int32Array[] = [];

  let solvedAt = -1;
  for (let d = 0; d <= limit; d++) {
    // The snapshot must be the state *before* this round — backtracking at level d reads
    // the diagonals that round d-1 produced. Reusing an earlier snapshot looks like an
    // off-by-one nobody would notice until the walk ran off the front of the file.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];              // move down: an insertion
      } else {
        x = v[offset + k - 1] + 1;          // move right: a deletion
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }  // the snake
      v[offset + k] = x;
      if (x >= n && y >= m) { solvedAt = d; break; }
    }
    if (solvedAt >= 0) break;
  }

  if (solvedAt < 0) {
    // Budget exhausted. A valid, non-minimal script beats a lie about minimality.
    return [
      ...a.map((line) => ({ kind: "delete" as const, line })),
      ...b.map((line) => ({ kind: "insert" as const, line })),
    ];
  }

  const ops: DiffOp[] = [];
  let x = n, y = m;
  for (let d = solvedAt; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", line: a[x - 1] });
      x--; y--;
    }
    if (x === prevX) {
      ops.push({ kind: "insert", line: b[y - 1] });
      y--;
    } else {
      ops.push({ kind: "delete", line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "equal", line: a[x - 1] });
    x--; y--;
  }

  ops.reverse();
  return ops;
}

// ─── 2. Hunks and formatting ──────────────────────────────────────────────────

export interface HunkLine {
  kind: DiffOpKind;
  /** Line text with any internal marker already stripped. */
  text: string;
  /** This line is the last line of its file and that file has no trailing newline. */
  noNewline: boolean;
}

export interface Hunk {
  /** 1-based, in the style `@@ -oldStart,oldCount +newStart,newCount @@`. */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
  /** Header text after the `@@` ranges, e.g. a function context line. Empty by default. */
  section: string;
}

/**
 * Group changed lines into hunks, merging changes closer together than the context
 * window so one edit inside another does not print the same lines twice.
 */
export function buildHunks(ops: DiffOp[], contextLines = 3): Hunk[] {
  if (ops.length === 0) return [];

  // Line numbers as each side sees them, so headers can be computed exactly.
  const oldNo: number[] = new Array(ops.length);
  const newNo: number[] = new Array(ops.length);
  let oc = 0, nc = 0;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== "insert") oldNo[i] = ++oc;
    if (ops[i].kind !== "delete") newNo[i] = ++nc;
  }

  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== "equal") changed.push(i);
  if (changed.length === 0) return [];

  // Ranges of op indices to emit, each one a hunk.
  const ranges: Array<[number, number]> = [];
  let groupFirst = changed[0];
  let groupLast = changed[0];
  for (let c = 1; c < changed.length; c++) {
    const gap = changed[c] - groupLast - 1;
    if (gap <= contextLines * 2) {
      groupLast = changed[c];
    } else {
      ranges.push([groupFirst, groupLast]);
      groupFirst = changed[c];
      groupLast = changed[c];
    }
  }
  ranges.push([groupFirst, groupLast]);

  const hunks: Hunk[] = [];
  for (const [first, last] of ranges) {
    const start = Math.max(0, first - contextLines);
    const end = Math.min(ops.length - 1, last + contextLines);
    const lines: HunkLine[] = [];
    let oldCount = 0, newCount = 0;
    for (let i = start; i <= end; i++) {
      const op = ops[i];
      const noNewline = op.line.endsWith(NO_NEWLINE);
      lines.push({
        kind: op.kind,
        text: noNewline ? op.line.slice(0, -NO_NEWLINE.length) : op.line,
        noNewline,
      });
      if (op.kind !== "insert") oldCount++;
      if (op.kind !== "delete") newCount++;
    }

    // Each side's start is the first line it actually contributes; when a side
    // contributes nothing at all (a pure insertion, or a pure deletion) the convention
    // `git apply` expects is the number of the line it goes *after*.
    const firstOld = lines.findIndex((_, idx) => ops[start + idx].kind !== "insert");
    const firstNew = lines.findIndex((_, idx) => ops[start + idx].kind !== "delete");
    const oldStart = oldCount > 0
      ? oldNo[start + firstOld]
      : (start > 0 ? oldNo[start - 1] : 0);
    const newStart = newCount > 0
      ? newNo[start + firstNew]
      : (start > 0 ? newNo[start - 1] : 0);

    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines,
      section: "",
    });
  }
  return hunks;
}

function formatRange(start: number, count: number): string {
  // `@@ -l +l @@` is the canonical short form when the count is 1; `0` counts keep the
  // start, matching what GNU diff and git emit for empty sides.
  return count === 1 ? `${start}` : `${start},${count}`;
}

export interface FormatOptions {
  contextLines?: number;
  /** Override the `--- ` / `+++ ` targets; useful for `/dev/null` on adds and deletes. */
  oldHeader?: string;
  newHeader?: string;
}

/**
 * Render a unified diff for one file. Returns `""` when the contents are identical, and a
 * `Binary files … differ` note rather than a patch for anything containing a NUL byte —
 * an "apply" of that note would then fail loudly, which is the correct outcome.
 */
export function formatUnifiedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  options: FormatOptions = {}
): string {
  if (oldContent === newContent) return "";
  if (looksBinary(oldContent) || looksBinary(newContent)) {
    return `Binary files a/${filePath} and b/${filePath} differ`;
  }

  const ops = diffLines(oldContent, newContent);
  const hunks = buildHunks(ops, options.contextLines ?? 3);
  if (hunks.length === 0) return "";

  const out: string[] = [
    `--- ${options.oldHeader ?? `a/${filePath}`}`,
    `+++ ${options.newHeader ?? `b/${filePath}`}`,
  ];

  for (const h of hunks) {
    out.push(`@@ -${formatRange(h.oldStart, h.oldCount)} +${formatRange(h.newStart, h.newCount)} @@${h.section ? ` ${h.section}` : ""}`);
    for (const l of h.lines) {
      const prefix = l.kind === "insert" ? "+" : l.kind === "delete" ? "-" : " ";
      out.push(prefix + l.text);
      if (l.noNewline) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

// ─── 3. Parsing and applying, fuzz-free ───────────────────────────────────────

export interface ParsedFilePatch {
  /** Path as it appears after the `b/` (or `+++ `) prefix. */
  filePath: string;
  isNewFile: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/**
 * Read a unified diff back into hunks.
 *
 * Tolerant about *decoration* — `diff --git`, `index abc..def`, `similarity index` and
 * mode lines are skipped so a patch produced by real git parses too — and strict about
 * content: a body line that is none of `+ - \space \` is a parse error, never a skip. A
 * silently dropped line is a corrupted patch.
 */
export function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const files: ParsedFilePatch[] = [];
  const lines = patch.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      const oldHeader = line.slice(4).trim();
      const newHeader = (i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) ? lines[i + 1].slice(4).trim() : "";
      i += newHeader ? 2 : 1;

      const filePath = (newHeader && newHeader !== "/dev/null" ? newHeader : oldHeader).replace(/^[ab]\//, "");
      const file: ParsedFilePatch = {
        filePath,
        isNewFile: oldHeader === "/dev/null",
        isDelete: newHeader === "/dev/null",
        hunks: [],
      };

      while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("--- ")) {
        const skip = lines[i];
        if (
          skip.startsWith("diff --git") || skip.startsWith("index ") ||
          skip.startsWith("new file mode") || skip.startsWith("deleted file mode") ||
          skip.startsWith("similarity index") || skip.startsWith("rename ") ||
          skip.startsWith("mode ") || skip === ""
        ) { i++; continue; }
        throw new Error(`Unexpected patch line before first hunk: ${JSON.stringify(skip.slice(0, 80))}`);
      }

      while (i < lines.length && lines[i].startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(lines[i]);
        if (!m) throw new Error(`Malformed hunk header: ${JSON.stringify(lines[i].slice(0, 80))}`);
        const oldStart = Number(m[1]);
        const oldCount = m[2] === undefined ? 1 : Number(m[2]);
        const newStart = Number(m[3]);
        const newCount = m[4] === undefined ? 1 : Number(m[4]);
        i++;

        const hunkLines: HunkLine[] = [];
        let seenOld = 0, seenNew = 0;
        const NO_NL = "\\ No newline at end of file";
        // The marker belongs to the line before it and may therefore arrive *after* the
        // advertised counts are satisfied — dropping it there would silently turn a file
        // that lost its final newline into one that kept it.
        while (i < lines.length && (seenOld < oldCount || seenNew < newCount || lines[i] === NO_NL)) {
          const body = lines[i];
          if (body === NO_NL) {
            if (hunkLines.length === 0) throw new Error("No-newline marker with no preceding line");
            hunkLines[hunkLines.length - 1].noNewline = true;
            i++;
            continue;
          }
          if (body.startsWith("@@ ") || body.startsWith("--- ") || body.startsWith("diff --git")) {
            throw new Error("Hunk ended before its advertised line counts were read");
          }
          if (body === "") {
            // A blank context line is `" "` + `""`, never `""` alone — so an empty string
            // here can only be the artifact of a patch that stopped early. Saying "empty
            // line is malformed" would send someone hunting for a bad line that is not there.
            throw new Error(
              `Hunk ended before its advertised line counts were read (${oldCount} old / ${newCount} new) ` +
              `— the patch appears truncated.`
            );
          }
          const marker = body[0];
          if (marker === " ") { hunkLines.push({ kind: "equal", text: body.slice(1), noNewline: false }); seenOld++; seenNew++; }
          else if (marker === "-") { hunkLines.push({ kind: "delete", text: body.slice(1), noNewline: false }); seenOld++; }
          else if (marker === "+") { hunkLines.push({ kind: "insert", text: body.slice(1), noNewline: false }); seenNew++; }
          else throw new Error(`Malformed hunk body line: ${JSON.stringify(body.slice(0, 80))}`);
          i++;
        }
        if (seenOld !== oldCount || seenNew !== newCount) {
          throw new Error(
            `Hunk header promises ${oldCount} old / ${newCount} new line(s) but the body has ` +
            `${seenOld} / ${seenNew} — the patch is truncated or corrupt.`
          );
        }
        file.hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines, section: m[5] ?? "" });
      }

      files.push(file);
      continue;
    }

    if (line.startsWith("Binary files ")) {
      throw new Error(`Refusing to apply a binary-file patch entry: ${line.slice(0, 120)}`);
    }
    i++;
  }

  return files;
}

/**
 * Apply one file's patch to content, exactly. There is no fuzz factor and no offset
 * search: either the advertised context matches at the advertised place or this throws.
 *
 * The tempting alternative — "slide the hunk around until the context fits" — is how a
 * patch meant for line 40 lands on line 400 of a file the model has since restructured,
 * and the tool then reports success. A refusal is correctable; a wrong write is not.
 */
export function applyParsedPatch(oldContent: string, patchText: string, filePath?: string): string {
  const parsed = parseUnifiedPatch(patchText);
  const target = filePath
    ? parsed.find((f) => f.filePath === filePath || f.filePath.endsWith(`/${filePath}`) || filePath.endsWith(f.filePath))
    : parsed[0];
  if (!target) {
    throw new Error(
      `Patch contains no entry for ${filePath ? `"${filePath}"` : "the requested file"} ` +
      `(has: ${parsed.map((f) => f.filePath).join(", ") || "nothing parsed"})`
    );
  }
  if (target.isDelete) return "";

  const keyed = keyLines(oldContent);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of target.hunks) {
    const oldSide = hunk.lines.filter((l) => l.kind !== "insert");
    // `@@ -0,0 +1,n @@` is a new file. A zero-count old side names the line it inserts
    // *after*, so the insertion point is one past it; otherwise the hunk starts at the
    // line it names.
    const at = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (at < cursor || at > keyed.length) {
      throw new Error(
        `Hunk anchored at old line ${hunk.oldStart} lands at offset ${at} of a ` +
        `${keyed.length}-line file, past or overlapping the previous hunk (cursor ${cursor}) — ` +
        `hunks must be ordered and non-overlapping.`
      );
    }
    for (let k = 0; k < oldSide.length; k++) {
      const want = oldSide[k].text + (oldSide[k].noNewline ? NO_NEWLINE : "");
      const have = keyed[at + k];
      if (have === undefined) {
        throw new Error(
          `Hunk expects line ${at + k + 1} of a ${keyed.length}-line file — the patch does not ` +
          `belong to this content`
        );
      }
      if (have !== want) {
        throw new Error(
          `Context mismatch at line ${at + k + 1}:\n  expected ${JSON.stringify(want)}\n  found    ${JSON.stringify(have)}\n` +
          `Re-read the file and produce a patch against its current content — fuzzy matching is ` +
          `deliberately not available here.`
        );
      }
    }
    for (let k = cursor; k < at; k++) result.push(keyed[k]);
    for (const l of hunk.lines) {
      if (l.kind === "delete") continue;
      result.push(l.text + (l.noNewline ? NO_NEWLINE : ""));
    }
    cursor = at + oldSide.length;
  }
  for (let k = cursor; k < keyed.length; k++) result.push(keyed[k]);

  // Re-derive the trailing-newline flag from the marker, which may now sit on a different
  // line than it did before.
  const endsWithNewline = result.length === 0 ? false : !result[result.length - 1].endsWith(NO_NEWLINE);
  const cleaned = result.map((l) => (l.endsWith(NO_NEWLINE) ? l.slice(0, -NO_NEWLINE.length) : l));
  return joinContent({ lines: cleaned, endsWithNewline });
}

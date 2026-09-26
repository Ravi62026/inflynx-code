/**
 * Backlog Phase 29 — the diff engine.
 *
 * The old `computeUnifiedDiff` was quadratic and wrong in two specific ways (a `?? 1`
 * hunk-start fallback, no `\ No newline at end of file`). "Looks like a diff" is not the
 * property here; the properties are:
 *
 *   - `git apply --check` accepts it, and `git apply` reproduces the new bytes exactly
 *   - `applyParsedPatch(old, patch) === new` for every case, including newline flips
 *   - patching content it was not made for fails loudly instead of approximating
 *
 * so most of these tests go through the real `git` binary or assert byte equality. A
 * hand-checked diff that git refuses is a diff that does not exist.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyParsedPatch,
  buildHunks,
  computeUnifiedDiff,
  diffLines,
  formatUnifiedPatch,
  parseUnifiedPatch,
  splitContent,
  joinContent,
} from "../../packages/patch-engine/src/index.js";

/** Run `git` in `cwd`, with an identity so commits/apply never ask a terminal. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", [
    "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false",
    ...args,
  ], { cwd, encoding: "utf-8" });
}

/**
 * The arbiter: write `old`, apply the engine's patch with real git, compare bytes with
 * `new`. Also exercised in reverse for git-authored patches.
 */
function assertGitApplies(old: string, newContent: string, label: string): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-gitapply-"));
  try {
    git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, "f.ts"), old, "utf-8");
    const patch = formatUnifiedPatch("f.ts", old, newContent);
    assert.ok(patch.length > 0, `${label}: engine produced no patch for differing content`);
    fs.writeFileSync(path.join(root, "change.patch"), patch, "utf-8");

    try {
      git(root, ["apply", "--check", "change.patch"]);
    } catch {
      throw new Error(
        `git apply --check REJECTED the patch for "${label}":\n${patch}\n` +
        `--- git said ---\n${(() => { try { git(root, ["apply", "--verbose", "change.patch"]); return ""; } catch (e: any) { return String(e.stderr || e.message); } })()}`
      );
    }
    git(root, ["apply", "change.patch"]);
    const got = fs.readFileSync(path.join(root, "f.ts"), "utf-8");
    assert.equal(got, newContent, `git applied the patch for "${label}" to different bytes`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Deterministic PRNG so a failure is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function runDiffEngineTests(): Promise<void> {
  console.log("🧪 Running Phase 29 Diff Engine Tests...\n");

  // ── Test 1: the line model preserves exactly what the file said ─────────────
  {
    assert.deepEqual(splitContent(""), { lines: [], endsWithNewline: false });
    assert.deepEqual(splitContent("\n"), { lines: [""], endsWithNewline: true });
    assert.deepEqual(splitContent("a\nb"), { lines: ["a", "b"], endsWithNewline: false });
    assert.deepEqual(splitContent("a\nb\n"), { lines: ["a", "b"], endsWithNewline: true });
    // The property, not the cases: every string round-trips through the splitter.
    for (const s of ["", "\n", "a", "a\n", "a\n\n", "a\nb", "a\r\nb\r\n", "x\n\n\ny"]) {
      const back = joinContent(splitContent(s));
      assert.equal(back, s, `line model lost bytes for ${JSON.stringify(s)}`);
    }
    console.log("✓ Test 1 Passed: split/join is byte-exact, including empty and CRLF files.");
  }

  // ── Test 2: the edit script itself, and the trim that keeps it cheap ────────
  {
    const kinds = (a: string, b: string) =>
      diffLines(a, b).map((o) => (o.kind === "equal" ? "=" : o.kind === "insert" ? "+" : "-")).join("");
    // "eq" pairs, "-" deletes, "+" inserts, in order.
    assert.equal(kinds("a\nb\nc\n", "a\nb\nc\n"), "===");
    assert.equal(kinds("a\nb\nc\n", "a\nX\nc\n"), "=-+=");
    assert.equal(kinds("a\nb\n", "a\nb\nc\n"), "==+");
    assert.equal(kinds("a\nb\nc\n", "a\n"), "=--");
    assert.equal(kinds("", "a\n"), "+");
    assert.equal(kinds("a\n", ""), "-");

    // A moved block must not be reported as a rewrite of the whole file: the old
    // greedy walk could not tell the difference.
    const ops = diffLines("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n9\n10\n3\n4\n5\n6\n7\n8\n");
    const touched = ops.filter((o) => o.kind !== "equal").length;
    assert.ok(touched < ops.length, `the edit script rewrote everything it saw (${touched}/${ops.length})`);
    console.log("✓ Test 2 Passed: edit scripts are minimal on the small cases, not whole-file rewrites.");
  }

  // ── Test 3: hunk headers, which is where the old code lied ─────────────────
  {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const changed = lines.slice();
    changed[29] = "CHANGED";
    const patch = formatUnifiedPatch("f.ts", lines.join("\n") + "\n", changed.join("\n") + "\n");

    // `?? 1` was the old fallback: a hunk whose leading context was insertion-only
    // reported line 1 no matter where it actually was.
    assert.ok(patch.includes("@@ -27,7 +27,7 @@"), `wrong hunk header:\n${patch}`);
    assert.ok(!patch.includes("@@ -1,"), "hunk claims to start at line 1 for an edit at line 30");

    // Two far-apart edits → two hunks. Two nearby ones → one merged hunk, because
    // duplicating context is how a patch becomes unreadable.
    const two = formatUnifiedPatch("f.ts", lines.join("\n") + "\n",
      (() => { const c = lines.slice(); c[2] = "A"; c[35] = "B"; return c.join("\n") + "\n"; })());
    assert.equal((two.match(/^@@ /gm) || []).length, 2, `two distant edits did not make two hunks:\n${two}`);

    const near = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const merged = formatUnifiedPatch("f.ts", near.join("\n") + "\n",
      (() => { const c = near.slice(); c[3] = "A"; c[8] = "B"; return c.join("\n") + "\n"; })());
    assert.equal((merged.match(/^@@ /gm) || []).length, 1, `5 unchanged lines should have merged the hunks:\n${merged}`);

    // A pure insertion in the middle names the line it goes after, with a zero old count.
    const h = buildHunks(diffLines("a\nb\nc\n", "a\nNEW\nb\nc\n"), 3);
    assert.equal(h.length, 1);
    assert.deepEqual(
      { os: h[0].oldStart, oc: h[0].oldCount, ns: h[0].newStart, nc: h[0].newCount },
      { os: 1, oc: 3, ns: 1, nc: 4 },
      "the surrounding context should have carried the insertion"
    );
    const bare = buildHunks([{ kind: "insert", line: "NEW" }, { kind: "equal", line: "a" }], 0);
    assert.deepEqual({ os: bare[0].oldStart, oc: bare[0].oldCount }, { os: 0, oc: 0 },
      "a zero-context pure insertion must advertise -0,0 to match git");
    console.log("✓ Test 3 Passed: hunk starts/counts are real, distant hunks split, near ones merge.");
  }

  // ── Test 4: quadratic cost is gone, measured ───────────────────────────────
  {
    const big = Array.from({ length: 20_000 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    const edited = big.replace("const v1000 = 1000;", "const v1000 = 1000; // touched");

    const t0 = Date.now();
    const patch = formatUnifiedPatch("big.ts", big, edited);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, `a one-line edit in a 20k-line file took ${ms}ms`);
    assert.equal((patch.match(/^@@ /gm) || []).length, 1, "a one-line edit should be one small hunk");
    // 2 headers + 1 hunk line + 3 context + delete + insert + 3 context = 11. Anything
    // larger means the engine is dumping the file instead of the change.
    assert.equal(patch.trimEnd().split("\n").length, 11, `unexpected patch size:\n${patch}`);

    // The case the old `slice(i).includes(...)` scan died on: a file of repeated lines,
    // where every step re-scanned the remainder looking for the next match.
    const repetitive = "x\n".repeat(20_000);
    const t1 = Date.now();
    const p2 = formatUnifiedPatch("rep.ts", repetitive, repetitive + "y\n");
    const ms2 = Date.now() - t1;
    assert.ok(ms2 < 200, `repeated-line input took ${ms2}ms — the quadratic path is still reachable`);
    assert.ok(p2.includes("+y"), "appending to a run of identical lines was not reported");
    // The case the audit called quadratic and it turns out to be — many differing lines,
    // not a one-line edit (which the old greedy walk handled fine). Measured old vs new:
    // 8k lines with nothing in common cost 131ms before, single-digit ms now.
    const A = Array.from({ length: 8000 }, (_, i) => `alpha${i}`).join("\n") + "\n";
    const B = Array.from({ length: 8000 }, (_, i) => `beta${i}`).join("\n") + "\n";
    const t2 = Date.now();
    const p3 = formatUnifiedPatch("rw.ts", A, B);
    const ms3 = Date.now() - t2;
    assert.ok(ms3 < 100, `a total rewrite of 8k lines took ${ms3}ms`);
    assert.equal((p3.match(/^-alpha/gm) || []).length, 8000, "total rewrite did not delete every old line");
    assert.equal((p3.match(/^\+beta/gm) || []).length, 8000, "total rewrite did not add every new line");
    console.log(`✓ Test 4 Passed: 20k-line edits in ${ms}ms / ${ms2}ms; 8k-line total rewrite in ${ms3}ms.`);
  }

  // ── Test 5: git accepts it, and applies it to the exact bytes ──────────────
  {
    const cases: Array<[string, string, string]> = [
      ["local edit", "a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nX\ne\nf\ng\nh\n"],
      ["insert at top", "a\nb\nc\n", "NEW\na\nb\nc\n"],
      ["insert at end", "a\nb\nc\n", "a\nb\nc\nNEW\n"],
      ["delete to empty", "a\nb\n", "\n"],
      ["multi hunk", Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n",
        (() => { const c = Array.from({ length: 30 }, (_, i) => `l${i}`); c[1] = "A"; c[25] = "B"; return c.join("\n") + "\n"; })()],
      ["old had no final newline", "a\nb", "a\nb\n"],
      ["new has no final newline", "a\nb\n", "a\nb"],
      ["neither has one", "a\nb", "a\nc"],
      ["both hunks no-newline", "a\nb\nc", "a\nB\nc"],
      ["CRLF file", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
      ["blank line run", "a\n\n\n\nb\n", "a\n\nb\n"],
      ["every other line", "1\n2\n3\n4\n5\n6\n", "1\nx\n3\nx\n5\nx\n"],
    ];
    for (const [label, oldC, newC] of cases) {
      // Terminate the patch with a newline. Without it `git apply` reports
      // "corrupt patch" at the last line — which is what every patch the previous engine
      // produced looked like to git, for every shape of edit.
      assert.ok(formatUnifiedPatch("f.ts", oldC, newC).endsWith("\n"), `${label}: patch has no final newline`);
      assertGitApplies(oldC, newC, label);
    }
    console.log(`✓ Test 5 Passed: ${cases.length} shapes, all newline-terminated, accepted by real \`git apply\`, byte-exact.`);
  }

  // ── Test 6: the other direction — git's own patches apply here ────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-gitgen-"));
    try {
      git(root, ["init", "-q"]);
      const old = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n") + "\n";
      fs.writeFileSync(path.join(root, "f.ts"), old, "utf-8");
      git(root, ["add", "f.ts"]);
      git(root, ["commit", "-q", "-m", "base"]);

      const next = old.replace("line5\n", "line5\ninserted\n").replace("line30\n", "REWRITTEN\n");
      fs.writeFileSync(path.join(root, "f.ts"), next, "utf-8");
      const gitPatch = git(root, ["diff", "--unified=3", "--", "f.ts"]);
      assert.ok(gitPatch.includes("@@"), "git produced no hunk to test against");

      // Header decoration (`diff --git`, `index abc..def`) must be skipped, not parsed as
      // content; and the body must survive intact.
      const parsed = parseUnifiedPatch(gitPatch);
      assert.equal(parsed.length, 1, "a single-file git diff did not parse as one file");
      assert.equal(parsed[0].filePath, "f.ts", `wrong path taken from git's header: ${parsed[0].filePath}`);
      const applied = applyParsedPatch(old, gitPatch, "f.ts");
      assert.equal(applied, next, "the engine cannot apply a patch that git wrote");

      // And the engine's own patch for the same change is what git would accept.
      assertGitApplies(old, next, "same content git diffed");
      console.log("✓ Test 6 Passed: parses and applies a git-authored diff, decoration lines and all.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 7: fuzz-free by construction ──────────────────────────────────────
  {
    const old = "alpha\nbeta\ngamma\ndelta\n";
    const patch = formatUnifiedPatch("f.ts", old, "alpha\nBETA\ngamma\ndelta\n");

    // Content the patch was not made for must be refused, not half-applied.
    assert.throws(
      () => applyParsedPatch("alpha\nsomething\nelse\nentirely\n", patch, "f.ts"),
      /Context mismatch at line 2/,
      "a patch was applied to content it does not describe"
    );
    // A file too short for the hunk is a different error, and must say so.
    assert.throws(
      () => applyParsedPatch("alpha\n", patch, "f.ts"),
      /expects line 2 of a 1-line file|Context mismatch/,
      "running off the end of the file was not reported"
    );

    // Truncated / malformed bodies are parse errors. A silently dropped line is a
    // corrupted patch, and the caller would never know.
    const truncated = patch.split("\n").slice(0, 5).join("\n") + "\n";
    assert.throws(() => parseUnifiedPatch(truncated), /promised|truncated|corrupt/i, "a truncated hunk parsed cleanly");
    assert.throws(
      () => parseUnifiedPatch("--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n?what is this\n"),
      /Malformed hunk body line/
    );
    assert.throws(() => parseUnifiedPatch("--- a/f.ts\n+++ b/f.ts\n@@ -abc +def @@\n x\n"), /Malformed hunk header/);

    // Out-of-order hunks: the second hunk listed first must not be quietly tolerated.
    const base = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n";
    const twoHunks = formatUnifiedPatch("f.ts", base,
      (() => { const c = Array.from({ length: 40 }, (_, i) => `l${i}`); c[3] = "B"; c[30] = "A"; return c.join("\n") + "\n"; })());
    const parsed = parseUnifiedPatch(twoHunks);
    assert.equal(parsed[0].hunks.length, 2, "two distant edits did not produce two parseable hunks");
    const render = (h: (typeof parsed)[0]["hunks"][number]) =>
      `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n` +
      h.lines.map((l) => (l.kind === "insert" ? "+" : l.kind === "delete" ? "-" : " ") + l.text).join("\n");
    const [h1, h2] = parsed[0].hunks;
    const reversed = `--- a/f.ts\n+++ b/f.ts\n${render(h2)}\n${render(h1)}\n`;
    assert.throws(
      () => applyParsedPatch(base, reversed, "f.ts"),
      /Context mismatch|ordered and non-overlapping/,
      "hunks applied out of order were not refused"
    );
    // And the ordered form does apply — otherwise the assertion above proves nothing.
    assert.equal(applyParsedPatch(base, twoHunks, "f.ts"),
      (() => { const c = Array.from({ length: 40 }, (_, i) => `l${i}`); c[3] = "B"; c[30] = "A"; return c.join("\n") + "\n"; })(),
      "the correctly-ordered patch did not apply, so the refusal test is vacuous");
    console.log("✓ Test 7 Passed: wrong content, truncation, bad markers and bad order all refuse loudly.");
  }

  // ── Test 8: binary content says so instead of diffing bytes ────────────────
  {
    const withNul = "alpha\n\u0000beta\n";
    const patch = formatUnifiedPatch("f.bin", withNul, "alpha\n\u0000changed\n");
    assert.match(patch, /^Binary files a\/f\.bin and b\/f\.bin differ$/, `binary content was diffed: ${JSON.stringify(patch)}`);
    assert.throws(() => applyParsedPatch(withNul, patch, "f.bin"), /binary-file patch entry/i);
    assert.equal(formatUnifiedPatch("f.ts", "same\n", "same\n"), "", "identical content produced a patch");
    console.log("✓ Test 8 Passed: NUL bytes yield a 'Binary files differ' note that refuses to apply.");
  }

  // ── Test 9: the round-trip property, over generated content ───────────────
  {
    const rnd = makeRandom(20260926);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
    let applied = 0;
    for (let caseNo = 0; caseNo < 400; caseNo++) {
      const lineCount = 1 + Math.floor(rnd() * 40);
      const mk = () => `word${Math.floor(rnd() * 8)}`;
      const oldLines = Array.from({ length: lineCount }, mk);
      const newLines = oldLines.slice();
      const edits = 1 + Math.floor(rnd() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rnd() * (newLines.length + 1));
        const what = rnd();
        if (what < 0.34 && newLines.length) newLines.splice(at, 1);
        else if (what < 0.67) newLines.splice(at, 0, mk());
        else if (newLines.length) newLines[at % newLines.length] = mk();
      }
      const withNewline = (ls: string[]) => (ls.length === 0 ? "" : ls.join("\n") + (rnd() < 0.5 ? "\n" : ""));
      const oldC = withNewline(oldLines);
      const newC = withNewline(newLines);
      if (oldC === newC) continue;

      const patch = formatUnifiedPatch("gen.txt", oldC, newC);
      assert.notEqual(patch, "", `case ${caseNo}: differing content produced no patch`);
      const got = applyParsedPatch(oldC, patch, "gen.txt");
      assert.equal(got, newC, `case ${caseNo} lost fidelity\n--- patch ---\n${patch}`);
      applied++;

      // Sample a few through real git too, so the property test and the interop test
      // cover the same generator rather than two different worlds.
      if (caseNo % 50 === 0) assertGitApplies(oldC, newC, `generated case ${caseNo}`);
    }
    assert.ok(applied > 250, `only ${applied} generated cases were exercised — the generator is broken`);
    console.log(`✓ Test 9 Passed: ${applied} generated edit scenarios round-trip byte-exactly (8 through git).`);
  }

  // ── Test 10: what the product actually calls ──────────────────────────────
  {
    // `computeUnifiedDiff` is what `tool-runtime` and the CLI preview call. It must keep
    // its shape: header lines for the UI, `""` when nothing changed.
    const out = computeUnifiedDiff("math.ts", "export function f() {\n  return 1;\n}\n", "export function f() {\n  return 2;\n}\n");
    assert.ok(out.startsWith("--- a/math.ts\n+++ b/math.ts\n"), `preview header changed shape:\n${out}`);
    assert.ok(out.includes("-  return 1;") && out.includes("+  return 2;"), `diff lost the change:\n${out}`);
    assert.equal(computeUnifiedDiff("x.ts", "same\n", "same\n"), "");
    // Context is a parameter, not a constant: the approval UI wants 3, a wide diff view 10.
    const wide = computeUnifiedDiff("x.ts", Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n",
      (() => { const c = Array.from({ length: 30 }, (_, i) => `l${i}`); c[15] = "X"; return c.join("\n") + "\n"; })(), 10);
    assert.equal((wide.match(/^ /gm) || []).length, 20, "contextLines was ignored");
    console.log("✓ Test 10 Passed: computeUnifiedDiff keeps its contract and honours contextLines.");
  }

  console.log("\n🎉 All Phase 29 Diff Engine Tests Passed 100%!");
}

runDiffEngineTests().catch((err) => {
  console.error("Diff engine test failed:", err);
  process.exit(1);
});

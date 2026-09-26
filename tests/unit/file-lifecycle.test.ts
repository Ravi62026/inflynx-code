/**
 * Backlog Phase 22 — file lifecycle tools and session-scoped execution.
 *
 * Covers the three new tools, the session-isolation property the phase is graded on
 * ("two concurrent sessions in different roots cannot see each other's files"), and
 * the gateway argument-coverage hole that `move_path` would otherwise have walked
 * straight into: any path-shaped argument the gateway does not know about is never
 * canonicalised, never boundary-checked, and invisible to the [plan] mode fence.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CORE_TOOLS,
  ToolRegistry,
  globToRegExp,
  MAX_GLOB_RESULTS,
  TRASH_RELATIVE_PATH,
} from "../../packages/tool-runtime/src/index.js";
import { ToolExecutionGateway } from "../../packages/tool-runtime/src/ToolExecutionGateway.js";
import { HnswVectorStore } from "../../packages/vector-store/src/HnswVectorStore.js";

function write(root: string, rel: string, content = "x"): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

async function runFileLifecycleTests(): Promise<void> {
  console.log("🗂️  Running Phase 22 File Lifecycle & Session Scoping Tests...\n");

  const registry = new ToolRegistry(CORE_TOOLS);

  // ── Test 1: glob_files finds by pattern and is honest about what it skipped ──
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-glob-"));
    try {
      write(root, "src/a.test.ts", "1");
      write(root, "src/deep/nested/b.test.ts", "2");
      write(root, "src/index.ts", "3");
      write(root, "README.md", "4");
      write(root, "node_modules/hidden.test.ts", "5");
      write(root, ".git/objects/x.test.ts", "6");

      const gw = new ToolExecutionGateway(root);
      const run = (args: Record<string, unknown>, id = "g1") =>
        gw.executeGuarded(registry, { id, name: "glob_files", args }, { activeMode: "agent", sessionId: "glob-sess" });

      const tests = await run({ pattern: "*.test.ts" });
      assert.ok(tests.output.includes("src/a.test.ts"), `basename glob missed: ${tests.output}`);
      assert.ok(tests.output.includes("b.test.ts"), "`**`-less pattern missed a nested file");
      assert.ok(!tests.output.includes("hidden.test.ts"), "node_modules was searched");
      assert.ok(!/objects/.test(tests.output), ".git was searched");
      assert.ok(
        /node_modules, \.git, dist/.test(tests.output) === false,
        "no-hit messaging appeared where there were hits"
      );

      const scoped = await run({ pattern: "src/*.test.ts" });
      assert.ok(scoped.output.includes("a.test.ts"), "single-segment glob failed");
      assert.ok(!scoped.output.includes("b.test.ts"), "src/* matched a deeper path");

      const all = await run({ pattern: "**/*.ts" });
      assert.ok(all.output.includes("index.ts") && all.output.includes("b.test.ts"), "recursive glob failed");

      const none = await run({ pattern: "*.nope" });
      assert.ok(
        /never searched/.test(none.output) && /absence here is not evidence/.test(none.output),
        `a zero-result search did not disclaim build directories: ${none.output}`
      );

      // Newest first, so "what did I just touch" is answerable.
      fs.writeFileSync(path.join(root, "src/fresh.test.ts"), "new");
      const sorted = await run({ pattern: "*.test.ts" });
      const firstLine = sorted.output.split("\n")[0];
      assert.ok(
        firstLine.includes("fresh.test.ts"),
        `results are not mtime-ordered, first line was: ${firstLine}`
      );

      // The cap must announce itself with a way to narrow.
      for (let i = 0; i < MAX_GLOB_RESULTS + 30; i++) write(root, `many/f${i}.txt`);
      const capped = await run({ pattern: "many/*.txt" });
      assert.ok(/more matching file\(s\) not shown/.test(capped.output), "result cap was silent");
      assert.ok(/Narrow the pattern/.test(capped.output), "the cap gives no way forward");

      // Empty pattern is a caller bug, reported as one.
      const empty = await run({ pattern: "  " });
      assert.equal(empty.isError, true, "an empty pattern was accepted");
      console.log("✓ Test 1 Passed: glob matching, ignore policy, mtime order, and a self-announced cap.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 2: glob translation, including the characters that break naive ones ──
  {
    const matches = (glob: string, target: string) =>
      globToRegExp(glob).test(target.split(path.sep).join("/"));

    assert.ok(matches("*.ts", "index.ts"), "*.ts missed a root file");
    assert.ok(matches("*.ts", "src/deep/index.ts"), "*.ts missed a nested basename");
    assert.ok(!matches("*.ts", "index.tsx"), "*.ts matched a .tsx");
    assert.ok(matches("src/**/*.test.ts", "src/a/b/c.test.ts"), "**/ did not cross directories");
    assert.ok(matches("src/**/x.ts", "src/x.ts"), "**/ did not match zero directories");
    assert.ok(!matches("src/*.ts", "src/a/b.ts"), "single * crossed a directory");
    assert.ok(matches("?.ts", "a.ts"), "? failed");
    assert.ok(!matches("?.ts", "ab.ts"), "? matched two chars");
    assert.ok(matches("**/*.{test,spec}.ts", "x/y.z.test.ts"), "{a,b} alternation failed");
    assert.ok(matches("**/*.{test,spec}.ts", "y.spec.ts"), "{a,b} alternation failed (basename)");
    // Untrusted filename characters must not blow up the matcher or match everything.
    assert.ok(matches("a[weird].ts", "a[weird].ts"), "bracketed literal filename broke the matcher");
    assert.ok(!matches("a[weird].ts", "aw.ts"), "brackets became a char class");
    assert.ok(!matches("*.ts", "TS"), "case handling changed unexpectedly");
    console.log("✓ Test 2 Passed: 12 glob translation cases, including literal [ ] and { } names.");
  }

  // ── Test 3: delete_path is a recoverable move, not an rm ────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-del-"));
    try {
      const gw = new ToolExecutionGateway(root);
      const del = (args: Record<string, unknown>, id = "d1") =>
        gw.executeGuarded(registry, { id, name: "delete_path", args }, { activeMode: "agent", sessionId: "del-sess" });

      const victim = write(root, "src/gone.ts", "content to lose");
      write(root, "src/keep.ts", "stays");

      const deleted = await del({ path: "src/gone.ts" });
      assert.notEqual(deleted.isError, true, `delete failed: ${deleted.output}`);
      assert.ok(!fs.existsSync(victim), "delete_path did not remove it from the workspace");
      assert.ok(/moved to the trash/.test(deleted.output), "the output does not say what happened");
      assert.ok(/recoverable at:/.test(deleted.output), "the output gives no recovery path");

      const trashRoot = path.join(root, TRASH_RELATIVE_PATH, "del-sess");
      const stashed = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
      assert.equal(stashed.length, 1, `expected one trashed entry, got ${stashed.length}`);
      assert.equal(
        fs.readFileSync(path.join(trashRoot, stashed[0]), "utf-8"),
        "content to lose",
        "the trashed copy is not the original content"
      );

      // …and it really is restorable with move_path.
      const restored = await gw.executeGuarded(
        registry,
        { id: "m1", name: "move_path", args: { from: path.join(TRASH_RELATIVE_PATH, "del-sess", stashed[0]), to: "src/gone.ts" } },
        { activeMode: "agent", sessionId: "del-sess" }
      );
      assert.equal(restored.isError, false, `restore failed: ${restored.output}`);
      assert.equal(fs.readFileSync(victim, "utf-8"), "content to lose", "restore did not put the bytes back");

      // Directories move whole — no recursive delete primitive exists here at all.
      write(root, "src/mod/a.ts");
      write(root, "src/mod/deep/b.ts");
      const delDir = await del({ path: "src/mod" }, "d2");
      assert.equal(delDir.isError, false, `directory delete failed: ${delDir.output}`);
      assert.ok(!fs.existsSync(path.join(root, "src/mod")), "directory still present");
      const dirStash = fs.readdirSync(trashRoot).filter((n) => n.includes("_mod"));
      assert.equal(dirStash.length, 1, "the directory was not preserved as a unit");
      assert.ok(
        fs.existsSync(path.join(trashRoot, dirStash[0], "deep/b.ts")),
        "nested contents lost during the move to trash"
      );

      // Refusals, each with nothing destroyed.
      const refused = [
        { args: { path: "." }, why: "the workspace root itself" },
        { args: { path: ".git/config" }, why: ".git" },
        { args: { path: TRASH_RELATIVE_PATH }, why: "the trash" },
        { args: { path: "not-here.ts" }, why: "a missing path" },
      ];
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      write(root, ".git/config", "keep me");
      for (const c of refused) {
        const res = await del(c.args, `r_${c.why.length}`);
        assert.equal(res.isError, true, `delete_path allowed ${c.why}`);
      }
      assert.equal(fs.readFileSync(path.join(root, ".git/config"), "utf-8"), "keep me", ".git was touched");
      assert.ok(fs.existsSync(path.join(root, "src/keep.ts")), "an unrelated file vanished");
      console.log("✓ Test 3 Passed: delete = rename to trash, verified byte-for-byte, plus 4 refusals.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 4: move_path cannot silently replace work ───────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-mv-"));
    try {
      const gw = new ToolExecutionGateway(root);
      const mv = (args: Record<string, unknown>, id = "m0") =>
        gw.executeGuarded(registry, { id, name: "move_path", args }, { activeMode: "agent", sessionId: "mv-sess" });

      write(root, "old/name.ts", "moved body");
      const renamed = await mv({ from: "old/name.ts", to: "new/name.ts" });
      assert.equal(renamed.isError, false, `rename failed: ${renamed.output}`);
      assert.equal(fs.readFileSync(path.join(root, "new/name.ts"), "utf-8"), "moved body");
      assert.ok(!fs.existsSync(path.join(root, "old/name.ts")), "the source survived the move");

      // mv-into-a-directory semantics
      write(root, "loose.ts", "loose body");
      fs.mkdirSync(path.join(root, "folder"), { recursive: true });
      const folded = await mv({ from: "loose.ts", to: "folder" }, "m2");
      assert.equal(folded.isError, false, `move into a dir failed: ${folded.output}`);
      assert.ok(fs.existsSync(path.join(root, "folder/loose.ts")), "did not land inside the folder");

      // Clobber protection, and the replaced file is recoverable rather than gone.
      write(root, "src/x.ts", "new work");
      write(root, "src/y.ts", "OLD WORK MUST NOT VANISH");
      const clobber = await mv({ from: "src/x.ts", to: "src/y.ts" }, "m3");
      assert.equal(clobber.isError, true, "an existing destination was overwritten silently");
      assert.equal(
        fs.readFileSync(path.join(root, "src/y.ts"), "utf-8"),
        "OLD WORK MUST NOT VANISH",
        "the refused move still changed the target"
      );
      assert.ok(fs.existsSync(path.join(root, "src/x.ts")), "the refused move moved the source anyway");

      const forced = await mv({ from: "src/x.ts", to: "src/y.ts", overwrite: true }, "m4");
      assert.equal(forced.isError, false, `explicit overwrite failed: ${forced.output}`);
      assert.equal(fs.readFileSync(path.join(root, "src/y.ts"), "utf-8"), "new work");
      assert.ok(/replaced file kept at/.test(forced.output), "the replaced file's whereabouts are not reported");
      const stash = path.join(root, TRASH_RELATIVE_PATH, "mv-sess");
      const displaced = fs.readdirSync(stash).filter((n) => n.includes("replaced_y.ts"));
      assert.equal(displaced.length, 1, "overwrite:true destroyed the previous target");
      assert.equal(
        fs.readFileSync(path.join(stash, displaced[0]), "utf-8"),
        "OLD WORK MUST NOT VANISH"
      );

      for (const c of [
        { args: { from: "nope.ts", to: "elsewhere.ts" }, why: "a missing source" },
        { args: { from: "same.ts", to: "same.ts" }, why: "a self-move" },
        { args: { from: "dir", to: "dir/sub" }, why: "a directory into itself" },
        { args: { from: "src/y.ts", to: TRASH_RELATIVE_PATH }, why: "a move into the trash" },
      ]) {
        write(root, "same.ts", "s");
        fs.mkdirSync(path.join(root, "dir/sub"), { recursive: true });
        const res = await mv(c.args, `mv_${c.why.length}`);
        assert.equal(res.isError, true, `move_path allowed ${c.why}`);
      }
      console.log("✓ Test 4 Passed: rename, into-dir, clobber refusal, recoverable overwrite, 4 refusals.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: two sessions, two roots, no visibility between them ─────────────
  {
    const alpha = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-alpha-"));
    const beta = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-beta-"));
    try {
      write(alpha, "alpha-secret.txt", "only in alpha");
      write(beta, "beta-secret.txt", "only in beta");

      const gwAlpha = new ToolExecutionGateway(alpha);
      const gwBeta = new ToolExecutionGateway(beta);

      const readOwn = await gwAlpha.executeGuarded(
        registry, { id: "i1", name: "read_file", args: { path: "alpha-secret.txt" } },
        { activeMode: "agent", sessionId: "sess-alpha" }
      );
      assert.ok(readOwn.output.includes("only in alpha"), "a session cannot read its own workspace");

      const readOther = await gwAlpha.executeGuarded(
        registry, { id: "i2", name: "read_file", args: { path: path.join(beta, "beta-secret.txt") } },
        { activeMode: "agent", sessionId: "sess-alpha" }
      );
      assert.equal(readOther.isError, true, "session alpha read a file from session beta's root");
      assert.ok(!readOther.output.includes("only in beta"), "the foreign content leaked into the error");

      // Glob and the new lifecycle tools are scoped the same way.
      const globOther = await gwAlpha.executeGuarded(
        registry, { id: "i3", name: "glob_files", args: { pattern: "*.txt", path: beta } },
        { activeMode: "agent", sessionId: "sess-alpha" }
      );
      assert.equal(globOther.isError, true, "glob_files reached outside the session root");
      const deleteOther = await gwAlpha.executeGuarded(
        registry, { id: "i4", name: "delete_path", args: { path: path.join(beta, "beta-secret.txt") } },
        { activeMode: "agent", sessionId: "sess-alpha" }
      );
      assert.equal(deleteOther.isError, true, "delete_path removed a file outside the session root");
      assert.ok(fs.existsSync(path.join(beta, "beta-secret.txt")), "the foreign file was actually destroyed");

      const moveOut = await gwAlpha.executeGuarded(
        registry, { id: "i5", name: "move_path", args: { from: "alpha-secret.txt", to: path.join(beta, "stolen.txt") } },
        { activeMode: "agent", sessionId: "sess-alpha" }
      );
      assert.equal(moveOut.isError, true, "move_path exfiltrated a file into another session's root");
      assert.ok(fs.existsSync(path.join(alpha, "alpha-secret.txt")), "the source moved despite the refusal");

      // Relative escapes must not be a second, luckier path.
      for (const attempt of ["../%s/beta-secret.txt".replace("%s", path.basename(beta)), "./../../etc/passwd"]) {
        const res = await gwAlpha.executeGuarded(
          registry, { id: `esc_${attempt.length}`, name: "read_file", args: { path: attempt } },
          { activeMode: "agent", sessionId: "sess-alpha" }
        );
        assert.equal(res.isError, true, `relative escape succeeded: ${attempt}`);
      }
      console.log("✓ Test 5 Passed: read, glob, delete and move are all confined to the session root.");
    } finally {
      fs.rmSync(alpha, { recursive: true, force: true });
      fs.rmSync(beta, { recursive: true, force: true });
    }
  }

  // ── Test 6: path-shaped arguments are guarded, or [plan] fencing is a sieve ───
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-pathkeys-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-outside-"));
    try {
      write(root, "inside.ts", "in");
      write(outside, "outside.ts", "out");
      const gw = new ToolExecutionGateway(root);

      // `from`/`to` must go through the guard. If they are not in the gateway's
      // path-key list they are never canonicalised — and then the [plan] fence,
      // which only inspects resolved values, cannot see them at all.
      const planMoveOut = await gw.executeGuarded(
        registry, { id: "p1", name: "move_path", args: { from: "inside.ts", to: path.join(outside, "escaped.ts") } },
        { activeMode: "plan", sessionId: "pk-sess" }
      );
      assert.equal(planMoveOut.isError, true, "plan mode moved a file outside .inflynx/");
      assert.ok(!fs.existsSync(path.join(outside, "escaped.ts")), "the refused move still wrote outside");

      const planDelete = await gw.executeGuarded(
        registry, { id: "p2", name: "delete_path", args: { path: "inside.ts" } },
        { activeMode: "plan", sessionId: "pk-sess" }
      );
      assert.equal(planDelete.isError, true, "plan mode deleted a source file");
      assert.ok(fs.existsSync(path.join(root, "inside.ts")), "plan-mode delete destroyed the file anyway");

      // The fence must not become a blanket ban on the mode's own purpose: moving a
      // draft inside .inflynx/ is exactly what [plan] is for.
      write(root, ".inflynx/a.md", "plan draft");
      const planMoveWithinPlanDir = await gw.executeGuarded(
        registry, { id: "p3", name: "move_path", args: { from: path.join(".inflynx", "a.md"), to: path.join(".inflynx", "b.md") } },
        { activeMode: "plan", sessionId: "pk-sess" }
      );
      assert.equal(
        planMoveWithinPlanDir.isError, false,
        `the plan fence blocks .inflynx/ writes for move_path too: ${planMoveWithinPlanDir.output}`
      );
      assert.ok(
        fs.existsSync(path.join(root, ".inflynx/b.md")),
        "the plan-scoped move was reported fine but did not happen"
      );
      console.log("✓ Test 6 Passed: from/to are guard-resolved, so [plan] fencing covers them (and .inflynx still works).");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  // ── Test 7: declarations that other layers silently depend on ───────────────
  {
    const byName = new Map(CORE_TOOLS.map((t) => [t.name, t]));
    for (const name of ["glob_files", "delete_path", "move_path"]) {
      assert.ok(byName.has(name), `${name} is not in CORE_TOOLS`);
    }
    assert.equal(byName.get("glob_files")!.permissionLevel, "readonly", "glob_files is not readonly");
    assert.equal(byName.get("glob_files")!.isMutating, false, "glob_files claims to mutate");
    assert.equal(byName.get("glob_files")!.cacheable, true, "glob_files cannot be cached");
    for (const name of ["delete_path", "move_path"]) {
      const tool = byName.get(name)!;
      // Not cosmetic: `isMutating` is what routes the call to the approval handler,
      // what the [plan] fence keys on, and what clears the gateway's read cache.
      assert.equal(tool.isMutating, true, `${name} must be mutating or it skips approval and cache invalidation`);
      assert.equal(tool.permissionLevel, "readwrite", `${name} must not be readonly`);
    }
    // Every path-shaped argument these tools take must be one the gateway resolves.
    const gatewayResolved = ["path", "filePath", "targetFile", "target_file", "cwd", "dirPath",
      "from", "to", "source", "destination", "old_path", "new_path", "oldPath", "newPath",
      "target_path", "targetPath", "file", "dir"];
    const missed: string[] = [];
    for (const tool of CORE_TOOLS) {
      for (const key of Object.keys(tool.parameters.properties)) {
        const looksLikePath = /(^(path|file|dir|cwd)$|_path$|Path$|^from$|^to$|File$)/.test(key);
        if (looksLikePath && !gatewayResolved.includes(key)) missed.push(`${tool.name}.${key}`);
      }
    }
    assert.deepEqual(missed, [], `path-shaped args the gateway would ignore: ${missed.join(", ")}`);
    console.log(`✓ Test 7 Passed: flags are wired for approval/fencing/caching, and ${CORE_TOOLS.length} tools' path args are all guarded.`);
  }

  // ── Test 8: no silent cwd fallback left in session-scoped state ─────────────
  {
    assert.throws(
      () => new HnswVectorStore("" as never),
      /explicit workspaceRoot; there is no cwd fallback/,
      "HnswVectorStore still accepts a missing root"
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-vstore-"));
    try {
      new HnswVectorStore(root).addChunk({
        id: "c1", filePath: "a.ts", chunkType: "file", content: "hello", embedding: [1, 0],
      } as never);
      assert.ok(
        fs.existsSync(path.join(root, ".inflynx", "vector_store.json")),
        "the index did not land under the given root"
      );
      assert.ok(
        !fs.existsSync(path.join(process.cwd(), ".inflynx", "vector_store.json.tmp")),
        "sanity: nothing extra was written to the repo"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("✓ Test 8 Passed: the vector store can no longer write into an accidental cwd.");
  }

  console.log("\n🎉 All Phase 22 File Lifecycle & Session Scoping Tests Passed 100%!");
}

runFileLifecycleTests().catch((err) => {
  console.error("File lifecycle test failed:", err);
  process.exit(1);
});

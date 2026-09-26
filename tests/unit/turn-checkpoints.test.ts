/**
 * Backlog Phase 30 — turn checkpoints, `/undo`, and real multi-file atomicity.
 *
 * Two things that looked finished were not. `commit()` claimed atomicity but renamed in a
 * loop with no undo, so a conflict on file 2 of 3 left file 1 changed while the error said
 * the transaction had failed — and it never re-checked that the file it was about to
 * overwrite was still the file it had read (backlog F3, F4). And `EditTransactionManager`
 * was constructed per tool call, so nothing about a *turn* was reversible: no pre-image
 * survived the write (F2).
 *
 * Everything here is asserted against bytes on disk, because "the tool said it restored it"
 * is the same class of claim this repo has been spending a phase at a time removing.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  EditTransactionManager,
  TurnCheckpointStore,
  computeUnifiedDiff,
} from "../../packages/patch-engine/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");

/** A store whose checkpoint dir lives inside `root`, sharing its canonical guard. */
function storeFor(root: string, retainTurns?: number): TurnCheckpointStore {
  return new TurnCheckpointStore(root, { retainTurns });
}

async function runCheckpointTests(): Promise<void> {
  console.log("🧪 Running Phase 30 Turn Checkpoint & Undo Tests...\n");

  // ── Test 1: the phase's "Done when", literally ─────────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-atomic-"));
    try {
      const tx = new EditTransactionManager(root);
      write(root, "a.ts", "A1\nA2\n");
      write(root, "b.ts", "B1\nB2\n");
      write(root, "c.ts", "C1\nC2\n");

      tx.stageFileWrite("a.ts", "A1 changed\nA2\n");
      tx.stageFileWrite("b.ts", "B1 changed\nB2\n");
      tx.stageFileWrite("c.ts", "C1 changed\nC2\n");

      // A human edits file 2 after the batch was staged.
      const before = { a: read(root, "a.ts"), b: read(root, "b.ts"), c: read(root, "c.ts") };
      write(root, "b.ts", "B1 written by a person while we were staging\nB2\n");

      assert.throws(() => tx.commit(), /changed on disk after it was staged|aborted before writing/,
        "a concurrent edit was silently overwritten (backlog F4)");

      assert.equal(read(root, "a.ts"), before.a, "file 1 was written even though the transaction failed");
      assert.equal(read(root, "b.ts"), "B1 written by a person while we were staging\nB2\n",
        "the human's edit was clobbered");
      assert.equal(read(root, "c.ts"), before.c, "file 3 was written even though the transaction failed");
      // No debris: the temporaries never became files.
      assert.deepEqual(fs.readdirSync(root).sort(), ["a.ts", "b.ts", "c.ts"], `commit left debris: ${fs.readdirSync(root)}`);
      console.log("✓ Test 1 Passed: a 3-file batch that conflicts on file 2 writes none of them.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 2: existence changed too, not just content ────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-exist-"));
    try {
      const guard = root;
      write(root, "gone.ts", "x\n");
      const tx1 = new EditTransactionManager(guard);
      tx1.stageFileWrite("gone.ts", "y\n");
      fs.rmSync(path.join(root, "gone.ts"));
      assert.throws(() => tx1.commit(), /was deleted after it was staged/,
        "a deletion after staging was treated as an overwrite of nothing");

      // Mirror case: staging a *new* file, which someone else then creates.
      const tx2 = new EditTransactionManager(guard);
      tx2.stageFileWrite("brand-new.ts", "ours\n");
      write(root, "brand-new.ts", "theirs\n");
      assert.throws(() => tx2.commit(), /created by someone else after it was staged/,
        "a newly created file was overwritten without a word");
      assert.equal(read(root, "brand-new.ts"), "theirs\n", "the refusal still wrote the file");
      console.log("✓ Test 2 Passed: vanished and appeared-since-staging are both refused, both named.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 3: a turn's pre-image is the *first* one, and one entry per file ──
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-t1-"));
    try {
      const store = storeFor(root);
      store.beginTurn("s1", "t1", "write three drafts");
      const record = (rel: string, before: string | null, after: string) => {
        store.recordEdit(rel,
          { content: before ?? "", exists: before !== null },
          { content: after, exists: true });
      };
      record("note.md", null, "v1\n");
      record("note.md", "v1\n", "v2\n");   // same turn, same file — must be ignored
      record("other.md", "old\n", "new\n");
      const cp = await store.commitTurn();

      assert.ok(cp, "a turn that wrote files produced no checkpoint");
      assert.equal(cp!.entries.length, 2, `expected one entry per file, got ${cp!.entries.length}`);
      assert.deepEqual(cp!.entries.map((e) => e.path).sort(), ["note.md", "other.md"]);
      // The undoable state is "before the turn", not "before the last write in it".
      assert.ok(cp!.entries.find((e) => e.path === "note.md")!.createdByEdit, "v1 creation was not recorded");
      // The reverse patch turns `after` back into `before`, so it *adds* the pre-turn line.
      const otherEntry = cp!.entries.find((e) => e.path === "other.md")!;
      assert.ok(otherEntry.reversePatch.includes("+old"),
        `the reverse patch does not put the pre-turn content back:\n${otherEntry.reversePatch}`);
      assert.ok(otherEntry.reversePatch.includes("-new"),
        `the reverse patch does not remove the turn's content:\n${otherEntry.reversePatch}`);
      console.log("✓ Test 3 Passed: one entry per file, holding the pre-turn state rather than the last one.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 4: byte-for-byte restore, endings and all ─────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-bytes-"));
    try {
      const store = storeFor(root);
      // CRLF file, a no-trailing-newline file, and an empty one: the three ways a naive
      // line-based restore gets the bytes wrong.
      const originals: Record<string, string> = {
        "crlf.ts": "alpha\r\nbeta\r\ngamma\r\n",
        "no-nl.ts": "one\ntwo",
        "empty.ts": "",
      };
      for (const [rel, content] of Object.entries(originals)) write(root, rel, content);

      store.beginTurn("s", "turn-bytes", "rewrite three files");
      for (const [rel, before] of Object.entries(originals)) {
        const after = before.replace(/alpha|one|^$/, "CHANGED");
        write(root, rel, after);
        store.recordEdit(rel, { content: before, exists: true }, { content: after, exists: true });
      }
      await store.commitTurn();

      const outcome = store.undo(store.latest("s")!);
      assert.equal(outcome.conflicts.length, 0, `undo refused: ${JSON.stringify(outcome.conflicts)}`);
      for (const [rel, original] of Object.entries(originals)) {
        assert.equal(read(root, rel), original, `${rel} was not restored byte-for-byte`);
      }
      console.log("✓ Test 4 Passed: CRLF, missing-final-newline and empty files restore byte-exactly.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: work done by someone else is never overwritten ─────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-clash-"));
    try {
      const store = storeFor(root);
      write(root, "mine.ts", "before\n");
      write(root, "theirs.ts", "before\n");
      store.beginTurn("s", "turn-clash", "edit two files");
      for (const rel of ["mine.ts", "theirs.ts"]) {
        write(root, rel, "after\n");
        store.recordEdit(rel, { content: "before\n", exists: true }, { content: "after\n", exists: true });
      }
      await store.commitTurn();

      // A person edits one of the two after the turn landed.
      write(root, "theirs.ts", "after\n// plus a human comment\n");

      const outcome = store.undo(store.latest("s")!);
      assert.deepEqual(outcome.restored, ["mine.ts"], `restored set wrong: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.conflicts.length, 1);
      assert.match(outcome.conflicts[0].reason, /edited since this turn/);
      assert.equal(read(root, "mine.ts"), "before\n", "the restorable file was not restored");
      assert.equal(read(root, "theirs.ts"), "after\n// plus a human comment\n",
        "a human edit was overwritten by /undo — the one thing it must not do");
      console.log("✓ Test 5 Passed: one file reverted, the human-edited one left alone and reported.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 6: creates unlink; deletes and moves go back where they were ─────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-moves-"));
    try {
      const store = storeFor(root);

      // (a) created file must be removed, not emptied
      write(root, "generated.ts", "content\n");
      store.beginTurn("s", "turn-create", "generated a file");
      store.recordEdit("generated.ts", { content: "", exists: false }, { content: "content\n", exists: true });
      await store.commitTurn();
      let o = store.undo(store.latest("s")!);
      assert.equal(o.restored.length, 1, JSON.stringify(o.conflicts));
      assert.ok(!fs.existsSync(path.join(root, "generated.ts")), "undo left an empty file where a creation was undone");

      // (b) a directory moved into the trash comes back whole
      fs.mkdirSync(path.join(root, "pkg", "sub"), { recursive: true });
      write(root, "pkg/sub/keep.ts", "safe\n");
      store.beginTurn("s", "turn-delete", "deleted a directory");
      store.recordMove("pkg", ".inflynx/.trash/s/123_pkg");
      fs.mkdirSync(path.join(root, ".inflynx/.trash/s"), { recursive: true });
      fs.renameSync(path.join(root, "pkg"), path.join(root, ".inflynx/.trash/s/123_pkg"));
      await store.commitTurn();
      o = store.undo(store.latest("s")!);
      assert.equal(o.conflicts.length, 0, JSON.stringify(o.conflicts));
      assert.equal(read(root, "pkg/sub/keep.ts"), "safe\n", "a directory undo lost its contents");
      assert.ok(!fs.existsSync(path.join(root, ".inflynx/.trash/s/123_pkg")), "the trash copy is still there after undo");

      // (c) an overwrite-move restores both sides, in the right order.
      // Post-turn state: `src.txt` is gone, `dst.txt` holds the moved content, and the
      // file it displaced is sitting in the trash under a generated name.
      write(root, "dst.txt", "moved\n");
      write(root, ".inflynx/.trash/s/999_displaced.txt", "displaced original\n");
      store.beginTurn("s", "turn-move", "moved over an existing file");
      store.recordMove("dst.txt", ".inflynx/.trash/s/999_displaced.txt");
      store.recordMove("src.txt", "dst.txt");
      await store.commitTurn();
      assert.ok(!fs.existsSync(path.join(root, "src.txt")), "the fixture should have no src.txt");
      o = store.undo(store.latest("s")!);
      assert.equal(o.conflicts.length, 0, JSON.stringify(o.conflicts));
      assert.equal(read(root, "src.txt"), "moved\n", "the moved file did not come back");
      assert.equal(read(root, "dst.txt"), "displaced original\n", "the displaced file did not come back");
      assert.ok(!fs.existsSync(path.join(root, ".inflynx/.trash/s/999_displaced.txt")),
        "the trash copy survived a completed undo");
      console.log("✓ Test 6 Passed: creates unlink, a trashed directory returns whole, overwrite-moves restore both sides.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 7: retention, and one session cannot evict another's history ──────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-keep-"));
    try {
      const store = storeFor(root, 3);
      for (let i = 0; i < 7; i++) {
        store.beginTurn("busy", `t${i}`, `turn ${i}`);
        store.recordEdit(`f${i}.ts`, { content: "a\n", exists: true }, { content: "b\n", exists: true });
        await store.commitTurn();
        // Distinct createdAt, because ordering is by the checkpoint's own timestamp.
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.equal(store.list("busy").length, 3, "retention did not cap a busy session");
      assert.deepEqual(store.list("busy").map((c) => c.turnId), ["t6", "t5", "t4"],
        "the wrong turns survived");

      store.beginTurn("quiet", "q1", "one edit");
      store.recordEdit("quiet.ts", { content: "a\n", exists: true }, { content: "b\n", exists: true });
      await store.commitTurn();
      for (let i = 0; i < 9; i++) {
        store.beginTurn("busy", `x${i}`, `turn ${i}`);
        store.recordEdit(`g${i}.ts`, { content: "a\n", exists: true }, { content: "b\n", exists: true });
        await store.commitTurn();
      }
      assert.equal(store.list("quiet").length, 1, "a busy session evicted another session's only undo point");
      assert.ok(store.sizeOnDisk() > 0, "sizeOnDisk reported nothing while checkpoints exist");
      console.log("✓ Test 7 Passed: retention caps per session; one session's churn evicts none of another's.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 8: an empty turn produces no checkpoint, and undo is marked ───────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-empty-"));
    try {
      const store = storeFor(root);
      store.beginTurn("s", "empty-turn", "just a question");
      assert.equal(await store.commitTurn(), null, "a turn that wrote nothing created a checkpoint");
      assert.equal(store.list("s").length, 0, "an empty checkpoint reached /undo's history");

      write(root, "one.ts", "before\n");
      store.beginTurn("s", "real-turn", "edited one file");
      write(root, "one.ts", "after\n");
      store.recordEdit("one.ts", { content: "before\n", exists: true }, { content: "after\n", exists: true });
      await store.commitTurn();
      const undone = store.undo(store.latest("s")!);
      assert.equal(undone.restored.length, 1, `nothing was restored, so this proves nothing: ${JSON.stringify(undone)}`);
      assert.equal(store.latest("s"), null, "an undone checkpoint can be undone twice");
      assert.equal(store.list("s")[0].undoneAt ? true : false, true, "the undone mark was not persisted");
      console.log("✓ Test 8 Passed: no-op turns are not checkpointed, and an undone turn cannot be undone again.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 9: through a real turn — the tool wrote it, /undo takes it back ───
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-loop-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      write(root, "app.ts", "export const v = 1;\n");
      const sse = (lines: string[]) => new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); } }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const toolCall = (name: string, args: Record<string, unknown>) => sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]",
      ]);
      const textResponse = (t: string) => sse([
        JSON.stringify({ choices: [{ delta: { content: t } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]",
      ]);

      let request = 0;
      (globalThis as any).fetch = async () => {
        request++;
        if (request === 1) return toolCall("write_file", { path: "app.ts", content: "export const v = 2;\n" });
        return textResponse("done");
      };

      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,
        "low",
        new LocalJsonSessionStore(root) as never
      );
      const turn = await orchestrator.runTurn("bump the version");

      assert.equal(read(root, "app.ts"), "export const v = 2;\n", "the tool call did not write the file");
      assert.ok(turn.turnId?.startsWith("turn_"), `no turnId on the result: ${turn.turnId}`);
      assert.deepEqual(turn.checkpointFiles, ["app.ts"], `checkpoint files: ${JSON.stringify(turn.checkpointFiles)}`);

      const listed = orchestrator.listCheckpoints();
      assert.equal(listed.length, 1, "the turn is not in /undo's history");
      assert.deepEqual(listed[0].files, ["app.ts"]);
      // The label is a prompt excerpt and it is written to disk, so it must be redacted.
      assert.match(listed[0].label, /bump the version/);

      const undone = orchestrator.undoLastTurn();
      assert.ok(undone, "undoLastTurn found nothing to undo");
      assert.deepEqual(undone!.restored, ["app.ts"], JSON.stringify(undone));
      assert.equal(read(root, "app.ts"), "export const v = 1;\n", "the turn was not reverted on disk");
      assert.equal(orchestrator.undoLastTurn(), null, "a second /undo did something after the history was empty");

      // The model is told, in-session, that the files it reasoned about are gone.
      const told = (orchestrator as any).context.history.some(
        (m: any) => m.role === "user" && /\/undo reverted the previous turn/.test(m.content)
      );
      assert.ok(told, "the revert was invisible to the continuing conversation");
      console.log("✓ Test 9 Passed: a real turn checkpoints, and /undo through the orchestrator restores the bytes.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 10: a corrupt or foreign checkpoint is inert, not fatal ──────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-corrupt-"));
    try {
      const store = storeFor(root);
      write(root, "safe.ts", "before\n");
      store.beginTurn("s", "good", "one edit");
      store.recordEdit("safe.ts", { content: "before\n", exists: true }, { content: "after\n", exists: true });
      await store.commitTurn();

      const dir = path.join(root, ".inflynx", "checkpoints");
      fs.writeFileSync(path.join(dir, "s__garbage.json"), "{ not json", "utf-8");
      fs.writeFileSync(path.join(dir, "other__t.json"), JSON.stringify({
        sessionId: "other", turnId: "t", createdAt: 1, label: "l",
        entries: [{ path: "../../../outside.escape.ts", reversePatch: "", afterHash: "", beforeHash: "", existedBefore: false, removedByEdit: false, createdByEdit: true }],
      }), "utf-8");

      assert.deepEqual(store.list("s").map((c) => c.turnId), ["good"], "a corrupt checkpoint file was not skipped");
      assert.equal(store.latest("s")!.turnId, "good");
      // The escaping path is refused per-entry rather than written outside the workspace.
      const other = store.list("other");
      assert.equal(other.length, 1, "the foreign session's checkpoint was not listed under its own id");
      const o = store.undo(other[0]);
      assert.equal(o.restored.length, 0, "a checkpoint escaped the workspace root during undo");
      assert.ok(!fs.existsSync(path.join(root, "..", "outside.escape.ts")), "a file was written outside the workspace");
      console.log("✓ Test 10 Passed: unreadable checkpoints are skipped, and an escaping path is refused at undo.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("\n🎉 All Phase 30 Turn Checkpoint & Undo Tests Passed 100%!");
}

runCheckpointTests().catch((err) => {
  console.error("Checkpoint test failed:", err);
  process.exit(1);
});

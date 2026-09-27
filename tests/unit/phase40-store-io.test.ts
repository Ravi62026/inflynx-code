/**
 * Backlog Phase 40 — LocalJson performance + honesty.
 *
 * The Done-when is two concrete properties, both asserted against the filesystem here:
 *  - a 100-message turn writes < 2 MB total (it used to `writeFileSync` the ENTIRE store
 *    after every message — megabytes per message), and
 *  - a process killed mid-write leaves a readable store (the journal skips a torn final
 *    line instead of failing).
 * Plus the H3 honesty rule (a failed write throws, it is not swallowed) and the one-off
 * migration off the old single-file layout.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { LocalJsonSessionStore } from "../../packages/session-store/src/LocalJsonSessionStore.js";
import { cleanupOnExit } from "../helpers/tmp.js";

function workspace(): string {
  return cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-store40-")));
}

async function run() {
  console.log("🧪 Running Phase 40 store performance & honesty tests...\n");

  // ── Test 1: 100 messages write < 2MB total (append, not full rewrite) ────
  {
    const root = workspace();
    const store = new LocalJsonSessionStore(root);
    const s = await store.createSession("/x", "openai", "gpt-4o");

    const realAppend = fs.appendFileSync;
    const realWrite = fs.writeFileSync;
    let bytesWritten = 0;
    (fs as any).appendFileSync = (...args: any[]) => { bytesWritten += String(args[1]).length; return (realAppend as any)(...args); };
    (fs as any).writeFileSync = (...args: any[]) => { bytesWritten += String(args[1] ?? "").length; return (realWrite as any)(...args); };
    try {
      const payload = "x".repeat(500);
      for (let i = 0; i < 100; i++) await store.saveMessage(s.sessionId, { role: "user", content: payload });
    } finally {
      (fs as any).appendFileSync = realAppend;
      (fs as any).writeFileSync = realWrite;
    }
    // 100 × ~550-byte appends ≈ ~55–150 KB. A full-file rewrite would be megabytes
    // (sum of the growing blob), so even a generous ceiling proves the append path.
    assert.ok(bytesWritten < 2_000_000, `100-message turn wrote ${(bytesWritten / 1e6).toFixed(2)} MB (should be < 2 MB)`);
    assert.ok(bytesWritten < 400_000, `writes look like full rewrites, not appends (${bytesWritten} bytes)`);
    console.log(`✓ Test 1 Passed: 100 messages wrote ${(bytesWritten / 1024).toFixed(0)} KB total (append-only).`);
  }

  // ── Test 2: a torn final line (crash mid-append) leaves a readable store ──
  {
    const root = workspace();
    const store = new LocalJsonSessionStore(root);
    const s = await store.createSession("/x", "openai", "gpt-4o");
    for (let i = 0; i < 3; i++) await store.saveMessage(s.sessionId, { role: "user", content: `good-${i}` });

    // Simulate a kill halfway through a fourth append: a partial line with no newline.
    const file = path.join(root, ".inflynx", "sessions", `${s.sessionId}.jsonl`);
    fs.appendFileSync(file, '{"kind":"message","message":{"id":"msg_x","sessionId":"');

    // Fresh instance = re-read from disk. The 3 complete messages survive; the torn tail is skipped.
    const reopened = new LocalJsonSessionStore(root);
    const h = await reopened.getSessionHydration(s.sessionId);
    assert.ok(h, "a store with a torn final line refused to hydrate at all");
    assert.equal(h!.messages.length, 3, `expected the 3 intact messages, got ${h!.messages.length}`);
    assert.deepEqual(h!.messages.map((m) => m.content), ["good-0", "good-1", "good-2"]);
    // A subsequent append must still work (the torn line is only tolerated at the tail).
    await reopened.saveMessage(s.sessionId, { role: "user", content: "after" });
    assert.ok(new LocalJsonSessionStore(root).getSessionHydration(s.sessionId));
    console.log("✓ Test 2 Passed: a mid-write crash costs at most the last line, not the store.");
  }

  // ── Test 3: a failed write throws — it is not console.error-and-swallowed (H3) ─
  {
    const root = workspace();
    const store = new LocalJsonSessionStore(root);
    const s = await store.createSession("/x", "openai", "gpt-4o");
    const realAppend = fs.appendFileSync;
    (fs as any).appendFileSync = () => { throw Object.assign(new Error("ENOSPC no space"), { code: "ENOSPC" }); };
    let threw = false;
    try { await store.saveMessage(s.sessionId, { role: "user", content: "must-fail" }); }
    catch { threw = true; }
    finally { (fs as any).appendFileSync = realAppend; }
    assert.ok(threw, "a write failure was swallowed instead of thrown (H3)");
    console.log("✓ Test 3 Passed: a write failure propagates instead of a silent in-memory lie.");
  }

  // ── Test 4: legacy single-file store migrates once, and is preserved ──────
  {
    const root = workspace();
    const inflynx = path.join(root, ".inflynx");
    fs.mkdirSync(inflynx, { recursive: true });
    fs.writeFileSync(path.join(inflynx, "session_store.json"), JSON.stringify({
      sessions: { session_old: { sessionId: "session_old", cwd: "/old", createdAt: 1, updatedAt: 2, provider: "openai", model: "gpt-4o", activeMode: "agent", effortLevel: "low", title: "legacy", status: "active" } },
      messages: { session_old: [{ id: "m1", sessionId: "session_old", role: "user", content: "from-legacy", timestamp: 1 }] },
      toolExecutions: { session_old: [] },
      telemetry: { session_old: { sessionId: "session_old", promptTokens: 5, completionTokens: 2, reasoningTokens: 0, estimatedCostUsd: 0, updatedAt: 1 } },
    }), "utf-8");

    const migrated = new LocalJsonSessionStore(root);
    const h = await migrated.getSessionHydration("session_old");
    assert.ok(h, "the legacy session did not migrate");
    assert.equal(h!.messages[0].content, "from-legacy");
    assert.equal(h!.telemetry.promptTokens, 5);
    assert.ok(!fs.existsSync(path.join(inflynx, "session_store.json")), "the old file was left where a second load would double-read it");
    assert.ok(fs.existsSync(path.join(inflynx, "session_store.json.migrated")), "the old file was deleted instead of preserved for recovery");
    console.log("✓ Test 4 Passed: the 159-session-style legacy file migrates once and is kept as .migrated.");
  }

  // ── Test 5: reopen re-reads from disk (persistence, not just memory) ──────
  {
    const root = workspace();
    const a = new LocalJsonSessionStore(root);
    const s = await a.createSession("/x", "openai", "gpt-4o");
    await a.saveMessage(s.sessionId, { role: "user", content: "durable" });
    await a.updateSessionStatus(s.sessionId, "completed");
    const b = new LocalJsonSessionStore(root);
    const h = await b.getSessionHydration(s.sessionId);
    assert.equal(h!.messages[0].content, "durable", "a message did not survive the process");
    assert.equal(h!.session.status, "completed", "the last-writer-wins session record did not survive");
    console.log("✓ Test 5 Passed: messages and the superseding status record survive a reopen.");
  }

  console.log("\n🎉 All Phase 40 store performance & honesty tests passed.");
}
run().catch((e) => { console.error("Phase 40 failed:", e); process.exit(1); });

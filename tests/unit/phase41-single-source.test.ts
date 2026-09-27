/**
 * Phase 41 — single source of truth per session (no dual-write)
 *
 * A session lives on exactly ONE backend. When Postgres dies mid-session, the old store sent
 * the NEXT message to the JSON fallback while earlier ones stayed in Postgres — the transcript
 * forked. Now a session pinned to Postgres raises SessionDegradedError instead of forking, and
 * only brand-new sessions may start on the fallback.
 *
 * Uses an injected fake primary so this runs without a real database. The kill-Postgres-
 * mid-session *integration* reconcile test needs a live DB (CI-only).
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ResilientSessionStore, LocalJsonSessionStore, SessionDegradedError } from "../../packages/session-store/src/index.js";
import type { SessionStore, SessionRecord, SessionHydration, StoredMessage } from "../../packages/session-store/src/types.js";
import { cleanupOnExit } from "../helpers/tmp.js";

console.log("=== Phase 41: single source of truth ===");

function makeFakePrimary(): SessionStore & { down: boolean; saved: string[] } {
  const sessions = new Map<string, any>();
  const msgs = new Map<string, number>();
  const fake: any = {
    down: false,
    saved: [] as string[],
    err() { return Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" }); },
    async createSession(_cwd: string, _p: string, _m: string, _a?: string, _e?: string, _t?: string, sessionId?: string) {
      if (fake.down) throw fake.err();
      const id = sessionId || `primary_${sessions.size + 1}`;
      const now = Date.now();
      const rec = { sessionId: id, cwd: "/x", provider: "p", model: "m", status: "active", createdAt: now, updatedAt: now };
      sessions.set(id, rec);
      return rec;
    },
    async saveMessage(sessionId: string, m: any) {
      if (fake.down) throw fake.err();
      if (!sessions.has(sessionId)) throw new Error("no such session on primary");
      fake.saved.push(sessionId);
      msgs.set(sessionId, (msgs.get(sessionId) || 0) + 1);
      return { id: "x", sessionId, timestamp: Date.now(), role: m.role, content: m.content };
    },
    async getSessionHydration(sessionId: string) {
      if (fake.down) throw fake.err();
      const s = sessions.get(sessionId);
      if (!s) return null;
      return { session: s, messages: [], toolExecutions: [], telemetry: { sessionId, promptTokens: 0, completionTokens: 0, totalCostCents: 0, updatedAt: Date.now() } };
    },
    async listSessions() { if (fake.down) throw fake.err(); return [...sessions.values()]; },
    async updateSessionStatus() { if (fake.down) throw fake.err(); },
    async deleteSession(id: string) { if (fake.down) throw fake.err(); return sessions.delete(id); },
    async archiveSession() { if (fake.down) throw fake.err(); },
    async close() {},
  };
  // Stub the remaining interface methods so the cast is honest enough for these tests.
  for (const name of ["saveToolExecution", "updateTokenTelemetry", "updateSessionModelConfig"]) {
    fake[name] = async () => { if (fake.down) throw fake.err(); };
  }
  return fake as SessionStore & { down: boolean; saved: string[] };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase41-"));
  cleanupOnExit(root);
  const primary = makeFakePrimary();
  const fallback = new LocalJsonSessionStore(root);
  const store = new ResilientSessionStore("postgres://unused", root, { primary, fallback });

  // 1 --- A session created on the primary is pinned there; after primary dies, writes do NOT
  //       silently fork to the fallback — they surface as degraded.
  {
    const rec = await store.createSession("/x", "p", "m", undefined, undefined, "S1", "s_primary");
    await store.saveMessage("s_primary", { role: "user", content: "one" });
    assert.deepEqual(primary.saved, ["s_primary"], "first write reached the primary");

    primary.down = true;
    let caught: unknown;
    try { await store.saveMessage("s_primary", { role: "user", content: "two" }); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof SessionDegradedError, "a pinned session raises degraded, not a silent fallback write");

    // The transcript was NOT forked: the fallback knows nothing about s_primary.
    assert.equal(await fallback.getSessionHydration("s_primary"), null,
      "no partial transcript written to the JSON fallback");
    console.log("  ✓ pinned session surfaces degraded instead of forking to JSON");
  }

  // 2 --- A brand-new session created WHILE degraded is allowed onto the fallback and pinned there.
  {
    const rec2 = await store.createSession("/x", "p", "m", undefined, undefined, "S2", "s_second");
    // The fallback now owns it and writes succeed.
    await store.saveMessage("s_second", { role: "user", content: "hello" });
    const hyd = await fallback.getSessionHydration("s_second");
    assert.ok(hyd, "new session started on the fallback while primary is down");
    assert.equal(hyd!.messages.length, 1, "fallback transcript is coherent and complete");
    assert.equal(hyd!.session.sessionId, "s_second");
    console.log("  ✓ new-while-degraded session pins to fallback with a coherent transcript");
  }

  // 3 --- listSessions unions both backends without duplicating a session id.
  {
    primary.down = false;
    const all = await store.listSessions();
    const ids = all.map((s) => s.sessionId);
    assert.ok(new Set(ids).size === ids.length, "no duplicate session ids across backends");
    assert.ok(ids.includes("s_primary") && ids.includes("s_second"), "both backends are represented");
    console.log("  ✓ listSessions is the single-source union across backends");
  }

  console.log("\n=== Phase 41 results:", 0, "failures ===");
  await store.close();
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

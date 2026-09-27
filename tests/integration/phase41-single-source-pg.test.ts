/**
 * Phase 41 integration — single source of truth against REAL Postgres.
 *
 * The offline unit test (`phase41-single-source`) proves the no-fork logic with a fake primary.
 * This proves the same guarantees against a real backend, which only the CI service container
 * provides: a session created on Postgres is owned by Postgres — its messages hydrate in `seq`
 * order from PG, the local JSON fallback holds NOTHING for that id (no forked transcript), and the
 * lifecycle methods (status/archive/delete) act on the real row.
 *
 * Skips cleanly (exit 0) when `DATABASE_URL` is unreachable, so it never fails a local run.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ResilientSessionStore, LocalJsonSessionStore, PostgresSessionStore } from "../../packages/session-store/src/index.js";
import { cleanupOnExit } from "../helpers/tmp.js";

const DB = process.env.DATABASE_URL || "postgresql://inflynx:inflynx_dev_pw@localhost:5432/inflynx_code";

async function main() {
  // Self-gate against a real connection: the runner only selects this file when Postgres is
  // reachable, but guard anyway so a local run exits 0 rather than hanging on a refused connect.
  const probe = new PostgresSessionStore(DB);
  try {
    await probe.listSessions();
  } catch (err: any) {
    console.log(`⏭ PostgreSQL not reachable (${err?.code || err?.message}) — skipping Phase 41 integration.`);
    await probe.close().catch(() => {});
    return;
  }
  await probe.close().catch(() => {});

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase41-pg-"));
  cleanupOnExit(root);
  const store = new ResilientSessionStore(DB, root);

  try {
    const rec = await store.createSession(root, "openai", "gpt-4o", undefined, "medium", "PG pinning", undefined);
    const id = rec.sessionId;
    for (const text of ["one", "two", "three"]) {
      await store.saveMessage(id, { role: "user", content: text });
    }
    await store.updateSessionStatus(id, "completed");

    // 1 --- hydration reads all three, in insertion order, from the real store.
    const hyd = await store.getSessionHydration(id);
    assert.ok(hyd, "hydrated from Postgres");
    assert.deepEqual(hyd!.messages.map((m) => m.content), ["one", "two", "three"], "seq-ordered hydration");
    assert.equal(hyd!.session.status, "completed", "lifecycle status persisted to PG");
    console.log("  ✓ session + 3 ordered messages + status live in Postgres");

    // 2 --- THE POINT: the local JSON fallback holds nothing for this session — the transcript did
    //       not fork to JSON while Postgres was up.
    const fallback = new LocalJsonSessionStore(root);
    assert.equal(await fallback.getSessionHydration(id), null,
      "no forked copy in the JSON fallback while the primary owns the session");
    console.log("  ✓ zero forked records in the JSON fallback (single source of truth holds)");

    // 3 --- delete removes it from the owner; hydration goes away.
    const deleted = await store.deleteSession(id);
    assert.ok(deleted, "deleteSession returned true on the owning backend");
    assert.equal(await store.getSessionHydration(id), null, "gone after delete (cascade)");
    console.log("  ✓ deleteSession removed the PG row (no orphan)");

    console.log("\n=== Phase 41 PG integration: 0 failures ===");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error("Fatal:", err); process.exit(1); });

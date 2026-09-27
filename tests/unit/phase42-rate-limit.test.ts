/**
 * Phase 42 — rate-limit correctness (H5 atomic, H6 wait-out, H10 reconnect intent)
 *
 * Deterministic and offline: a fake Redis client proves the limiter issues ONE atomic EVAL
 * (not the old two-round-trip INCR then EXPIRE that left a TTL-less key = permanent lockout on a
 * crash), and that failure semantics are configurable — fail-open for the CLI, fail-CLOSED for the
 * server where the limiter is a control. `waitOutRateLimit` is tested with an injected sleep + RNG
 * so the "pause, don't kill the session" loop (H6) is exercised without wall-clock time.
 *
 * The real Redis INCR/EXPIRE atomicity and the H10 reconnect-when-Redis-appears path need a live
 * Redis (integration, CI-gated) — not claimed here.
 */
import { strict as assert } from "node:assert";
import { checkRateLimit, waitOutRateLimit, isRedisConfigured, type RateLimitResult } from "../../packages/cache/src/index.js";

console.log("=== Phase 42: rate-limit correctness ===");

function ok(count: number, ttl = 30): RateLimitResult {
  return { allowed: count > 0, remaining: 0, limit: 0, resetInSec: ttl, failedOpen: false };
}

async function main() {
  // 1 --- H5: the limiter uses ONE atomic EVAL, never a bare incr()/expire() pair.
  {
    const calls: { method: string }[] = [];
    const fake = {
      eval: async (script: string, numKeys: number, key: string, win: string) => {
        calls.push({ method: "eval" });
        assert.match(script, /INCR/, "Lua must INCR");
        assert.match(script, /EXPIRE/, "Lua must EXPIRE in the same script");
        assert.equal(numKeys, 1);
        assert.equal(win, "60");
        return [3, 42]; // count=3, ttl=42
      },
      incr: async () => { calls.push({ method: "incr" }); throw new Error("REGRESSION: non-atomic incr used"); },
      expire: async () => { calls.push({ method: "expire" }); },
    };
    const r = await checkRateLimit("model:s1", 5, 60, { client: fake as any });
    assert.equal(calls.filter((c) => c.method === "eval").length, 1, "exactly one atomic EVAL");
    assert.equal(calls.filter((c) => c.method === "incr").length, 0, "no separate incr round-trip");
    assert.equal(r.allowed, true, "3 <= 5 allowed");
    assert.equal(r.remaining, 2);
    assert.equal(r.resetInSec, 42, "ttl comes from the script");
    console.log("  ✓ atomic EVAL (INCR+EXPIRE in one script), count/ttl read back (H5)");
  }

  // 2 --- over the limit is denied (not silently allowed).
  {
    const fake = { eval: async () => [7, 12] };
    const r = await checkRateLimit("model:s2", 5, 60, { client: fake as any });
    assert.equal(r.allowed, false);
    assert.equal(r.remaining, 0);
    console.log("  ✓ 7 > 5 is denied");
  }

  // 3 --- H5 failure semantics: no client → fail OPEN; client error → fail CLOSED only if asked.
  {
    const open = await checkRateLimit("model:s3", 5, 60, { client: null });
    assert.equal(open.allowed, true);
    assert.equal(open.failedOpen, true);

    const boom = { eval: async () => { throw new Error("connection reset"); } };
    const cliOpen = await checkRateLimit("model:s3", 5, 60, { client: boom as any });
    assert.equal(cliOpen.allowed, true, "CLI (no failClosed) fails open on a Redis blip");
    assert.equal(cliOpen.failedOpen, true);

    const srvClosed = await checkRateLimit("model:s3", 5, 60, { client: boom as any, failClosed: true });
    assert.equal(srvClosed.allowed, false, "server fails CLOSED: a broken limiter must not silently permit");
    assert.equal(srvClosed.failedClosed, true);
    console.log("  ✓ fail-open (CLI) vs fail-CLOSED (server) on a Redis command error (H5)");
  }

  // 4 --- H6: a transient block is waited out, not failed. Injected sleep makes it instant.
  {
    let n = 0;
    const recheck = async (): Promise<RateLimitResult> => {
      n++;
      // First two checks are blocked; the third (after sleeping to the reset) is allowed.
      return n < 3 ? { allowed: false, remaining: 0, limit: 5, resetInSec: 1, failedOpen: false } : ok(1, 1);
    };
    const slept: number[] = [];
    const final = await waitOutRateLimit(recheck, { budgetMs: 10_000, sleepFn: async (ms) => { slept.push(ms); }, random: () => 0.5 });
    assert.equal(final.allowed, true, "recovered after waiting");
    assert.ok(slept.length >= 2, "it slept (paused) between re-checks rather than failing immediately");
    assert.ok(n >= 3, "it re-checked the limiter while waiting");
    console.log(`  ✓ transient rate limit waited out over ${slept.length} pause(s), then allowed (H6)`);
  }

  // 5 --- H6 bounds: an always-blocked limiter gives up after the budget (does not spin forever),
  // and a fail-CLOSED result short-circuits the wait (waiting can't fix a dead control).
  {
    let checks = 0;
    const blocked = async (): Promise<RateLimitResult> => { checks++; return { allowed: false, remaining: 0, limit: 5, resetInSec: 5, failedOpen: false }; };
    // budgetMs tiny + a sleep that consumes the clock via the loop's Date.now guard.
    const r1 = await waitOutRateLimit(blocked, { budgetMs: 0, sleepFn: async () => {}, random: () => 0 });
    assert.equal(r1.allowed, false, "gives up after budget, returns still-blocked");

    checks = 0;
    let slept = 0;
    const closed = async (): Promise<RateLimitResult> => { checks++; return { allowed: false, remaining: 0, limit: 5, resetInSec: 5, failedOpen: false, failedClosed: true }; };
    const r2 = await waitOutRateLimit(closed, { budgetMs: 10_000, sleepFn: async () => { slept++; }, random: () => 0 });
    assert.equal(r2.failedClosed, true);
    assert.equal(slept, 0, "a fail-closed control error is not waited out");
    assert.equal(checks, 1, "checked once, did not loop");
    console.log("  ✓ wait is budget-bounded and does not spin on a fail-closed error (H6)");
  }

  console.log("\n=== Phase 42 results:", 0, "failures ===");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

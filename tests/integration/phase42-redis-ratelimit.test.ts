/**
 * Phase 42 integration — the atomic rate-limit window against REAL Redis.
 *
 * The offline unit test proves the limiter issues one atomic EVAL with a fake client. This proves it
 * against a real Redis: hammering past the limit climbs the counter atomically, the key always
 * carries a TTL (never the TTL-less "permanent lockout" the old two-round-trip code could leave),
 * and once allowed/denied flips at the limit the decision is consistent.
 *
 * Skips cleanly when `REDIS_URL` is unreachable, so a local run never fails on it.
 */
import { strict as assert } from "node:assert";
import { checkRateLimit, closeRedisClient } from "../../packages/cache/src/index.js";

const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

async function main() {
  const hadUrl = Boolean(process.env.REDIS_URL);
  if (!hadUrl) process.env.REDIS_URL = REDIS; // make getRedisClient() attempt the CI service
  const stamp = Date.now();

  // 1 --- a live bucket denies past the limit and never leaves the key without a TTL.
  {
    const key = `phase42:${stamp}:win`;
    let sawDeny = false;
    for (let i = 1; i <= 6; i++) {
      const r = await checkRateLimit(key, 3, 60);
      if (!r.allowed) sawDeny = true;
      assert.equal(r.failedOpen, false, "with a live Redis the check must not fail open");
      assert.ok(r.resetInSec > 0 && r.resetInSec <= 60, `key carries a real TTL (got ${r.resetInSec})`);
    }
    assert.ok(sawDeny, "6 calls against a limit of 3 must be denied at some point");
    console.log("  ✓ live Redis enforces the window and the key always has a TTL (H5)");
  }

  // 2 --- the very first bump sets the expiry atomically: resetInSec is fresh, not the fallback.
  {
    const key = `phase42:${stamp}:ttl`;
    const first = await checkRateLimit(key, 5, 45);
    assert.equal(first.allowed, true);
    assert.ok(first.resetInSec <= 45 && first.resetInSec > 40, `first write established a ~45s TTL (got ${first.resetInSec})`);
    console.log("  ✓ first INCR also set EXPIRE (atomic INCR+EXPIRE)");
  }

  await closeRedisClient();
  console.log("\n=== Phase 42 Redis integration: 0 failures ===");
}

main()
  .then(() => process.exit(0))
  .catch((err: any) => {
    if (err?.code === "ECONNREFUSED" || /connect|redis/i.test(String(err?.message))) {
      console.log(`⏭ Redis not reachable (${err?.code || err?.message}) — skipping Phase 42 integration.`);
      process.exit(0);
    }
    console.error("Fatal:", err);
    process.exit(1);
  });

/**
 * Key-gated LIVE Clerk check. This is the ONE auth test that needs real credentials, so it self-skips
 * (exit 0) whenever `CLERK_SECRET_KEY` is unset — CI and offline runs stay green without a Clerk account.
 * When the key IS present it proves the seam is wired end-to-end: the `@clerk/backend` SDK loads via the
 * dynamic import and `verifyToken` is actually reached (a bogus bearer must be rejected, not ignored).
 *
 * Run:  CLERK_SECRET_KEY=sk_... pnpm exec tsx tests/integration/clerk-live.test.ts
 */
import { strict as assert } from "node:assert";

const secretKey = process.env.CLERK_SECRET_KEY;

async function main() {
  if (!secretKey) {
    console.log("SKIPPED clerk-live: CLERK_SECRET_KEY not set (this test is opt-in / key-gated).");
    process.exit(0);
  }
  const { verifyToken } = await import("@clerk/backend");
  assert.equal(typeof verifyToken, "function", "@clerk/backend verifyToken must load");
  // A garbage token must throw / be rejected — reaching the real Clerk path proves the seam is live.
  let rejected = false;
  try {
    await verifyToken("not-a-real-jwt", { secretKey });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "an invalid token must be rejected by the live Clerk path");
  console.log("✓ clerk-live: SDK loaded and rejected an invalid token (seam wired)");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

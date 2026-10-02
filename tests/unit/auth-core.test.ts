/**
 * Phase 2 auth core — pure unit tests (no Clerk, no Postgres, no network).
 *
 * Proves the pieces that must be correct before the browser flow is even wired: the app JWT
 * signs/verifies/expiries/tamper-checks, and the device-authorization flow resolves a user,
 * grants the signup bonus ONLY when anti-abuse signals are clean, and refuses to mint a token
 * until the code is approved + unexpired.
 */
import { strict as assert } from "node:assert";
process.env.INFLYNX_TOKEN_SECRET = "unit-test-secret-value-1234567890";

import { signAppToken, verifyAppToken } from "../../apps/server/src/auth/jwt.js";
import { creditsForCostUsd } from "../../apps/server/src/auth/credits.js";
import { startDeviceCode, approveDevice, pollDeviceToken, type AuthStore, type DeviceFlowDeps } from "../../apps/server/src/auth/deviceFlow.js";
import type { DeviceCode, User } from "../../packages/session-store/src/index.js";

console.log("=== auth core (jwt + device flow) ===");

function fakeUser(id: string, credits = 0): User {
  return { id, email: `${id}@x.io`, displayName: null, avatarUrl: null, authProvider: "clerk", authSubject: id, plan: "free", credits, creditsUsed: 0, disabled: false, flagged: false, flaggedReason: null, createdAt: Date.now(), lastSeenAt: null };
}

/** A minimal in-memory AuthStore recording the calls the flow makes. */
function makeStore(opts: { existing?: User | null; counts?: { fingerprint: number; ipRange: number; emailDomain: number } } = {}) {
  const calls: string[] = [];
  let seq = 0;
  const devices = new Map<string, DeviceCode>();
  const store: AuthStore & { calls: string[]; devices: Map<string, DeviceCode> } = {
    calls, devices,
    async getUserBySubject(_p, s) { calls.push(`get:${s}`); return opts.existing ?? null; },
    async createUser(input: any) { calls.push(`create:${input.authSubject}`); return fakeUser(`u${++seq}`, input.credits ?? 0); },
    async grantCredits(id, amt, reason) { calls.push(`grant:${id}:${amt}:${reason}`); return fakeUser(id, amt); },
    async markUserFlagged(id, reason) { calls.push(`flag:${id}:${reason}`); },
    async countSignupSignals() { return opts.counts ?? { fingerprint: 0, ipRange: 0, emailDomain: 0 }; },
    async createDeviceCode(input) {
      const dc: DeviceCode = { userCode: `ABCD-1234${seq}`, deviceCode: `dev${++seq}`, verificationUri: input.verificationUri, expiresAt: Date.now() + input.ttlMs, userId: null, approved: false, createdAt: Date.now() };
      devices.set(dc.userCode, dc); devices.set(dc.deviceCode, dc); calls.push("createDevice"); return dc;
    },
    async lookupDeviceCodeByDevice(d) { return devices.get(d) ?? null; },
    async approveDeviceCode(uc, uid) { const d = devices.get(uc); if (!d || d.expiresAt < Date.now()) return false; d.approved = true; d.userId = uid; calls.push(`approve:${uc}:${uid}`); return true; },
  };
  return store;
}
const deps = (store: AuthStore): DeviceFlowDeps => ({ store, signForUser: (id) => ({ token: `tok-${id}`, expiresInSec: 3600 }), bonusCredits: 50 });

async function main() {
  // 1 --- JWT round trip + rejection of tampered / expired tokens.
  {
    const tok = signAppToken({ sub: "user-1", plan: "pro" }, 60);
    const c = verifyAppToken(tok);
    assert.equal(c?.sub, "user-1");
    assert.equal(c?.plan, "pro");
    assert.equal(verifyAppToken(tok.slice(0, -2) + "xx"), null, "tampered signature rejected");
    assert.equal(verifyAppToken("garbage"), null);
    assert.equal(verifyAppToken(null), null);
    const expired = signAppToken({ sub: "u", plan: "free" }, -5);
    assert.equal(verifyAppToken(expired), null, "expired token rejected");
    console.log("  ✓ app JWT signs, verifies, and rejects tamper/expiry");
  }

  // 2 --- start issues a device code.
  const store = makeStore();
  const dc = await startDeviceCode(deps(store), "https://app.localhost/activate");
  assert.ok(dc.userCode && dc.deviceCode && dc.expiresAt > Date.now());
  assert.ok(store.calls.includes("createDevice"));
  console.log("  ✓ startDeviceCode mints user_code + device_code");

  // 3 --- approve a NEW, clean identity → createUser + grant signup bonus.
  {
    const s = makeStore();
    const r = await approveDevice(deps(s), { userCode: (await startDeviceCode(deps(s), "u")).userCode, identity: { authProvider: "clerk", authSubject: "fresh", email: "a@x.io", displayName: null, avatarUrl: null }, deviceFingerprint: "fp-clean", ip: "1.2.3.4" });
    assert.equal(r.ok, true);
    assert.ok(s.calls.some((c) => c.startsWith("create:fresh")));
    assert.ok(s.calls.some((c) => /^grant:u\d+:50:signup-bonus$/.test(c)), "bonus granted when signals clean");
    assert.ok(!s.calls.some((c) => c.startsWith("flag:")));
    console.log("  ✓ new clean user gets createUser + signup bonus, not flagged");
  }

  // 4 --- approve a NEW but ABUSIVE identity (fingerprint over threshold) → NO bonus, flagged.
  {
    const s = makeStore({ counts: { fingerprint: 9, ipRange: 0, emailDomain: 0 } });
    const uc = (await startDeviceCode(deps(s), "u")).userCode;
    await approveDevice(deps(s), { userCode: uc, identity: { authProvider: "clerk", authSubject: "farm", email: "b@mailinator.com", displayName: null, avatarUrl: null }, deviceFingerprint: "fp-farm", ip: "9.9.9.9" });
    assert.ok(s.calls.some((c) => c.startsWith("flag:")), "abusive signup flagged");
    assert.ok(!s.calls.some((c) => c.includes("grant:")), "NO bonus for an abusive signup");
    console.log("  ✓ over-threshold fingerprint → flagged and denied the credit bonus");
  }

  // 5 --- poll BEFORE approval → authorization_pending; the user cannot get a token yet.
  {
    const s = makeStore();
    const d = await startDeviceCode(deps(s), "u");
    assert.deepEqual(await pollDeviceToken(deps(s), d.deviceCode), { status: "authorization_pending" });
    // after approval → token bound to the user id
    const uc = d.userCode;
    await approveDevice(deps(s), { userCode: uc, identity: { authProvider: "clerk", authSubject: "p", email: null, displayName: null, avatarUrl: null } });
    const res = await pollDeviceToken(deps(s), d.deviceCode);
    assert.equal(res.status, "approved");
    if (res.status === "approved") assert.ok(res.accessToken.startsWith("tok-"), "signed with the resolved userId");
    console.log("  ✓ poll: pending before approval, app token after");
  }

  // 6 --- unknown / expired device codes.
  {
    const s = makeStore();
    assert.deepEqual(await pollDeviceToken(deps(s), "nope"), { status: "invalid_grant", error: "invalid_grant" });
    console.log("  ✓ unknown device code → invalid_grant");
  }

  // 7 --- metering policy: a real turn always debits ≥1 credit; rate is tunable; negatives clamp.
  {
    assert.equal(creditsForCostUsd(0, 100), 1, "a zero-cost turn still costs the minimum 1 credit");
    assert.equal(creditsForCostUsd(0.0001, 100), 1, "sub-cent cost rounds up to 1");
    assert.equal(creditsForCostUsd(0.023, 100), 3, "$0.023 at 100 credits/$ = 3");
    assert.equal(creditsForCostUsd(0.02, 50), 1, "$0.02 at 50/$ = 1");
    assert.equal(creditsForCostUsd(-5, 100), 1, "negative clamps to the minimum");
    console.log("  ✓ creditsForCostUsd: min-1, round-up, tunable rate, negative-safe");
  }

  console.log("\n=== auth core results:", 0, "failures ===");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

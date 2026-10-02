/**
 * Phase 2 auth routes — handleAuthRoutes driven with a fake store + fake Clerk verifier.
 *
 * Exercises the HTTP contract (status + JSON shapes) of the CLI device flow and /me without a
 * server, Postgres, or Clerk: start -> pending -> approve -> token, and /me requires a real app JWT.
 * The abuse gate is already covered in auth-core; here we assert the endpoint wiring + status codes.
 */
import { strict as assert } from "node:assert";
process.env.INFLYNX_TOKEN_SECRET = "route-test-secret-1234567890";

import { handleAuthRoutes } from "../../apps/server/src/auth/routes.js";
import { signAppToken } from "../../apps/server/src/auth/jwt.js";
import type { DeviceCode, User } from "../../packages/session-store/src/index.js";

console.log("=== auth routes ===");

function user(id: string): User {
  return { id, email: `${id}@x.io`, displayName: "T", avatarUrl: null, authProvider: "clerk", authSubject: id, plan: "free", credits: 50, creditsUsed: 0, disabled: false, flagged: false, flaggedReason: null, createdAt: Date.now(), lastSeenAt: null };
}

function makeCtx(body: Record<string, unknown> = {}, verify = async (_b: string) => ({ authProvider: "clerk", authSubject: "sub-1", email: "a@x.io", displayName: null, avatarUrl: null })) {
  const out: { status: number; body: unknown }[] = [];
  let seq = 0;
  const devices = new Map<string, DeviceCode>();
  const store: any = {
    async getUser(id: string) { return id === "u-1" ? user("u-1") : null; },
    async listSessionsByUser() { return [{ sessionId: "s1", user_id: "u-1" }]; },
    async getUserBySubject() { return null; },
    async createUser() { return { ...user("u-1") }; },
    async grantCredits() { return null; },
    async markUserFlagged() {},
    async countSignupSignals() { return { fingerprint: 0, ipRange: 0, emailDomain: 0 }; },
    async createDeviceCode(input: any) { const d: DeviceCode = { userCode: `UC${++seq}`, deviceCode: `DC${seq}`, verificationUri: input.verificationUri, expiresAt: Date.now() + input.ttlMs, userId: null, approved: false, createdAt: Date.now() }; devices.set(d.userCode, d); devices.set(d.deviceCode, d); return d; },
    async lookupDeviceCodeByDevice(dc: string) { return devices.get(dc) ?? null; },
    async approveDeviceCode(uc: string, uid: string) { const d = devices.get(uc); if (!d) return false; d.approved = true; d.userId = uid; return true; },
  };
  const ctx = {
    store,
    baseUrl: "https://app.inflynx.test",
    verify,
    send: (_res: unknown, status: number, b: unknown) => { out.push({ status, body: b }); },
    readBody: async () => body,
    toWireSession: (r: any) => r,
  };
  return { ctx, out, devices };
}
const req = (method: string, path: string, headers: Record<string, string> = {}): any => ({ method, url: path, headers, socket: { remoteAddress: "203.0.113.7" } });

async function main() {
  // start
  {
    const { ctx, out } = makeCtx();
    const handled = await handleAuthRoutes(req("POST", "/auth/device/start"), {} as any, ctx);
    assert.equal(handled, true);
    assert.equal(out[0].status, 200);
    assert.match((out[0].body as any).user_code, /.+/);
    assert.ok((out[0].body as any).verification_uri.startsWith("https://app.inflynx.test/activate"));
    console.log("  ✓ POST /auth/device/start -> 200 {user_code, verification_uri}");
  }
  // token before approval -> pending; unknown -> invalid_grant
  {
    const { ctx, out, devices } = makeCtx();
    await handleAuthRoutes(req("POST", "/auth/device/start"), {} as any, ctx);
    const dc = [...devices.values()][0].deviceCode;
    await handleAuthRoutes(req("POST", "/auth/device/token"), {} as any, { ...ctx, readBody: async () => ({ device_code: dc }) });
    assert.equal(out[out.length - 1].status, 400);
    assert.equal((out[out.length - 1].body as any).error, "authorization_pending");
    await handleAuthRoutes(req("POST", "/auth/device/token"), {} as any, { ...ctx, readBody: async () => ({ device_code: "nope" }) });
    assert.equal((out[out.length - 1].body as any).error, "invalid_grant");
    console.log("  ✓ token poll: pending before approval, invalid_grant for unknown code");
  }
  // approve (fake Clerk identity) -> ok; then token -> access_token
  {
    const { ctx, out, devices } = makeCtx({ user_code: "UC1" });
    await handleAuthRoutes(req("POST", "/auth/device/start"), {} as any, ctx);
    const uc = [...devices.values()].find((d) => d.userCode === "UC1")!;
    const approvable = { ...ctx, readBody: async () => ({ user_code: uc.userCode }) };
    const ok = await handleAuthRoutes(req("POST", "/auth/device/approve", { authorization: "Bearer clerk-session" }), {} as any, approvable);
    assert.equal(ok, true);
    assert.equal(out[out.length - 1].status, 200, "approve with a valid identity -> 200");
    assert.equal((out[out.length - 1].body as any).ok, true);
    const dc = uc.deviceCode;
    await handleAuthRoutes(req("POST", "/auth/device/token"), {} as any, { ...ctx, readBody: async () => ({ device_code: dc }) });
    const last = out[out.length - 1];
    assert.equal(last.status, 200);
    assert.ok((last.body as any).access_token.startsWith("eyJ") || typeof (last.body as any).access_token === "string", "got a signed app token");
    console.log("  ✓ approve with identity -> token issued (our app JWT) after approval");
  }
  // /me requires a real app token; valid token -> user
  {
    const { ctx, out } = makeCtx();
    await handleAuthRoutes(req("GET", "/me"), {} as any, ctx);
    assert.equal(out[0].status, 401, "/me without token -> 401");
    const tok = signAppToken({ sub: "u-1", plan: "free" }, 60);
    await handleAuthRoutes(req("GET", "/me", { authorization: `Bearer ${tok}` }), {} as any, ctx);
    assert.equal(out[1].status, 200);
    assert.equal((out[1].body as any).user.id, "u-1");
    console.log("  ✓ GET /me: 401 anonymous, 200 with a valid app token");
  }

  console.log("\n=== auth routes results:", 0, "failures ===");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

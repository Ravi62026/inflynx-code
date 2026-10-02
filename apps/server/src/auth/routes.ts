/**
 * /auth/* + /me routes for the CLI device-authorization flow. Kept decoupled from the HTTP server:
 * `send` and `readBody` are injected, so this is unit-testable with a fake store + fake verifier and
 * no sockets. Returns true if it handled the request (the server then stops routing).
 *
 * Identity is Clerk's (via the injected verifier) only at /auth/device/approve; everywhere else the
 * caller presents our own app JWT. Enforcement of /api routes lives in the server (middleware.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { startDeviceCode, approveDevice, pollDeviceToken, type AuthStore } from "./deviceFlow.js";
import { getIdentityVerifier, type VerifyIdentity } from "./identity.js";
import { signAppToken, verifyAppToken } from "./jwt.js";
import { bearerToken, clientIp } from "./middleware.js";
import { checkRateLimit } from "@inflynx/cache";
import type { UserPublic } from "@inflynx/protocol";

export interface AuthRouteCtx {
  store: AuthStore;
  baseUrl: string; // public origin of the backend, for verification_uri
  verify?: VerifyIdentity; // injectable for tests; defaults to the Clerk verifier
  send: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  toWireSession: (row: any) => unknown;
}

function toPublic(u: any): UserPublic {
  return { id: u.id, email: u.email ?? null, displayName: u.displayName ?? null, avatarUrl: u.avatarUrl ?? null, plan: u.plan, credits: Number(u.credits) || 0 };
}

export async function handleAuthRoutes(req: IncomingMessage, res: ServerResponse, ctx: AuthRouteCtx): Promise<boolean> {
  const path = (new URL(req.url || "/", "http://x").pathname.replace(/\/+$/, "")) || "/";
  const method = req.method || "GET";

  // Phase 3.5: the device endpoints are unauthenticated entry points — cap them per IP so one box
  // can't mint unlimited codes or brute-force the token poll. Reuses the Phase 42 limiter.
  if (method === "POST" && path.startsWith("/auth/device/")) {
    const rl = await checkRateLimit(`auth:ip:${clientIp(req)}`, Number(process.env.INFLYNX_AUTH_PER_IP || "20"), 60, { failClosed: process.env.INFLYNX_RATE_LIMIT_FAIL_CLOSED === "1" });
    if (!rl.allowed) {
      res.setHeader?.("retry-after", String(rl.resetInSec));
      ctx.send(res, 429, { error: "rate_limited", resetInSec: rl.resetInSec });
      return true;
    }
  }

  const deps = {
    store: ctx.store,
    signForUser: (userId: string) => ({ token: signAppToken({ sub: userId, plan: "free" }, 3600), expiresInSec: 3600 }),
  };

  if (method === "POST" && path === "/auth/device/start") {
    const d = await startDeviceCode(deps, `${ctx.baseUrl}/activate`);
    ctx.send(res, 200, {
      device_code: d.deviceCode,
      user_code: d.userCode,
      verification_uri: d.verificationUri,
      verification_uri_complete: `${ctx.baseUrl}/activate?user_code=${d.userCode}`,
      expires_in: Math.max(0, Math.round((d.expiresAt - d.createdAt) / 1000)),
      interval: 5,
    });
    return true;
  }

  if (method === "POST" && path === "/auth/device/approve") {
    const body = await ctx.readBody(req);
    const userCode = String(body.user_code ?? body.userCode ?? "");
    if (!userCode) { ctx.send(res, 400, { error: "user_code required" }); return true; }
    const verify = ctx.verify ?? safeVerifier();
    let identity;
    try { identity = await verify(bearerToken(req) || ""); }
    catch (e) { ctx.send(res, 401, { error: (e as Error).message }); return true; }
    if (!identity) { ctx.send(res, 401, { error: "invalid session" }); return true; }
    const ua = req.headers["user-agent"] ? String(req.headers["user-agent"]) : null;
    const r = await approveDevice(deps, {
      userCode, identity, ip: clientIp(req),
      deviceFingerprint: body.device_fingerprint ? String(body.device_fingerprint) : null,
      userAgent: ua,
    });
    ctx.send(res, r.ok ? 200 : 400, { ok: r.ok });
    return true;
  }

  if (method === "POST" && path === "/auth/device/token") {
    const body = await ctx.readBody(req);
    const r = await pollDeviceToken(deps, String(body.device_code ?? ""));
    if (r.status === "approved") { ctx.send(res, 200, { access_token: r.accessToken, token_type: "Bearer", expires_in: r.expiresInSec }); }
    else if (r.status === "authorization_pending") { ctx.send(res, 400, { error: "authorization_pending" }); }
    else { ctx.send(res, 400, { error: (r as { error?: string }).error || "invalid_grant" }); }
    return true;
  }

  if (path === "/me" || path.startsWith("/me/")) {
    const claims = verifyAppToken(bearerToken(req));
    if (!claims) { ctx.send(res, 401, { error: "authentication required" }); return true; }
    if (method === "GET" && path === "/me") {
      const u = await ctx.store.getUser?.(claims.sub);
      if (!u) { ctx.send(res, 404, { error: "no such user" }); return true; }
      ctx.send(res, 200, { user: toPublic(u) });
      return true;
    }
    if (method === "GET" && path === "/me/sessions") {
      const list = (await ctx.store.listSessionsByUser?.(claims.sub, 50)) ?? [];
      ctx.send(res, 200, { sessions: list.map(ctx.toWireSession) });
      return true;
    }
    ctx.send(res, 404, { error: "not found" });
    return true;
  }

  return false;
}

function safeVerifier(): VerifyIdentity {
  return getIdentityVerifier(); // throws only if AUTH_PROVIDER is unsupported; verify() is caught above
}

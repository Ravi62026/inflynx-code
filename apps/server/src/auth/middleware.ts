/**
 * Request-side auth helpers. Enforcement is gated by INFLYNX_AUTH_ENFORCED (default OFF) so this
 * can ship without breaking the local/BYOK flow — it flips to on together with the CLI /login
 * (Phase 4) + Clerk keys. When on, a missing/invalid app token is a 401, never a silent pass.
 */
import type { IncomingMessage } from "node:http";
import { verifyAppToken, type AppClaims } from "./jwt.js";

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : null;
}

export function authEnforced(): boolean {
  return /^(1|true|yes)$/i.test(process.env.INFLYNX_AUTH_ENFORCED || "");
}

export function resolveUser(req: IncomingMessage): AppClaims | null {
  return verifyAppToken(bearerToken(req));
}

/**
 * Best-effort client IP for abuse signals. Proxy headers are trusted ONLY when INFLYNX_TRUST_PROXY
 * is set (i.e. we know we're behind a trusted proxy) — never a client-controlled header by default,
 * or an attacker could spoof the header to mint unlimited accounts.
 */
export function clientIp(req: IncomingMessage): string | null {
  if (/^(1|true)$/i.test(process.env.INFLYNX_TRUST_PROXY || "")) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
    const xRealIp = req.headers["x-real-ip"];
    if (typeof xRealIp === "string" && xRealIp.trim()) return xRealIp.trim();
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * The app's own short-lived access token (HS256 over node:crypto, no dependency).
 *
 * The browser identity is Clerk's; but the CLI/extension talk to *our* backend with *our* token
 * carrying the resolved `userId` — so metering, per-user authorization, and the mandatory-login gate
 * never depend on Clerk's internals. `INFLYNX_TOKEN_SECRET` is a deployment secret (add it with the
 * Clerk keys at the end); without it signing/verifying fails loudly rather than silently accepting.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");

export interface AppClaims {
  sub: string; // userId
  plan: string;
  typ: "access";
  iat: number;
  exp: number;
  jti: string;
}

function signingSecret(): Buffer {
  const s = process.env.INFLYNX_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "INFLYNX_TOKEN_SECRET must be set (>= 16 chars) to sign/verify session tokens. " +
        "Set it in .env alongside the Clerk keys."
    );
  }
  return Buffer.from(s, "utf8");
}

export function signAppToken(claims: { sub: string; plan: string }, ttlSec = 3600): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AppClaims = { ...claims, typ: "access", iat, exp: iat + ttlSec, jti: randomBytes(12).toString("hex") };
  const body = `${b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = createHmac("sha256", signingSecret()).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

/** Returns the claims on a valid, unexpired access token; `null` on any problem (never throws on bad input). */
export function verifyAppToken(token: string | undefined | null): AppClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = createHmac("sha256", signingSecret()).update(`${h}.${p}`).digest();
    given = Buffer.from(s, "base64url");
  } catch {
    return null; // signing secret unset → treat as unverifiable, caller 401s
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: AppClaims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.typ !== "access" || typeof claims.exp !== "number" || Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}

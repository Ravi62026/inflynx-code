/**
 * The CLI device-authorization flow, as a pure orchestration over injected collaborators — so it is
 * fully unit-testable with a fake store/verifier/signer and no Clerk, no network, no DB. The server
 * wires these to the real PostgresSessionStore, the Clerk verifier, and the HS256 signer.
 *
 * Abuse gating lives here: a NEW user's signup credit is only granted after `countSignupSignals`
 * says the fingerprint / IP / email-domain have not already crossed the threshold. That is the whole
 * point of the plan's anti-abuse requirement — one person cannot farm the bonus via throwaway
 * accounts. Thresholds come from env so they can be tuned post-launch without a redeploy.
 */
import type { DeviceCode, User } from "@inflynx/session-store";
import type { IdentityPrincipal } from "./identity.js";

/** Structural subset of SessionStore this module needs (all optional — feature-detected). */
export interface AuthStore {
  getUser?(id: string): Promise<User | null>;
  listSessionsByUser?(userId: string, limit?: number): Promise<unknown[]>;
  getUserBySubject?(provider: string, subject: string): Promise<User | null>;
  createUser?(input: any): Promise<User>;
  grantCredits?(userId: string, amount: number, reason: string): Promise<User | null>;
  markUserFlagged?(userId: string, reason: string): Promise<void>;
  countSignupSignals?(q: any): Promise<{ fingerprint: number; ipRange: number; emailDomain: number }>;
  createDeviceCode?(input: { verificationUri: string; ttlMs: number }): Promise<DeviceCode>;
  lookupDeviceCode?(userCode: string): Promise<DeviceCode | null>;
  lookupDeviceCodeByDevice?(deviceCode: string): Promise<DeviceCode | null>;
  approveDeviceCode?(userCode: string, userId: string): Promise<boolean>;
}

export interface DeviceFlowDeps {
  store: AuthStore;
  /** Sign an app token for the resolved user id; returns { token, expiresInSec }. */
  signForUser: (userId: string) => { token: string; expiresInSec: number };
  bonusCredits?: number;
  maxAccountsPerFingerprint?: number;
  maxAccountsPerIp?: number;
  maxAccountsPerEmailDomain?: number;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

function thresholds(deps: DeviceFlowDeps) {
  return {
    bonus: deps.bonusCredits ?? num(process.env.SIGNUP_BONUS_CREDITS, 50),
    fp: deps.maxAccountsPerFingerprint ?? num(process.env.MAX_ACCOUNTS_PER_FINGERPRINT, 2),
    ip: deps.maxAccountsPerIp ?? num(process.env.MAX_ACCOUNTS_PER_IP, 5),
    dom: deps.maxAccountsPerEmailDomain ?? num(process.env.MAX_ACCOUNTS_PER_EMAIL_DOMAIN, 20),
  };
}

const DEVICE_TTL_MS = 10 * 60 * 1000;

export async function startDeviceCode(deps: DeviceFlowDeps, verificationUri: string): Promise<DeviceCode> {
  if (!deps.store.createDeviceCode) throw new Error("device flow requires a Postgres-backed store");
  return deps.store.createDeviceCode({ verificationUri, ttlMs: DEVICE_TTL_MS });
}

export type PollResult =
  | { status: "approved"; accessToken: string; expiresInSec: number }
  | { status: "authorization_pending" }
  | { status: "slow_down" | "expired_token" | "invalid_grant"; error: string };

export async function pollDeviceToken(deps: DeviceFlowDeps, deviceCode: string): Promise<PollResult> {
  const rec = await deps.store.lookupDeviceCodeByDevice?.(deviceCode);
  if (!rec) return { status: "invalid_grant", error: "invalid_grant" };
  if (Date.now() > rec.expiresAt) return { status: "expired_token", error: "expired_token" };
  if (!rec.approved || !rec.userId) return { status: "authorization_pending" };
  // Approved: mint an app token bound to the resolved user id (the server resolves plan/credits by id).
  const signed = deps.signForUser(rec.userId);
  return { status: "approved", accessToken: signed.token, expiresInSec: signed.expiresInSec };
}

export interface ApproveInput {
  userCode: string;
  identity: IdentityPrincipal;
  ip?: string | null;
  deviceFingerprint?: string | null;
  userAgent?: string | null;
}

export async function approveDevice(deps: DeviceFlowDeps, input: ApproveInput): Promise<{ ok: boolean; userCode: string; userId: string }> {
  const { store } = deps;
  if (!store.getUserBySubject || !store.createUser || !store.approveDeviceCode) {
    throw new Error("device approval requires a Postgres-backed store");
  }
  const emailDomain = input.identity.email?.includes("@") ? input.identity.email.split("@")[1]?.toLowerCase() ?? null : null;

  let user = await store.getUserBySubject(input.identity.authProvider, input.identity.authSubject);
  if (!user) {
    // New identity: gate the signup bonus on multi-account signals before any credit is minted.
    const t = thresholds(deps);
    const counts = (await store.countSignupSignals?.({
      deviceFingerprint: input.deviceFingerprint ?? null,
      ip: input.ip ?? null,
      emailDomain,
      sinceMs: 24 * 60 * 60 * 1000,
    })) ?? { fingerprint: 0, ipRange: 0, emailDomain: 0 };

    const abused =
      (input.deviceFingerprint && counts.fingerprint >= t.fp) ||
      (input.ip && counts.ipRange >= t.ip) ||
      (emailDomain && counts.emailDomain >= t.dom);

    user = await store.createUser({
      authProvider: input.identity.authProvider,
      authSubject: input.identity.authSubject,
      email: input.identity.email,
      displayName: input.identity.displayName,
      avatarUrl: input.identity.avatarUrl,
      credits: 0,
      signupSignal: { ip: input.ip ?? null, deviceFingerprint: input.deviceFingerprint ?? null, emailDomain, userAgent: input.userAgent ?? null },
    });
    if (abused) {
      await store.markUserFlagged?.(user.id, "signup-abuse: repeated device/ip/email-domain");
    } else {
      await store.grantCredits?.(user.id, t.bonus, "signup-bonus");
    }
  }

  const approved = await store.approveDeviceCode(input.userCode, user.id);
  if (!approved) return { ok: false, userCode: input.userCode, userId: user.id };
  return { ok: true, userCode: input.userCode, userId: user.id };
}

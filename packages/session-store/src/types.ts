/**
 * @inflynx/session-store — shared types
 *
 * These interfaces are implemented identically by both backends:
 *   - PostgresSessionStore  (canonical, production backend — Docker/managed Postgres)
 *   - LocalJsonSessionStore (zero-dependency offline fallback — NOT a SQL database,
 *     used only when DATABASE_URL is unset; not intended for production use)
 */

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  provider: string;
  /** Non-secret reference into ~/.inflynx credential profiles. */
  credentialProfileId?: string;
  /** User-configured endpoint; credentials in URLs are prohibited upstream. */
  baseUrl?: string;
  /** Requested provider reasoning effort, not the local agent budget. */
  reasoningEffort?: string;
  /** Provider/model actually selected by a routing gateway, when available. */
  actualModel?: string;
  activeMode: string;
  effortLevel: string;
  title?: string;
  status: "active" | "completed" | "failed" | "cancelled" | "archived";
  /**
   * Phase 1 auth: owning user. Nullable in the store (pre-auth + the synthetic `legacy` row);
   * the server always sets it for new sessions once login is mandatory.
   */
  userId?: string | null;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolCallsJson?: string;
  /** JSON-safe provider continuation state; never contains a credential. */
  providerMetadataJson?: string;
  timestamp: number;
  /**
   * Monotonic insertion order (Phase 39). `timestamp` is only millisecond-resolution, so
   * 200 messages written in one millisecond hydrate in an arbitrary order without it.
   * Postgres fills it from a `BIGSERIAL`; the JSON store leaves it undefined and relies on
   * array order, which is already insertion order.
   */
  seq?: number;
}

export interface StoredToolExecution {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  output: string;
  isError: boolean;
  durationMs: number;
  timestamp: number;
}

export interface StoredTokenTelemetry {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  updatedAt: number;
}

export interface SessionModelConfig {
  provider: string;
  model: string;
  credentialProfileId?: string;
  baseUrl?: string;
  reasoningEffort?: string;
  actualModel?: string;
}

export interface SessionHydration {
  session: SessionRecord;
  messages: StoredMessage[];
  toolExecutions: StoredToolExecution[];
  telemetry: StoredTokenTelemetry;
}

export interface SessionStore {
  /**
   * Creates a new session record.
   *
   * @param sessionId Optional explicit session ID. When provided, the store MUST
   *   create the row using exactly this ID rather than generating its own —
   *   this is what allows `AgentOrchestrator` to guarantee that the ID used for
   *   every subsequent `saveMessage`/`saveToolExecution`/`updateTokenTelemetry`
   *   call always matches a real row in the sessions table (see
   *   `AgentOrchestrator.start()`). Omitting it generates a fresh random ID,
   *   which is fine for standalone/CLI-managed session creation where the
   *   caller immediately captures and reuses the returned `sessionId`.
   */
  createSession(
    cwd: string,
    provider: string,
    model: string,
    activeMode?: string,
    effortLevel?: string,
    title?: string,
    sessionId?: string,
    modelConfig?: Partial<SessionModelConfig>,
    /** Phase 1: owning user (server sets it once login is mandatory). */
    userId?: string | null
  ): Promise<SessionRecord>;
  saveMessage(sessionId: string, message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">): Promise<StoredMessage>;
  saveToolExecution(sessionId: string, execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">): Promise<StoredToolExecution>;
  updateTokenTelemetry(sessionId: string, telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">): Promise<StoredTokenTelemetry>;
  updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord>;
  getSessionHydration(sessionId: string): Promise<SessionHydration | null>;
  listSessions(cwd?: string): Promise<SessionRecord[]>;
  /**
   * Session lifecycle (Phase 39 / finding C9). `status` was written once as "active" and
   * never updated, so the sidebar could not tell a finished run from a crashed one from a
   * live one. These move it; the orchestrator calls them on the Phase-7 terminal events.
   */
  updateSessionStatus(sessionId: string, status: SessionRecord["status"]): Promise<void>;
  /** Soft lifecycle: status → "archived" (kept on disk, hidden from the default list). */
  archiveSession(sessionId: string): Promise<void>;
  /** Hard delete: removes the session and, via cascade, its messages/executions/telemetry. */
  deleteSession(sessionId: string): Promise<boolean>;
  /** Releases underlying connections/handles, if any. Safe to call on stores that don't need it. */
  close(): Promise<void>;

  // ── Phase 1 identity + credits (OPTIONAL: only the Postgres backend implements them; the
  // local JSON dev fallback leaves them undefined, and callers feature-detect). ────────────
  createUser?(input: CreateUserIdentityInput): Promise<User>;
  getUser?(id: string): Promise<User | null>;
  getUserBySubject?(provider: string, subject: string): Promise<User | null>;
  /** Sessions belonging to a user, newest first. Used for the per-user history view. */
  listSessionsByUser?(userId: string, limit?: number): Promise<SessionRecord[]>;
  /** Credit ledger. `debitCredits` refuses to go negative (returns { ok:false, balance }). */
  grantCredits?(userId: string, amount: number, reason: string): Promise<User | null>;
  debitCredits?(userId: string, amount: number, reason: string, sessionId?: string): Promise<{ ok: boolean; user: User | null }>;
  /** Anti-abuse signal capture at signup. Returns whether the account should be flagged/bonus-less. */
  recordSignupAttempt?(signal: SignupSignal & { outcome: string }): Promise<void>;
  /** How many accounts/signups share this fingerprint / ip-range / email-domain in the window. */
  countSignupSignals?(q: Partial<SignupSignal> & { sinceMs: number }): Promise<{ fingerprint: number; ipRange: number; emailDomain: number }>;
  markUserFlagged?(userId: string, reason: string): Promise<void>;
  setUserDisabled?(userId: string, disabled: boolean): Promise<void>;
  touchUserSeen?(userId: string, ip?: string): Promise<void>;
}

import { randomUUID } from "node:crypto";

/**
 * Collision-free id for messages and tool executions (Phase 39).
 *
 * These used to be `prefix_${Date.now()}_${5 random base36 chars}`. Under a fast turn
 * (200 writes inside one millisecond) the 5-char suffix collides often enough to either
 * throw a PK violation (Postgres) or overwrite a stored row (JSON) — a lost message. A
 * UUID is the cheap, correct fix and still fits the `VARCHAR(64)` columns.
 */
export function generateRecordId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Generates a session ID in the shared `session_<ts>_<rand>` format used across the codebase. */
export function generateSessionId(): string {
  return `session_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

// ─── Phase 1: identity, credits, anti-abuse signals ───────────────────────────

export type UserPlan = "free" | "pro" | string;

/** A user as stored/returned by the identity layer. `credits` is the remaining balance. */
export interface User {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string;
  authSubject: string;
  plan: UserPlan;
  credits: number;
  creditsUsed: number;
  disabled: boolean;
  flagged: boolean;
  flaggedReason: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

/** Input to `createUser` — the (provider, subject) pair is the idempotency key. */
export interface CreateUserIdentityInput {
  authProvider: string;
  authSubject: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  plan?: UserPlan;
  /** Initial balance to seed (e.g. the signup bonus), already abuse-gated by the caller. */
  credits?: number;
  signupSignal?: SignupSignal;
}

/** Non-secret-ish abuse signals captured at signup/login. IP is PII — retention applies. */
export interface SignupSignal {
  ip?: string | null;
  deviceFingerprint?: string | null;
  emailDomain?: string | null;
  userAgent?: string | null;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  reason: string;
  sessionId: string | null;
  balanceAfter: number;
  createdAt: number;
}

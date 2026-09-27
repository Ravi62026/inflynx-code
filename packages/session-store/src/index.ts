/**
 * @inflynx/session-store
 * Persistence manager for sessions, messages, tool execution logs, and token
 * telemetry. PostgreSQL is the canonical backend; a local JSON file store is
 * used as an offline/no-Docker fallback only.
 */

import { LocalJsonSessionStore } from "./LocalJsonSessionStore.js";
import { PostgresSessionStore } from "./PostgresSessionStore.js";
import type {
  SessionStore,
  SessionRecord,
  StoredMessage,
  StoredToolExecution,
  StoredTokenTelemetry,
  SessionModelConfig,
  SessionHydration,
} from "./types.js";

export * from "./types.js";
export { LocalJsonSessionStore } from "./LocalJsonSessionStore.js";
export { PostgresSessionStore } from "./PostgresSessionStore.js";

/**
 * @deprecated Renamed to `LocalJsonSessionStore` — this class was never
 * actually backed by SQLite. Kept as an alias for backward compatibility.
 */
export const SqliteSessionStore = LocalJsonSessionStore;

let warnedAboutFallback = false;

/** Only a connection failure should trigger failover; a real query error must surface. */
function isConnectionError(err: any): boolean {
  return (
    err?.code === "ECONNREFUSED" ||
    err?.code === "ETIMEDOUT" ||
    String(err?.message || "").includes("connect ECONNREFUSED") ||
    (Array.isArray(err?.errors) && err.errors.some((e: any) => e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT"))
  );
}

/**
 * Thrown when a session is pinned to the backend that owns it and that backend is
 * unreachable. It is deliberately NOT silently redirected to the other store — that is
 * exactly the split-brain Phase 41 removes: the transcript would fork, half in Postgres and
 * half in JSON, and resume would read back a truncated session. Surfacing lets the caller stop
 * writing rather than corrupt the history.
 */
export class SessionDegradedError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause?: unknown) {
    super(
      `Session "${sessionId}" lives in PostgreSQL, which is currently unreachable. Its data was ` +
      `NOT written to the local fallback (that would fork the transcript). Retry once PostgreSQL ` +
      `recovers. Cause: ${(cause as Error)?.message ?? cause}`,
      { cause }
    );
    this.name = "SessionDegradedError";
    this.sessionId = sessionId;
  }
}

export class ResilientSessionStore implements SessionStore {
  private primary: SessionStore;
  private fallback: SessionStore;
  /**
   * Single source of truth (Phase 41): each session id is created on exactly ONE backend and
   * every later write for it goes there — never both. Without this, an ECONNREFUSED mid-turn
   * sent the *next* message to the fallback while earlier ones sat in Postgres: the transcript
   * forked and resume read a partial history. This map is the whole point.
   */
  private owner = new Map<string, "primary" | "fallback">();
  /** Circuit: stop hammering a primary known to be down; new sessions then use fallback. */
  private primaryDownUntil = 0;
  private static readonly PRIMARY_COOLDOWN_MS = 30_000;

  constructor(
    connectionString: string,
    workspaceRoot?: string,
    injected?: { primary?: SessionStore; fallback?: SessionStore }
  ) {
    this.primary = injected?.primary ?? new PostgresSessionStore(connectionString);
    this.fallback = injected?.fallback ?? new LocalJsonSessionStore(workspaceRoot);
  }

  private get primaryHealthy(): boolean {
    return Date.now() >= this.primaryDownUntil;
  }

  private tripPrimaryDown(): void {
    this.primaryDownUntil = Date.now() + ResilientSessionStore.PRIMARY_COOLDOWN_MS;
  }

  /**
   * A write for a known session hits its owning backend and only that one. If the owner
   * (Postgres) is unreachable, the session is reported degraded rather than forked to JSON.
   */
  private async write<T>(sessionId: string, op: (s: SessionStore) => Promise<T>): Promise<T> {
    const pinned = this.owner.get(sessionId);
    const backend = pinned === "fallback" ? this.fallback
      : pinned === "primary" ? this.primary
      : (this.primaryHealthy ? this.primary : this.fallback);
    try {
      const result = await op(backend);
      if (!this.owner.has(sessionId)) this.owner.set(sessionId, backend === this.primary ? "primary" : "fallback");
      return result;
    } catch (err: any) {
      if (backend === this.primary && isConnectionError(err)) {
        this.tripPrimaryDown();
        // Do NOT retry on the fallback — the session belongs to Postgres; fork it instead.
        throw new SessionDegradedError(sessionId, err);
      }
      throw err;
    }
  }

  /**
   * Reads may probe both backends (a read cannot fork anything): after a process restart the
   * owner map is empty, so hydration/lookup falls through to whichever store has the row.
   */
  private async read<T>(sessionId: string, op: (s: SessionStore) => Promise<T>, found: (v: T) => boolean): Promise<T> {
    const pinned = this.owner.get(sessionId);
    const order: SessionStore[] = pinned === "fallback" ? [this.fallback, this.primary]
      : pinned === "primary" ? [this.primary, this.fallback]
      : (this.primaryHealthy ? [this.primary, this.fallback] : [this.fallback, this.primary]);
    let last: T | undefined;
    for (const backend of order) {
      try {
        const value = await op(backend);
        last = value;
        if (found(value)) {
          if (!this.owner.has(sessionId)) this.owner.set(sessionId, backend === this.primary ? "primary" : "fallback");
          return value;
        }
      } catch (err: any) {
        if (backend === this.primary && isConnectionError(err)) { this.tripPrimaryDown(); continue; }
        throw err;
      }
    }
    return last as T;
  }

  async createSession(
    cwd: string,
    provider: string,
    model: string,
    activeMode?: string,
    effortLevel?: string,
    title?: string,
    sessionId?: string,
    modelConfig?: Partial<SessionModelConfig>
  ): Promise<SessionRecord> {
    const backend = this.primaryHealthy ? this.primary : this.fallback;
    try {
      const record = await backend.createSession(cwd, provider, model, activeMode, effortLevel, title, sessionId, modelConfig);
      this.owner.set(record.sessionId, backend === this.primary ? "primary" : "fallback");
      return record;
    } catch (err: any) {
      // Only a brand-new session may move to the fallback — there is no transcript to fork yet.
      if (backend === this.primary && isConnectionError(err)) {
        this.tripPrimaryDown();
        console.warn("[session-store] PostgreSQL unreachable — new sessions will use the local fallback until it recovers.");
        const record = await this.fallback.createSession(cwd, provider, model, activeMode, effortLevel, title, sessionId, modelConfig);
        this.owner.set(record.sessionId, "fallback");
        return record;
      }
      throw err;
    }
  }

  saveMessage(sessionId: string, message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">): Promise<StoredMessage> {
    return this.write(sessionId, (s) => s.saveMessage(sessionId, message));
  }

  saveToolExecution(sessionId: string, execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">): Promise<StoredToolExecution> {
    return this.write(sessionId, (s) => s.saveToolExecution(sessionId, execution));
  }

  updateTokenTelemetry(sessionId: string, telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">): Promise<StoredTokenTelemetry> {
    return this.write(sessionId, (s) => s.updateTokenTelemetry(sessionId, telemetry));
  }

  updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord> {
    return this.write(sessionId, (s) => s.updateSessionModelConfig(sessionId, config));
  }

  getSessionHydration(sessionId: string): Promise<SessionHydration | null> {
    return this.read(sessionId, (s) => s.getSessionHydration(sessionId), (v) => v !== null);
  }

  async listSessions(cwd?: string): Promise<SessionRecord[]> {
    // Union across backends — sessions may be split between them across a failover, but each
    // id is owned by one, so a dedup by sessionId is the single-source view.
    const [a, b] = await Promise.allSettled([this.primary.listSessions(cwd), this.fallback.listSessions(cwd)]);
    const merged = new Map<string, SessionRecord>();
    for (const res of [a, b]) {
      if (res.status === "fulfilled") for (const r of res.value) if (!merged.has(r.sessionId)) merged.set(r.sessionId, r);
    }
    return [...merged.values()].sort((x, y) => y.updatedAt - x.updatedAt);
  }

  updateSessionStatus(sessionId: string, status: SessionRecord["status"]): Promise<void> {
    return this.write(sessionId, (s) => s.updateSessionStatus(sessionId, status));
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.write(sessionId, (s) => s.archiveSession(sessionId));
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const pinned = this.owner.get(sessionId);
    if (pinned) {
      const done = await this.write(sessionId, (s) => s.deleteSession(sessionId));
      this.owner.delete(sessionId);
      return done;
    }
    // Owner unknown: remove from whichever has it (both, so a previously-forked id is cleaned).
    const [x, y] = await Promise.all([
      this.primary.deleteSession(sessionId).catch(() => false),
      this.fallback.deleteSession(sessionId).catch(() => false),
    ]);
    return x || y;
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close().catch(() => {}), this.fallback.close().catch(() => {})]);
  }
}

/**
 * Picks the session store backend based on environment configuration:
 *   - `DATABASE_URL` set  → ResilientSessionStore (Postgres primary, LocalJson fallback)
 *   - otherwise           → LocalJsonSessionStore (offline dev fallback; warns once)
 */
export function createSessionStore(workspaceRoot?: string): SessionStore {
  if (process.env.DATABASE_URL) {
    return new ResilientSessionStore(process.env.DATABASE_URL, workspaceRoot);
  }

  if (!warnedAboutFallback) {
    console.warn(
      "[session-store] DATABASE_URL is not set — falling back to a local JSON file store " +
        "under .inflynx/sessions/. This is NOT the production backend. Run `pnpm docker:up` " +
        "and set DATABASE_URL to use PostgreSQL instead."
    );
    warnedAboutFallback = true;
  }

  return new LocalJsonSessionStore(workspaceRoot);
}

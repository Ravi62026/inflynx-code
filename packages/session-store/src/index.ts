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

export class ResilientSessionStore implements SessionStore {
  private primary: PostgresSessionStore;
  private fallback: LocalJsonSessionStore;
  private isFallback = false;

  constructor(connectionString: string, workspaceRoot?: string) {
    this.primary = new PostgresSessionStore(connectionString);
    this.fallback = new LocalJsonSessionStore(workspaceRoot);
  }

  private async execute<T>(fn: (store: SessionStore) => Promise<T>): Promise<T> {
    if (this.isFallback) {
      return fn(this.fallback);
    }
    try {
      return await fn(this.primary);
    } catch (err: any) {
      const isConnectionError =
        err?.code === "ECONNREFUSED" ||
        String(err?.message || "").includes("connect ECONNREFUSED") ||
        (Array.isArray(err?.errors) && err.errors.some((e: any) => e?.code === "ECONNREFUSED"));

      if (isConnectionError) {
        if (!this.isFallback) {
          console.warn(
            "[session-store] PostgreSQL offline (ECONNREFUSED) — gracefully failing over to LocalJsonSessionStore."
          );
          this.isFallback = true;
        }
        return fn(this.fallback);
      }
      throw err;
    }
  }

  createSession(
    cwd: string,
    provider: string,
    model: string,
    activeMode?: string,
    effortLevel?: string,
    title?: string,
    sessionId?: string,
    modelConfig?: Partial<SessionModelConfig>
  ): Promise<SessionRecord> {
    return this.execute((s) =>
      s.createSession(cwd, provider, model, activeMode, effortLevel, title, sessionId, modelConfig)
    );
  }

  saveMessage(
    sessionId: string,
    message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">
  ): Promise<StoredMessage> {
    return this.execute((s) => s.saveMessage(sessionId, message));
  }

  saveToolExecution(
    sessionId: string,
    execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">
  ): Promise<StoredToolExecution> {
    return this.execute((s) => s.saveToolExecution(sessionId, execution));
  }

  updateTokenTelemetry(
    sessionId: string,
    telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">
  ): Promise<StoredTokenTelemetry> {
    return this.execute((s) => s.updateTokenTelemetry(sessionId, telemetry));
  }

  updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord> {
    return this.execute((s) => s.updateSessionModelConfig(sessionId, config));
  }

  getSessionHydration(sessionId: string): Promise<SessionHydration | null> {
    return this.execute((s) => s.getSessionHydration(sessionId));
  }

  listSessions(cwd?: string): Promise<SessionRecord[]> {
    return this.execute((s) => s.listSessions(cwd));
  }

  close(): Promise<void> {
    return this.execute((s) => s.close());
  }
}

/**
 * Picks the session store backend based on environment configuration:
 *   - `DATABASE_URL` set  → ResilientSessionStore (attempts Postgres, falls back to LocalJson if offline)
 *   - otherwise           → LocalJsonSessionStore (offline dev fallback; warns once)
 */
export function createSessionStore(workspaceRoot?: string): SessionStore {
  if (process.env.DATABASE_URL) {
    return new ResilientSessionStore(process.env.DATABASE_URL, workspaceRoot);
  }

  if (!warnedAboutFallback) {
    console.warn(
      "[session-store] DATABASE_URL is not set — falling back to a local JSON file store " +
        "(.inflynx/session_store.json). This is NOT the production backend. Run `pnpm docker:up` " +
        "and set DATABASE_URL to use PostgreSQL instead."
    );
    warnedAboutFallback = true;
  }

  return new LocalJsonSessionStore(workspaceRoot);
}

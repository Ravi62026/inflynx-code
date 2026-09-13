/**
 * @inflynx/session-store
 * Persistence manager for sessions, messages, tool execution logs, and token
 * telemetry. PostgreSQL is the canonical backend; a local JSON file store is
 * used as an offline/no-Docker fallback only.
 */

import { LocalJsonSessionStore } from "./LocalJsonSessionStore.js";
import { PostgresSessionStore } from "./PostgresSessionStore.js";
import type { SessionStore } from "./types.js";

export * from "./types.js";
export { LocalJsonSessionStore } from "./LocalJsonSessionStore.js";
export { PostgresSessionStore } from "./PostgresSessionStore.js";

/**
 * @deprecated Renamed to `LocalJsonSessionStore` — this class was never
 * actually backed by SQLite. Kept as an alias for backward compatibility.
 */
export const SqliteSessionStore = LocalJsonSessionStore;

let warnedAboutFallback = false;

/**
 * Picks the session store backend based on environment configuration:
 *   - `DATABASE_URL` set  → PostgresSessionStore (canonical, production backend)
 *   - otherwise           → LocalJsonSessionStore (offline dev fallback; warns once)
 */
export function createSessionStore(workspaceRoot?: string): SessionStore {
  if (process.env.DATABASE_URL) {
    return new PostgresSessionStore(process.env.DATABASE_URL);
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

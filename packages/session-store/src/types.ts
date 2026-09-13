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
  status: "active" | "completed" | "failed" | "archived";
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
    modelConfig?: Partial<SessionModelConfig>
  ): Promise<SessionRecord>;
  saveMessage(sessionId: string, message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">): Promise<StoredMessage>;
  saveToolExecution(sessionId: string, execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">): Promise<StoredToolExecution>;
  updateTokenTelemetry(sessionId: string, telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">): Promise<StoredTokenTelemetry>;
  updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord>;
  getSessionHydration(sessionId: string): Promise<SessionHydration | null>;
  listSessions(cwd?: string): Promise<SessionRecord[]>;
  /** Releases underlying connections/handles, if any. Safe to call on stores that don't need it. */
  close(): Promise<void>;
}

/** Generates a session ID in the shared `session_<ts>_<rand>` format used across the codebase. */
export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

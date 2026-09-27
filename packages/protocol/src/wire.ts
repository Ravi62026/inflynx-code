/**
 * Canonical server ↔ extension wire types (Phase 47 / K2–K7).
 *
 * The whole K-series of drift bugs came from `apps/vscode/src/types.ts` *re-declaring* shapes the
 * server already sends (field-name and even type disagreements: `providerId` vs `provider`,
 * `turnsUsed/maxTurns` vs a raw `BudgetState` with no maxima, `postgres: boolean` vs a string). This
 * file is the single source of truth the server *produces* and the extension *consumes*, so a rename
 * on one side is a compile error on the other instead of a silent `undefined` / `NaN%` in the UI.
 */

export type AgentMode = "ask" | "plan" | "agent" | "debug";
export type AgentBudgetLevel = "low" | "medium" | "high" | "max";

/**
 * K3: a *normalized* budget with both the used and the maximum for each axis, so the status bar and
 * the context meter can compute a percentage instead of `undefined/undefined` / `NaN%`. This is NOT
 * the orchestrator's internal `BudgetState` (which carries no maxima); the orchestrator maps to this.
 */
export interface BudgetSnapshot {
  level: AgentBudgetLevel;
  turnsUsed: number;
  maxTurns: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  tokensUsed: number;
  maxTokens: number;
  /** 0-100 occupancy of the model window, or 0 when the window is unknown. */
  contextUtilizationPercent: number;
  exhausted: boolean;
}

/** K4: health is a *string* per store, not a boolean — "error" is truthy, so a boolean lies. */
export type PostgresHealth = "connected" | "error" | "disconnected";
export type RedisHealth = "connected" | "optional_offline";

export interface ServerHealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  port?: number;
  workspaceRoot?: string;
  postgres: PostgresHealth;
  redis: RedisHealth;
  uptimeSeconds: number;
  timestamp: string;
}

/** K2: the session row exactly as the server serializes it (already mapped from the store's
 * `provider`/`effortLevel`/`status` + numeric timestamps via the server's `toWireSession`). */
export interface SessionRecordWire {
  sessionId: string;
  providerId: string;
  model: string;
  activeMode?: string;
  budgetLevel?: AgentBudgetLevel | string;
  reasoningEffort?: string;
  state?: string;
  title?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}

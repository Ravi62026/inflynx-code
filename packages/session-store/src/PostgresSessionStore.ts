/**
 * PostgresSessionStore — canonical, production session persistence backend.
 *
 * Run locally via `pnpm docker:up` (see `docker-compose.yml`), which brings up
 * a `inflynx-code-postgres` container. Connection is configured exclusively
 * via `DATABASE_URL` — there is deliberately NO hardcoded credential fallback
 * here; if `DATABASE_URL` is missing, `createSessionStore()` in `index.ts`
 * falls back to `LocalJsonSessionStore` instead of guessing credentials.
 */

import pg from "pg";
import path from "path";
import type {
  SessionStore,
  SessionRecord,
  StoredMessage,
  StoredToolExecution,
  StoredTokenTelemetry,
  SessionHydration,
  SessionModelConfig,
} from "./types.js";
import { generateSessionId } from "./types.js";
import { MIGRATIONS } from "./migrations.js";

const { Pool } = pg;

export class PostgresSessionStore implements SessionStore {
  private pool: pg.Pool;
  private migrationsPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error(
        "PostgresSessionStore requires a connection string. Set DATABASE_URL " +
          "(see .env.example) or run `pnpm docker:up` to start the bundled Postgres container."
      );
    }
    this.pool = new Pool({ connectionString });
  }

  /**
   * Runs any not-yet-applied migrations, each in its own transaction, tracked
   * in `schema_migrations`. Idempotent and safe to call from every public
   * method — concurrent callers racing this on first use is harmless because
   * each migration is wrapped in `BEGIN`/`COMMIT` and guarded by
   * `INSERT ... ON CONFLICT DO NOTHING` on the tracking table.
   */
  private async ensureMigrated(): Promise<void> {
    if (!this.migrationsPromise) {
      this.migrationsPromise = this.runMigrations();
    }
    return this.migrationsPromise;
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id VARCHAR(128) PRIMARY KEY,
          applied_at BIGINT NOT NULL
        );
      `);

      const appliedRes = await client.query<{ id: string }>(`SELECT id FROM schema_migrations`);
      const applied = new Set(appliedRes.rows.map((r) => r.id));

      for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) continue;

        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
            [migration.id, Date.now()]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration "${migration.id}" failed: ${(err as Error).message}`);
        }
      }
    } finally {
      client.release();
    }
  }

  async createSession(
    cwd: string,
    provider: string,
    model: string,
    activeMode: string = "agent",
    effortLevel: string = "medium",
    title?: string,
    sessionId?: string,
    modelConfig?: Partial<SessionModelConfig>
  ): Promise<SessionRecord> {
    await this.ensureMigrated();

    const id = sessionId || generateSessionId();
    const record: SessionRecord = {
      sessionId: id,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider,
      model,
      credentialProfileId: modelConfig?.credentialProfileId,
      baseUrl: modelConfig?.baseUrl,
      reasoningEffort: modelConfig?.reasoningEffort,
      actualModel: modelConfig?.actualModel,
      activeMode,
      effortLevel,
      title: title || `Session in ${path.basename(cwd)}`,
      status: "active",
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_sessions (
          session_id, cwd, created_at, updated_at, provider, model,
          credential_profile_id, base_url, reasoning_effort, actual_model,
          active_mode, effort_level, title, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          record.sessionId,
          record.cwd,
          record.createdAt,
          record.updatedAt,
          record.provider,
          record.model,
          record.credentialProfileId || null,
          record.baseUrl || null,
          record.reasoningEffort || null,
          record.actualModel || null,
          record.activeMode,
          record.effortLevel,
          record.title,
          record.status,
        ]
      );
      await client.query(
        `INSERT INTO agent_token_telemetry (session_id, prompt_tokens, completion_tokens, reasoning_tokens, estimated_cost_usd, updated_at)
         VALUES ($1, 0, 0, 0, 0.0, $2)`,
        [record.sessionId, record.createdAt]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return record;
  }

  async saveMessage(
    sessionId: string,
    message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">
  ): Promise<StoredMessage> {
    await this.ensureMigrated();

    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = Date.now();

    try {
      await this.pool.query(
        `INSERT INTO agent_messages (
          id, session_id, role, content, reasoning_content, tool_call_id,
          tool_calls_json, provider_metadata_json, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          sessionId,
          message.role,
          message.content || null,
          message.reasoningContent || null,
          message.toolCallId || null,
          message.toolCallsJson || null,
          message.providerMetadataJson || null,
          timestamp,
        ]
      );
    } catch (err: any) {
      if (err?.code === "23503") {
        // foreign_key_violation — session_id has no matching agent_sessions row.
        throw new Error(
          `saveMessage() failed: no session record exists for sessionId "${sessionId}" ` +
            `(FK violation on agent_messages.session_id). This indicates a session-ID ` +
            `mismatch bug in the caller — createSession() must be awaited with this exact ` +
            `ID before any message is saved. Original error: ${err.message}`
        );
      }
      throw err;
    }

    await this.pool.query(`UPDATE agent_sessions SET updated_at = $1 WHERE session_id = $2`, [timestamp, sessionId]);

    return { ...message, id, sessionId, timestamp };
  }

  async saveToolExecution(
    sessionId: string,
    execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">
  ): Promise<StoredToolExecution> {
    await this.ensureMigrated();

    const id = `tool_exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = Date.now();

    try {
      await this.pool.query(
        `INSERT INTO agent_tool_executions (id, session_id, tool_call_id, tool_name, args_json, output, is_error, duration_ms, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, sessionId, execution.toolCallId, execution.toolName, execution.argsJson, execution.output, execution.isError, execution.durationMs, timestamp]
      );
    } catch (err: any) {
      if (err?.code === "23503") {
        throw new Error(
          `saveToolExecution() failed: no session record exists for sessionId "${sessionId}" ` +
            `(FK violation on agent_tool_executions.session_id). Original error: ${err.message}`
        );
      }
      throw err;
    }

    return { ...execution, id, sessionId, timestamp };
  }

  async updateTokenTelemetry(
    sessionId: string,
    telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">
  ): Promise<StoredTokenTelemetry> {
    await this.ensureMigrated();

    const updatedAt = Date.now();

    await this.pool.query(
      `INSERT INTO agent_token_telemetry (session_id, prompt_tokens, completion_tokens, reasoning_tokens, estimated_cost_usd, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE SET
         prompt_tokens = EXCLUDED.prompt_tokens,
         completion_tokens = EXCLUDED.completion_tokens,
         reasoning_tokens = EXCLUDED.reasoning_tokens,
         estimated_cost_usd = EXCLUDED.estimated_cost_usd,
         updated_at = EXCLUDED.updated_at`,
      [sessionId, telemetry.promptTokens, telemetry.completionTokens, telemetry.reasoningTokens, telemetry.estimatedCostUsd, updatedAt]
    );

    return {
      sessionId,
      promptTokens: telemetry.promptTokens,
      completionTokens: telemetry.completionTokens,
      reasoningTokens: telemetry.reasoningTokens,
      estimatedCostUsd: telemetry.estimatedCostUsd,
      updatedAt,
    };
  }

  async updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord> {
    await this.ensureMigrated();
    const updatedAt = Date.now();
    const result = await this.pool.query(
      `UPDATE agent_sessions
       SET provider = $1, model = $2, credential_profile_id = $3, base_url = $4,
           reasoning_effort = $5, actual_model = $6, updated_at = $7
       WHERE session_id = $8
       RETURNING *`,
      [
        config.provider,
        config.model,
        config.credentialProfileId || null,
        config.baseUrl || null,
        config.reasoningEffort || null,
        config.actualModel || null,
        updatedAt,
        sessionId,
      ]
    );
    if (result.rows.length === 0) throw new Error(`Cannot update missing session "${sessionId}".`);
    return this.mapSessionRow(result.rows[0]);
  }

  async getSessionHydration(sessionId: string): Promise<SessionHydration | null> {
    await this.ensureMigrated();

    const sRes = await this.pool.query(`SELECT * FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    if (sRes.rows.length === 0) return null;

    const session = this.mapSessionRow(sRes.rows[0]);

    const mRes = await this.pool.query(`SELECT * FROM agent_messages WHERE session_id = $1 ORDER BY timestamp ASC`, [sessionId]);
    const messages: StoredMessage[] = mRes.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content || undefined,
      reasoningContent: r.reasoning_content || undefined,
      toolCallId: r.tool_call_id || undefined,
      toolCallsJson: r.tool_calls_json || undefined,
      providerMetadataJson: r.provider_metadata_json || undefined,
      timestamp: Number(r.timestamp),
    }));

    const tRes = await this.pool.query(`SELECT * FROM agent_tool_executions WHERE session_id = $1 ORDER BY timestamp ASC`, [sessionId]);
    const toolExecutions: StoredToolExecution[] = tRes.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      toolCallId: r.tool_call_id,
      toolName: r.tool_name,
      argsJson: r.args_json,
      output: r.output,
      isError: r.is_error,
      durationMs: r.duration_ms,
      timestamp: Number(r.timestamp),
    }));

    const telemRes = await this.pool.query(`SELECT * FROM agent_token_telemetry WHERE session_id = $1`, [sessionId]);
    const telemRow = telemRes.rows[0];
    const telemetry: StoredTokenTelemetry = telemRow
      ? {
          sessionId: telemRow.session_id,
          promptTokens: telemRow.prompt_tokens,
          completionTokens: telemRow.completion_tokens,
          reasoningTokens: telemRow.reasoning_tokens,
          estimatedCostUsd: Number(telemRow.estimated_cost_usd),
          updatedAt: Number(telemRow.updated_at),
        }
      : {
          sessionId,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          estimatedCostUsd: 0,
          updatedAt: session.createdAt,
        };

    return { session, messages, toolExecutions, telemetry };
  }

  async listSessions(cwd?: string): Promise<SessionRecord[]> {
    await this.ensureMigrated();

    const query = cwd
      ? `SELECT * FROM agent_sessions WHERE cwd = $1 ORDER BY updated_at DESC`
      : `SELECT * FROM agent_sessions ORDER BY updated_at DESC`;
    const params = cwd ? [cwd] : [];

    const res = await this.pool.query(query, params);
    return res.rows.map((row) => this.mapSessionRow(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapSessionRow(row: any): SessionRecord {
    return {
      sessionId: row.session_id,
      cwd: row.cwd,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provider: row.provider,
      model: row.model,
      credentialProfileId: row.credential_profile_id || undefined,
      baseUrl: row.base_url || undefined,
      reasoningEffort: row.reasoning_effort || undefined,
      actualModel: row.actual_model || undefined,
      activeMode: row.active_mode,
      effortLevel: row.effort_level,
      title: row.title,
      status: row.status,
    };
  }
}

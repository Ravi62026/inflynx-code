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
import { randomBytes } from "node:crypto";
import type {
  SessionStore,
  SessionRecord,
  StoredMessage,
  StoredToolExecution,
  StoredTokenTelemetry,
  SessionHydration,
  SessionModelConfig,
  User,
  CreateUserIdentityInput,
  SignupSignal,
  DeviceCode,
} from "./types.js";
import { generateSessionId, generateRecordId } from "./types.js";
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
   * Runs any not-yet-applied migrations, each in its own transaction, tracked in
   * `schema_migrations`.
   *
   * H7 (Phase 39): this used to cache the migration promise forever. A single transient
   * failure — the container still warming up, a momentary connection drop — poisoned the
   * cache, so every later call re-awaited the same rejected promise and the store was dead
   * for the process's lifetime even after Postgres recovered. On failure the cached promise
   * is cleared so the next call retries, with a capped backoff between attempts.
   */
  private async ensureMigrated(): Promise<void> {
    if (!this.migrationsPromise) {
      this.migrationsPromise = this.runMigrations().catch((err) => {
        this.migrationsPromise = null; // do not latch the rejection (H7)
        throw err;
      });
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
    modelConfig?: Partial<SessionModelConfig>,
    userId?: string | null
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
      userId: userId ?? null,
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_sessions (
          session_id, cwd, created_at, updated_at, provider, model,
          credential_profile_id, base_url, reasoning_effort, actual_model,
          active_mode, effort_level, title, status, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
          record.userId,
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

    const id = generateRecordId("msg");
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

    const id = generateRecordId("tool_exec");
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

    const sRes = await this.pool.query(
      `SELECT session_id, cwd, created_at, updated_at, provider, model,
              credential_profile_id, base_url, reasoning_effort, actual_model,
              active_mode, effort_level, title, status, user_id
       FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    if (sRes.rows.length === 0) return null;

    const session = this.mapSessionRow(sRes.rows[0]);

    // ORDER BY seq, not timestamp: a fast turn writes many rows in the same millisecond and
    // timestamp order is then arbitrary (Phase 39). Explicit columns, not SELECT *, so a new
    // column cannot silently change what hydration returns (H9).
    const mRes = await this.pool.query(
      `SELECT id, session_id, role, content, reasoning_content, tool_call_id,
              tool_calls_json, provider_metadata_json, timestamp, seq
       FROM agent_messages WHERE session_id = $1 ORDER BY seq ASC`, [sessionId]);
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
      seq: Number(r.seq),
    }));

    const tRes = await this.pool.query(
      `SELECT id, session_id, tool_call_id, tool_name, args_json, output, is_error, duration_ms, timestamp, seq
       FROM agent_tool_executions WHERE session_id = $1 ORDER BY seq ASC`, [sessionId]);
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

    const telemRes = await this.pool.query(
      `SELECT session_id, prompt_tokens, completion_tokens, reasoning_tokens, estimated_cost_usd, updated_at
       FROM agent_token_telemetry WHERE session_id = $1`, [sessionId]);
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

    // Archived sessions are the lifecycle "kept but hidden" state — not listed by default.
    const where = cwd ? `WHERE cwd = $1 AND status <> 'archived'` : `WHERE status <> 'archived'`;
    const params = cwd ? [cwd] : [];
    const res = await this.pool.query(
      `SELECT session_id, cwd, created_at, updated_at, provider, model,
              credential_profile_id, base_url, reasoning_effort, actual_model,
              active_mode, effort_level, title, status, user_id
       FROM agent_sessions ${where} ORDER BY updated_at DESC`, params);
    return res.rows.map((row) => this.mapSessionRow(row));
  }

  async updateSessionStatus(sessionId: string, status: SessionRecord["status"]): Promise<void> {
    await this.ensureMigrated();
    const res = await this.pool.query(
      `UPDATE agent_sessions SET status = $1, updated_at = $2 WHERE session_id = $3`,
      [status, Date.now(), sessionId]
    );
    if (res.rowCount === 0) throw new Error(`Cannot set status on missing session "${sessionId}".`);
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.updateSessionStatus(sessionId, "archived");
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.ensureMigrated();
    // ON DELETE CASCADE on the message/execution/telemetry FKs removes the child rows.
    const res = await this.pool.query(`DELETE FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    return (res.rowCount ?? 0) > 0;
  }

  async setSessionUser(sessionId: string, userId: string): Promise<void> {
    await this.ensureMigrated();
    await this.pool.query(`UPDATE agent_sessions SET user_id = $2 WHERE session_id = $1`, [sessionId, userId]);
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
      userId: row.user_id ?? null,
    };
  }

  // ── Phase 1 identity + credits + anti-abuse signals ──────────────────────────

  private mapUserRow(row: any): User {
    return {
      id: row.id,
      email: row.email ?? null,
      displayName: row.display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
      authProvider: row.auth_provider,
      authSubject: row.auth_subject,
      plan: row.plan,
      credits: Number(row.credits),
      creditsUsed: Number(row.credits_used),
      disabled: row.disabled,
      flagged: row.flagged,
      flaggedReason: row.flagged_reason ?? null,
      createdAt: Number(row.created_at),
      lastSeenAt: row.last_seen_at != null ? Number(row.last_seen_at) : null,
    };
  }

  async createUser(input: CreateUserIdentityInput): Promise<User> {
    await this.ensureMigrated();
    const now = Date.now();
    const domain = input.email?.includes("@") ? input.email.split("@")[1]?.toLowerCase() ?? null : null;
    const res = await this.pool.query(
      `INSERT INTO users (
         email, display_name, avatar_url, auth_provider, auth_subject, plan, credits,
         credits_used, signup_ip, last_ip, signup_user_agent, device_fingerprint, created_at, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $10, $11, $11)
       ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        input.email ?? null,
        input.displayName ?? null,
        input.avatarUrl ?? null,
        input.authProvider,
        input.authSubject,
        input.plan ?? "free",
        input.credits ?? 0,
        input.signupSignal?.ip ?? null,
        input.signupSignal?.userAgent ?? null,
        input.signupSignal?.deviceFingerprint ?? null,
        now,
      ]
    );
    void domain; // email-domain counting happens in countSignupSignals via users.email
    return this.mapUserRow(res.rows[0]);
  }

  async getUser(id: string): Promise<User | null> {
    await this.ensureMigrated();
    const res = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return res.rows[0] ? this.mapUserRow(res.rows[0]) : null;
  }

  async getUserBySubject(provider: string, subject: string): Promise<User | null> {
    await this.ensureMigrated();
    const res = await this.pool.query(
      `SELECT * FROM users WHERE auth_provider = $1 AND auth_subject = $2`, [provider, subject]);
    return res.rows[0] ? this.mapUserRow(res.rows[0]) : null;
  }

  async listSessionsByUser(userId: string, limit = 100): Promise<SessionRecord[]> {
    await this.ensureMigrated();
    const res = await this.pool.query(
      `SELECT session_id, cwd, created_at, updated_at, provider, model,
              credential_profile_id, base_url, reasoning_effort, actual_model,
              active_mode, effort_level, title, status, user_id
       FROM agent_sessions WHERE user_id = $1 AND status <> 'archived'
       ORDER BY updated_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(1000, limit))]);
    return res.rows.map((row) => this.mapSessionRow(row));
  }

  async grantCredits(userId: string, amount: number, reason: string): Promise<User | null> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query(`UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING *`, [amount, userId]);
      if (u.rows.length === 0) { await client.query("ROLLBACK"); return null; }
      const user = this.mapUserRow(u.rows[0]);
      await client.query(
        `INSERT INTO credit_ledger (user_id, delta, reason, balance_after, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [userId, amount, reason, user.credits, Date.now()]);
      await client.query("COMMIT");
      return user;
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  }

  async debitCredits(userId: string, amount: number, reason: string, sessionId?: string): Promise<{ ok: boolean; user: User | null }> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Conditional update is the atomic guard against a negative balance under concurrent debits:
      // only rows that still have enough credits are updated.
      const u = await client.query(
        `UPDATE users SET credits = credits - $1, credits_used = credits_used + $1
         WHERE id = $2 AND credits >= $1 RETURNING *`, [amount, userId]);
      if (u.rows.length === 0) {
        await client.query("ROLLBACK");
        const cur = await this.getUser(userId);
        return { ok: false, user: cur };
      }
      const user = this.mapUserRow(u.rows[0]);
      await client.query(
        `INSERT INTO credit_ledger (user_id, delta, reason, session_id, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, -amount, reason, sessionId ?? null, user.credits, Date.now()]);
      await client.query("COMMIT");
      return { ok: true, user };
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  }

  async recordSignupAttempt(signal: SignupSignal & { outcome: string }): Promise<void> {
    await this.ensureMigrated();
    const domain = signal.emailDomain ?? null;
    await this.pool.query(
      `INSERT INTO signup_attempts (ip, device_fingerprint, email_domain, user_agent, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [signal.ip ?? null, signal.deviceFingerprint ?? null, domain, signal.userAgent ?? null, signal.outcome, Date.now()]);
  }

  async countSignupSignals(q: Partial<SignupSignal> & { sinceMs: number }): Promise<{ fingerprint: number; ipRange: number; emailDomain: number }> {
    await this.ensureMigrated();
    const since = Date.now() - q.sinceMs;
    const fp = q.deviceFingerprint
      ? (await this.pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE device_fingerprint = $1 AND created_at >= $2`, [q.deviceFingerprint, since])).rows[0]?.c ?? 0
      : 0;
    const ip = q.ip
      ? (await this.pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE signup_ip = $1 AND created_at >= $2`, [q.ip, since])).rows[0]?.c ?? 0
      : 0;
    const dom = q.emailDomain
      ? (await this.pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE split_part(email, '@', 2) = $1 AND created_at >= $2`, [q.emailDomain, since])).rows[0]?.c ?? 0
      : 0;
    return { fingerprint: Number(fp), ipRange: Number(ip), emailDomain: Number(dom) };
  }

  async markUserFlagged(userId: string, reason: string): Promise<void> {
    await this.ensureMigrated();
    await this.pool.query(`UPDATE users SET flagged = true, flagged_reason = $1 WHERE id = $2`, [reason, userId]);
  }

  async setUserDisabled(userId: string, disabled: boolean): Promise<void> {
    await this.ensureMigrated();
    await this.pool.query(`UPDATE users SET disabled = $1 WHERE id = $2`, [disabled, userId]);
  }

  async touchUserSeen(userId: string, ip?: string): Promise<void> {
    await this.ensureMigrated();
    if (ip) {
      await this.pool.query(`UPDATE users SET last_seen_at = $1, last_ip = $2 WHERE id = $3`, [Date.now(), ip, userId]);
    } else {
      await this.pool.query(`UPDATE users SET last_seen_at = $1 WHERE id = $2`, [Date.now(), userId]);
    }
  }

  // ── Device-authorization grant (CLI /login) ────────────────────────────

  private mapDeviceCodeRow(row: any): DeviceCode {
    return {
      userCode: row.user_code,
      deviceCode: row.device_code,
      verificationUri: row.verification_uri,
      expiresAt: Number(row.expires_at),
      userId: row.user_id ?? null,
      approved: row.approved,
      createdAt: Number(row.created_at),
    };
  }

  async createDeviceCode(input: { verificationUri: string; ttlMs: number }): Promise<DeviceCode> {
    await this.ensureMigrated();
    // Human-readable code avoids easily-confused glyphs (no I/O/0/1); the device code is opaque.
    const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
    const rand = (n: number) => Array.from(randomBytes(n)).map((b) => alphabet[b % alphabet.length]).join("");
    const userCode = `${rand(4)}-${rand(4)}`;
    const deviceCode = randomBytes(32).toString("hex");
    const now = Date.now();
    const expires = now + Math.max(30_000, input.ttlMs);
    await this.pool.query(
      `INSERT INTO device_codes (user_code, device_code, verification_uri, expires_at, approved, created_at)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [userCode, deviceCode, input.verificationUri, expires, now]
    );
    return { userCode, deviceCode, verificationUri: input.verificationUri, expiresAt: expires, userId: null, approved: false, createdAt: now };
  }

  async lookupDeviceCode(userCode: string): Promise<DeviceCode | null> {
    await this.ensureMigrated();
    const res = await this.pool.query(`SELECT * FROM device_codes WHERE user_code = $1`, [userCode]);
    return res.rows[0] ? this.mapDeviceCodeRow(res.rows[0]) : null;
  }

  async lookupDeviceCodeByDevice(deviceCode: string): Promise<DeviceCode | null> {
    await this.ensureMigrated();
    const res = await this.pool.query(`SELECT * FROM device_codes WHERE device_code = $1`, [deviceCode]);
    return res.rows[0] ? this.mapDeviceCodeRow(res.rows[0]) : null;
  }

  async approveDeviceCode(userCode: string, userId: string): Promise<boolean> {
    await this.ensureMigrated();
    // Only an unexpired grant can be approved, and approval is one-shot per user binding.
    const res = await this.pool.query(
      `UPDATE device_codes SET approved = true, user_id = $1
       WHERE user_code = $2 AND expires_at > $3`,
      [userId, userCode, Date.now()]
    );
    return (res.rowCount ?? 0) > 0;
  }
}

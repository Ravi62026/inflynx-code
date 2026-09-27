/**
 * Postgres schema migrations for @inflynx/session-store.
 *
 * Kept as inline SQL strings (rather than separate .sql files) so the
 * migration runner works identically from `src` (tsx) and compiled `dist`
 * without needing a separate asset-copy build step.
 *
 * Add new migrations by appending to this array — never edit an already-
 * applied migration's SQL in place. Each migration runs exactly once,
 * tracked in the `schema_migrations` table, inside its own transaction.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        cwd TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        provider VARCHAR(32) NOT NULL,
        model VARCHAR(64) NOT NULL,
        active_mode VARCHAR(16) NOT NULL,
        effort_level VARCHAR(16) NOT NULL,
        title TEXT,
        status VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        role VARCHAR(16) NOT NULL,
        content TEXT,
        reasoning_content TEXT,
        tool_call_id VARCHAR(64),
        tool_calls_json TEXT,
        timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_tool_executions (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        tool_call_id VARCHAR(64) NOT NULL,
        tool_name VARCHAR(64) NOT NULL,
        args_json TEXT NOT NULL,
        output TEXT NOT NULL,
        is_error BOOLEAN NOT NULL,
        duration_ms INT NOT NULL,
        timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_token_telemetry (
        session_id VARCHAR(64) PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        prompt_tokens INT NOT NULL,
        completion_tokens INT NOT NULL,
        reasoning_tokens INT NOT NULL,
        estimated_cost_usd DOUBLE PRECISION NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
  },
  {
    id: "0002_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_ts
        ON agent_messages(session_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_session_ts
        ON agent_tool_executions(session_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_cwd_updated
        ON agent_sessions(cwd, updated_at DESC);
    `,
  },
  {
    id: "0003_model_profiles_and_continuations",
    sql: `
      ALTER TABLE agent_sessions
        ADD COLUMN IF NOT EXISTS credential_profile_id VARCHAR(128),
        ADD COLUMN IF NOT EXISTS base_url TEXT,
        ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16),
        ADD COLUMN IF NOT EXISTS actual_model VARCHAR(256);

      ALTER TABLE agent_messages
        ADD COLUMN IF NOT EXISTS provider_metadata_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_credential_profile
        ON agent_sessions(credential_profile_id)
        WHERE credential_profile_id IS NOT NULL;
    `,
  },
  {
    // Phase 39. `timestamp` is only millisecond-resolution, so ORDER BY it does not give a
    // total order — 200 messages written inside one millisecond hydrate in an arbitrary
    // sequence, and a session restored in the wrong order silently re-sends the model a
    // scrambled history. A monotonic BIGSERIAL is the real insertion order. Also widens
    // provider/model from VARCHAR (a long BYOK model id silently truncated) to TEXT.
    id: "0004_seq_and_text_columns",
    sql: `
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_seq
        ON agent_messages(session_id, seq);

      ALTER TABLE agent_tool_executions ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
      CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_session_seq
        ON agent_tool_executions(session_id, seq);

      ALTER TABLE agent_sessions ALTER COLUMN provider TYPE TEXT;
      ALTER TABLE agent_sessions ALTER COLUMN model TYPE TEXT;
      ALTER TABLE agent_sessions ALTER COLUMN active_mode TYPE TEXT;
      ALTER TABLE agent_sessions ALTER COLUMN effort_level TYPE TEXT;
    `,
  },
];

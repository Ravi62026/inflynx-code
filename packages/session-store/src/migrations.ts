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
  {
    // Phase 1 of the auth/users/credits plan. Identity, the credit ledger, and the anti-abuse
    // signals (IP + device fingerprint + signup attempts) so a single person cannot farm the
    // signup credit across throwaway accounts. `users` is keyed by (auth_provider, auth_subject)
    // so it works unchanged whether identity is managed (Clerk/Auth0/Supabase `sub`) or
    // self-hosted. Epoch-ms BIGINT timestamps match the rest of the schema (not timestamptz).
    id: "0005_auth_users_credits",
    sql: `
      CREATE EXTENSION IF NOT EXISTS citext;

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext UNIQUE,
        display_name TEXT,
        avatar_url TEXT,
        auth_provider TEXT NOT NULL,
        auth_subject TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        credits NUMERIC NOT NULL DEFAULT 0,
        credits_used NUMERIC NOT NULL DEFAULT 0,
        disabled BOOLEAN NOT NULL DEFAULT false,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flagged_reason TEXT,
        signup_ip INET,
        last_ip INET,
        signup_user_agent TEXT,
        device_fingerprint TEXT,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_subject
        ON users(auth_provider, auth_subject);
      CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint
        ON users(device_fingerprint) WHERE device_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_users_signup_ip
        ON users(signup_ip) WHERE signup_ip IS NOT NULL;

      -- Synthetic owner for any session that predates auth, so user_id can be NOT NULL later
      -- without orphaning historical rows.
      INSERT INTO users (id, auth_provider, auth_subject, plan, created_at)
        VALUES ('00000000-0000-0000-0000-000000000000', 'system', 'legacy', 'free', 0)
        ON CONFLICT (auth_provider, auth_subject) DO NOTHING;

      ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
      UPDATE agent_sessions SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated
        ON agent_sessions(user_id, updated_at DESC);

      -- Auditable grant/debit history; balance_after lets a ledger be replayed + reconciled.
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta NUMERIC NOT NULL,
        reason TEXT NOT NULL,
        session_id TEXT,
        balance_after NUMERIC NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_ts
        ON credit_ledger(user_id, created_at DESC);

      -- Groups the identities belonging to one physical person for reviewer visibility.
      CREATE TABLE IF NOT EXISTS account_links (
        auth_provider TEXT NOT NULL,
        auth_subject TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cluster_key TEXT NOT NULL,
        linked_at BIGINT NOT NULL,
        PRIMARY KEY (auth_provider, auth_subject)
      );

      -- Records EVERY signup attempt, including ones we block, so repeat attempts by the same
      -- fingerprint/IP are still counted rather than silently dropped.
      CREATE TABLE IF NOT EXISTS signup_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ip INET,
        device_fingerprint TEXT,
        email_domain TEXT,
        user_agent TEXT,
        outcome TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signup_attempts_fp_ts
        ON signup_attempts(device_fingerprint, created_at DESC);

      -- OAuth 2.0 device-authorization grant for the CLI /login flow.
      CREATE TABLE IF NOT EXISTS device_codes (
        user_code TEXT PRIMARY KEY,
        device_code TEXT NOT NULL,
        verification_uri TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        user_id UUID REFERENCES users(id),
        approved BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL
      );
    `,
  },
];

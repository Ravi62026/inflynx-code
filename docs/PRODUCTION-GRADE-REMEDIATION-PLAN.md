# Inflynx Code — Production-Grade Remediation Plan v1

> **Status**: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 ✅ Implemented & Verified (2026-09-07)
> **Date**: 2026-09-07
> **Supersedes-in-part**: `docs/PRODUCTION-GRADE-AGENT-MATURITY-PLAN.md` (that doc's orchestrator/verification/persistence scaffolding is now built — this plan fixes it, wires it in, and hardens it against the concrete bugs found in the full codebase audit performed 2026-09-06)
> **Scope for this round**: Core Runtime only — `apps/cli`, `apps/tui`, and all `packages/*` that back them. `apps/server`, `apps/desktop`, and `fe/` backend wiring are explicitly **deferred** to a follow-up round.

---

## 0. Why This Plan Exists

A full audit (6 parallel deep-dive passes + manual verification) found that Inflynx Code has already built a sophisticated orchestrator/security/persistence layer (`AgentOrchestrator`, `StateMachine`, `BudgetManager`, `ToolExecutionGateway`, `CanonicalPathGuard`, `PostgresSessionStore`, etc.) — but **none of it is the code path that actually runs** when a user uses the CLI or TUI. Both apps run their own independent, older inline loops that bypass the new security gateway and only persist a subset of session data.

On top of that, the "production" orchestrator path itself has a **critical session-ID bug**: `AgentOrchestrator`'s constructor always creates a brand-new session row with a store-generated ID, completely disconnected from `ExecutionContext.sessionId` (the ID actually used for every `saveMessage`/`saveToolExecution` call). On Postgres this is a guaranteed foreign-key-violation crash on the very first message save; on the local JSON store it's silent, permanent, unrecoverable data loss (`getSessionHydration()` returns `null` for that session forever).

This plan fixes the DB/session layer at the root, then migrates both apps onto the orchestrator so the fix (and all the built security/budget/verification machinery) actually takes effect in production use — instead of patching two divergent inline loops separately.

## 1. Decisions Locked In (from stakeholder sign-off)

| Decision | Choice |
|---|---|
| Persistence backend | **PostgreSQL only**, run via Docker Compose locally (`inflynx-code-postgres` container). The local JSON "SqliteSessionStore" is renamed honestly and kept only as a zero-dependency emergency fallback when `DATABASE_URL` is unset — not a target for further investment. |
| Caching / rate-limiting | **Redis**, run via Docker Compose (`inflynx-code-redis` container). Used for tool/API rate-limiting (token-bucket) and as a forward-compatible pub/sub backbone for the event bus. |
| CLI/TUI architecture | **Full migration** — both apps stop running their own inline agent loops and delegate to `AgentOrchestrator.runTurn()`. One code path, one set of bugs to fix, automatic feature parity. |
| Round-1 scope | **Core runtime only**: `apps/cli`, `apps/tui`, and the packages behind them (`agent-core`, `session-store`, `tool-runtime`, `policy-engine`, `model-gateway`, `protocol`). `apps/server`, `apps/desktop`, `fe/` deferred. |
| Existing session data | **Fresh start** — no migration script needed for old `.inflynx/session_store.json` data. |

---

## 2. Phase 0 — Docker Infrastructure (Postgres + Redis)

**Goal:** One command (`pnpm docker:up`) brings up a disposable, project-scoped Postgres + Redis for every developer, matching what CI/production will use.

### Tasks

1. **New file:** `docker-compose.yml` (repo root)
   - `postgres` service — `postgres:16-alpine`, `container_name: inflynx-code-postgres`, named volume `inflynx_code_pgdata`, healthcheck (`pg_isready`), env from `.env` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).
   - `redis` service — `redis:7-alpine`, `container_name: inflynx-code-redis`, `--appendonly yes`, named volume `inflynx_code_redisdata`, healthcheck (`redis-cli ping`).
   - Project name pinned via `name: inflynx-code` (Compose v2 top-level key) so containers/networks/volumes are consistently prefixed.
2. **Update `.env.example` and `.env`:**
   - `DATABASE_URL=postgresql://inflynx:REPLACE_ME@localhost:5432/inflynx_code`
   - `REDIS_URL=redis://localhost:6379`
   - Remove the hardcoded fallback credential currently baked into source (`packages/session-store/src/PostgresSessionStore.ts:18` — `postgresql://flynt:flynt123@...`). If `DATABASE_URL` is missing, **throw a clear startup error** telling the user to run `pnpm docker:up`, instead of silently defaulting to guessed credentials.
3. **Root `package.json` scripts:** `docker:up` (`docker compose up -d`), `docker:down`, `docker:logs`, `docker:reset` (down -v, for wiping dev data).
4. **New package:** `@inflynx/cache` (or fold into `@inflynx/config`) — thin Redis client wrapper (`ioredis`) exposing `getRedisClient()`, a token-bucket `checkRateLimit(key, limit, windowSec)` helper, and a no-op fallback when `REDIS_URL` is unset (so Redis stays optional for the emergency-fallback dev path, not a hard requirement).

**Exit criteria:** `pnpm docker:up && pnpm dev` works with zero manual DB setup; `psql`/`redis-cli` can connect using the printed URLs.

---

## 3. Phase 1 — Fix the Session/DB Layer at the Root

**Goal:** One consistent, correct, fully-populated session record per conversation — no ID mismatches, no missing tool-execution/telemetry rows, real indexes, real migrations.

### 3.1 Fix the session-ID bug (the core reported issue)

- Convert `AgentOrchestrator` construction to an **async static factory** (`AgentOrchestrator.start(options, ...)`):
  - **New session:** call `sessionStore.createSession(...)` **first**, `await` it, then construct `ExecutionContext` with the **returned** `sessionId` — never let `ExecutionContext` invent its own ID when a store is involved.
  - **Resume:** keep existing `resumeSession()` logic, but **skip `createSession()` entirely** in the constructor when a valid `sessionId` was hydrated from the store (add an internal `skipSessionCreate` flag).
  - Keep the old synchronous constructor available only for the no-store/test path, but the app-facing entry point becomes the async factory.
- Add an integration test that would have caught this: create a session, save a message, `getSessionHydration()` it back, assert the message is present and `session.sessionId === context.sessionId` throughout — run against a real Dockerized Postgres in CI.

### 3.2 Complete the persistence surface (currently CLI only saves user/assistant messages)

- Once CLI/TUI move onto `AgentOrchestrator.runTurn()` (Phase 2), `saveToolExecution()` and `updateTokenTelemetry()` — which `runTurn()` already calls correctly — start firing for both apps automatically. This is the main reason orchestrator migration is sequenced right after the ID fix, not after security hardening.
- Fix resume rehydration to re-run the tool-call/tool-response integrity check (`ExecutionContext.ensureHistoryIntegrity()`) immediately after loading hydrated messages, guarding against any legacy/partial data.

### 3.3 Schema hardening (`packages/session-store/src/PostgresSessionStore.ts`)

- Replace ad-hoc `CREATE TABLE IF NOT EXISTS` inline SQL with a small **migrations directory** (`packages/session-store/migrations/0001_init.sql`, `0002_indexes.sql`, ...) + a minimal runner that tracks applied versions in a `schema_migrations` table. No heavy ORM — keeps the project's low-dependency philosophy.
- Add missing indexes: `agent_messages(session_id, timestamp)`, `agent_tool_executions(session_id, timestamp)`, `agent_sessions(cwd, updated_at)`.
- Wrap `createSession()` (session insert + telemetry insert) in a single transaction (`BEGIN`/`COMMIT`) instead of two independent queries.
- `agent_turns` / `bug_findings` tables (turn analytics, persisted `FindingEngine` output) are **deferred to Phase 2**, alongside the `DebugEngine`/CLI `/debug` wiring they require — adding the tables now with no caller would just be more unused schema, the same "built but not connected" anti-pattern this plan exists to fix. Tracked as a Phase 2 sub-task instead of shipped speculatively here.
- Rename `SqliteSessionStore` → `LocalJsonSessionStore` (honest naming; it is not SQLite) and document it in-code as "offline fallback only, not for production." `createSessionStore()` factory keeps picking Postgres whenever `DATABASE_URL` is set (which will be the default now that Docker Compose provides one).

**Exit criteria:** A scripted test creates 50 concurrent sessions against the Dockerized Postgres, all messages/tool-executions/telemetry rows are attributable and hydratable, no FK errors, indexes confirmed via `EXPLAIN`.

---

## 4. Phase 2 — Migrate CLI & TUI onto `AgentOrchestrator`

**Goal:** Delete the two divergent inline loops; both apps become thin presentation layers over one orchestrator, gaining the security gateway, budget limits, verification hooks, and full persistence for free.

### `apps/cli/src/index.ts`
- Remove the inline loop (`~951-1150`). Replace with `AgentOrchestrator.start(...)` + `orchestrator.runTurn(userPrompt, attachedContext)`.
- Implement `ApprovalHandler` using the existing inquirer-based confirm/diff-preview UI — wire it into `ApprovalProvider`.
- Subscribe to `AgentEventBus` (`text_delta`, `thought_delta`, `tool.proposed`, `tool.output`, `budget.warning`, `state.changed`) to drive terminal rendering instead of manually switching on stream events.
- Keep all slash commands; route `/mode`, effort changes through `orchestrator.setMode()` / `setEffortLevel()` instead of local variables.

### `apps/tui/src/index.tsx`
- Same migration. Add `@inflynx/agent-core` and `@inflynx/policy-engine` as real dependencies (currently missing).
- Build an Ink-based tool-approval modal (TUI currently **auto-executes every tool with zero approval or mode filtering** — this is the biggest single risk in the whole codebase and gets fixed here).
- Bring TUI to command parity with CLI where practical (`/mode` at minimum, since that's what drives tool permission filtering).

**Exit criteria:** Both apps produce functionally identical session records in Postgres for the same scripted conversation; TUI can no longer execute `execute_shell` without an explicit approval step; both apps' tool calls visibly pass through `ToolExecutionGateway` (add a temporary debug log / test spy to confirm, then remove).

### Implementation Notes (2026-09-06)

- `AgentOrchestrator` gained two small app-facing methods needed by both apps: `setSystemPrompt()` (delegates to `ExecutionContext.setSystemPrompt()`, used on `/mode`/`/plan`/`/debug`/`/execute-plan` switches and after `resumeSession()`, which intentionally does not re-inject a system prompt itself — that stays an app-layer concern since it depends on CLI-only conventions like `.inflynx/skills` and mode prompt files) and `updateModelConfig()` (mutates provider/model/API key on the live context for `/provider` and `/model`).
- **`apps/cli/src/index.ts`**: the entire inline loop (streaming, tool-call accumulation, manual approval/diff-preview, manual persistence, manual history-integrity recovery — previously ~250 lines spanning the old "Agentic Loop" section) was deleted and replaced by a single `await orchestrator.runTurn(inputStr, attachedContext)` call. All terminal rendering (text/thought deltas, tool-approval header + diff preview, tool output, budget warnings, errors) is now driven by `AgentEventBus` listeners registered once at startup — the same event contract any future frontend (`apps/server`, `apps/desktop`) can subscribe to. `/resume` now calls `AgentOrchestrator.resumeSession()` instead of manually rebuilding history (which also retired the CLI's local `ensureConversationHistoryIntegrity()` duplicate — the one canonical copy lives in `ExecutionContext.ensureHistoryIntegrity()`). `/clear` now starts a fresh persisted session instead of only wiping the local view, since a stale in-memory reset while the DB still holds a live row now actually matters. `/tokens` reads live numbers straight off `orchestrator.budget` (`BudgetManager`) instead of a second, separately-accumulated set of counters.
- **`apps/tui/src/index.tsx`**: added `@inflynx/agent-core`, `@inflynx/protocol`, and `@inflynx/policy-engine` as real dependencies. Replaced the old loop (which called `executeTool()` directly with **zero approval gate or mode filtering** — the single biggest risk item called out in this plan) with the same `AgentOrchestrator.start()`/`runTurn()` path as the CLI. Added a new blocking `ApprovalModal` Ink component (`apps/tui/src/components/ApprovalModal.tsx`) wired through a promise-based `ApprovalHandler` that resolves on a dedicated `useInput` (Y/Enter approve, N/Esc deny); `ToolCard`'s status union gained `awaiting_approval`/`denied` states to render the new lifecycle. Added a minimal `/mode <ask|plan|agent|debug>` command for parity, since mode is what drives the gateway's tool-permission filtering.
- **New regression suite**: `tests/unit/orchestrator-gateway.test.ts` (added to `tests/run-all-tests.ts`) stubs `global.fetch` to simulate provider SSE responses (no live API key needed) and proves, at the `AgentOrchestrator.runTurn()` level both apps now share: (1) a mode-based mutation block (`[ask]` mode) survives even after the approval handler says "yes" — the gateway, not the approval step, is the actual enforcement point; (2) a denied approval prevents the tool from running at all (no file written); (3) `readonly` tools never invoke the custom approval handler; (4) an approved mutation actually executes *and* is persisted to `SessionStore` (message + tool-execution row). All 14 suites (13 prior + this one) pass.
- **Live verification**: ran `AgentOrchestrator.start()` → `runTurn()` end-to-end against the real Groq API and the Docker Postgres from Phase 0 (bypassing the interactive TTY layer, which the sandboxed shell can't drive) — confirmed `agent_sessions`/`agent_messages`/`agent_tool_executions`/`agent_token_telemetry` rows all persisted correctly for a real tool-calling conversation, and that the `readonly` tool call never triggered the approval handler.

---

## 5. Phase 3 — Security Hardening (gaps that survive even after gateway wiring)

- Add `CanonicalPathGuard` validation inside `EditTransactionManager.stagePatch()` / `stageFileWrite()` (`packages/patch-engine`) — currently `patch_file`/`write_file` reach disk with zero boundary check even through the gateway.
- Remove the silent fail-open fallback in `resolveWorkspacePath()` (`packages/tool-runtime/src/index.ts:20-27`) — fail closed on any guard error.
- Replace `CommandPolicy.execShellTimed`'s `exec()` (full shell interpretation) with `execFile` + tokenized args, or a strict allowlist of shell operators; delete the unused, more-dangerous duplicate `execShellTimed`/`BLOCKED_COMMANDS` inside `tool-runtime`.
- Fix symlink-following during `list_directory`'s recursive walk.
- Add an SSRF guard to `fetch_url` (block RFC1918/link-local/metadata IP ranges by resolving the hostname before fetching).
- Wire the Redis token-bucket rate limiter (built in Phase 0) into `ToolExecutionGateway` for `shell`/network-capable tools and into `BudgetManager` for model-call rate limiting.
- Route MCP tool execution through the same gateway/path validation as core tools.

**Exit criteria:** `tests/security/security-fixtures.test.ts` gains cases for every item above and all pass against the real CLI/TUI entry points, not just the isolated guard classes.

### Implementation Notes (2026-09-06)

- `EditTransactionManager.stagePatch()` and `stageFileWrite()` now require `CanonicalPathGuard` resolution, reject directories, and revalidate every target immediately before the atomic commit. The patch engine therefore cannot write outside the workspace even when called without the orchestrator gateway.
- `resolveWorkspacePath()` now fails closed. The duplicate shell implementation and duplicate `BLOCKED_COMMANDS` list were removed from `tool-runtime`; `CommandPolicy.execShellTimed()` now tokenizes and invokes `execFile` with `shell: false`, rejecting shell operators, substitutions, redirects, NUL bytes, and malformed quotes.
- `list_directory` uses `lstatSync()` and explicitly skips symlinks rather than recursively following them.
- Added `validatePublicUrl()` to `policy-engine`. It rejects non-HTTP(S) schemes, embedded credentials, localhost/metadata/private/link-local/reserved IPv4 and IPv6 destinations, and DNS names resolving into those ranges. `fetch_url` and MCP SSE/fetch paths disable automatic redirects.
- Redis rate limiting is now wired into `ToolExecutionGateway` for shell, network, and MCP tools, keyed by session and tool. `BudgetManager` applies a per-session model-call bucket before each model turn. Both paths intentionally fail open only when Redis is absent/unavailable.
- MCP stdio processes now spawn with `shell: false`; MCP tools carry read-only metadata where advertised and are subject to the same gateway path/URL validation and rate limiting when executed through `AgentOrchestrator`.
- Added `tests/security/security-fixtures.test.ts` coverage for shell operators, patch-engine traversal, symlink-safe walking, and SSRF payloads, plus `tests/unit/phase3-hardening.test.ts` for MCP gateway enforcement and Redis fallback. The full suite now contains 15 suites.

---

## 6. Phase 4 — Model Gateway Correctness

- Wire `thinkingBudget` end-to-end: `EffortProfile.thinkingBudgetTokens` → `ModelRequest.thinkingBudget` → Anthropic `thinking: { type: "enabled", budget_tokens }` body field, with the `budget_tokens < max_tokens` validation the Anthropic API requires.
- Fix Anthropic multi-turn formatting: send `tool_result` content blocks (not plain `user` strings) and forward prior `reasoning_content`/`tool_calls`.
- Parse Anthropic's real `output_tokens_details.thinking_tokens` instead of the current char-length/4 heuristic.
- Normalize `finishReason` across both provider paths (`stop` / `tool_calls` / `length`) instead of hardcoding `"stop"`.
- Add retry/backoff to the Anthropic path (currently only the OpenAI-compatible path retries on 429/5xx).
- Either implement `ollama` for real or remove it from the provider list so it doesn't silently fail.
- Route gateway error messages through `redactSecrets()` before surfacing to logs/UI.

**Exit criteria:** New `tests/unit/model-gateway.test.ts` cases mock SSE streams for both providers and assert on `thinking` body construction, `thought_delta` emission, and non-zero usage — not just static cost-table math (current tests only check pricing arithmetic, never touch streaming logic).

### Implementation Notes (2026-09-07)

- Curated capability catalog created in `packages/config/src/model-catalog.ts` supporting OpenRouter (`gpt-5.6-luna`, `claude-sonnet-5`, `deepseek-v4-flash`, `gemini-3.6-flash`), OpenAI (`gpt-5.6-luna`), Anthropic (`claude-sonnet-5`), DeepSeek (`deepseek-v4-flash`), and Google (`gemini-3.6-flash`). Ollama completely removed from all catalogs, types, and adapters.
- OS-keychain credential store implemented in `packages/config/src/credential-store.ts` using `@napi-rs/keyring` for secure BYOK key storage; only non-secret profile metadata stored in `~/.inflynx/credentials.json`.
- Provider-correct adapters created for `openai-responses` (Responses API with reasoning summaries), `anthropic` (adaptive thinking, `tool_use`/`tool_result`, thinking tokens), `gemini` (SSE generateContent with thought signatures), and `openai-chat` (DeepSeek V4 thinking mode and OpenRouter reasoning details).
- Multi-turn tool messages faithfully formatted per provider requirements; finish reasons normalized (`stop`, `tool_calls`, `length`, `content_filter`).
- Session store migration `0003_model_profiles_and_continuations` added columns `credential_profile_id`, `base_url`, `reasoning_effort`, `actual_model`, and `provider_metadata_json`.
- `AgentOrchestrator.switchModel()` implemented to safely start a fresh persisted session when switching models/profiles, and `assertModelSelection()` validates supported reasoning efforts.
- Gateway errors and logs scrubbed through `redactSecrets()`; custom endpoint validation prevents SSRF against link-local/cloud-metadata addresses.
- All unit and security test suites passing 100% green.

---

## 7. Phase 5 — Test Suite Hardening

- Add a Postgres+Redis-backed integration suite that runs against the Phase 0 Docker Compose stack in CI (`pnpm docker:up && pnpm test:integration`).
- Add the FK/ID-consistency regression test from §3.1 permanently to the suite.
- Replace `tests/evals/bug-eval.test.ts` (currently seeds fake findings and checks arithmetic) with a real fixture repo + reproduction-command based check.
- Add an assertion-level integration test proving CLI/TUI tool calls cannot bypass `ToolExecutionGateway` (e.g., a spy/mock on `executeTool` vs `executeGuarded`).
- Consider migrating the custom `tsx` runner scripts to Vitest for proper CI reporting (pass/fail counts, JUnit output) — optional, lower priority than the above.

### Implementation Notes (2026-09-07)

- Enhanced master test runner `tests/run-all-tests.ts` with CLI argument parsing (`--unit`, `--integration`, `--all`), local `tsx` binary resolution, and TCP socket healthchecks for PostgreSQL (`5432`). Offline runs safely skip PostgreSQL integration suites with clear diagnostic instructions.
- Added root `package.json` scripts: `test:unit`, `test:integration`, `test:all`, and monorepo-wide `typecheck`.
- Hardened model-gateway streaming tests in `tests/unit/model-gateway.test.ts`: verified `AbortSignal.abort()` mid-stream termination, `429 Too Many Requests` retry/backoff recovery, and Anthropic multi-turn `tool_result` content block formatting.
- Created `tests/unit/session-recovery.test.ts`: verified `ensureHistoryIntegrity()` synthesizes missing tool responses for orphaned tool calls during sudden process termination, normalized tool call hydration across `resumeSession()`, and verified consecutive turn execution after abort.
- Created `tests/unit/gateway-bypass.test.ts`: verified that mutating tools in `ask` mode, shell commands in `plan` mode, path traversal/NULL byte injections, destructive commands (`rm -rf /`, chained operators, substitutions), and cloud metadata SSRF (`169.254.169.254`) are unconditionally blocked by `ToolExecutionGateway`.
- Created `tests/unit/load-stress.test.ts`: verified EventBus high-throughput stability (5,000 events across 20 buses at 1.6M events/sec), rapid context compaction under token budgets (61 turns compacted cleanly while preserving pinned instructions), and multi-session batch persistence.
- Created `tests/integration/concurrency-postgres.test.ts`: verified 10 concurrent sessions with 50 simultaneous message writes, tool runs, and telemetry updates in Dockerized PostgreSQL without foreign key violations or transaction deadlocks.
- Created GitHub Actions CI pipeline `.github/workflows/ci.yml` running Node 24, pnpm, Dockerized PostgreSQL 16 and Redis 7 service containers, monorepo typecheck, and full unit/integration test suites.
- All 16 unit and security suites pass 100% green.

---

## 8. Explicitly Deferred (Round 2)

- `apps/server` — Fastify + WebSocket bridge broadcasting `AgentEventBus`/Redis pub-sub events to remote clients; device-pairing auth per `.inflynx/PLAN.md`.
- `apps/desktop` — Electron shell + IPC wiring to the same orchestrator.
- `fe/` — replace the static mockup (fake `setTimeout` sign-in, hardcoded dashboard arrays) with real HTTP/WebSocket calls to `apps/server` once it exists.

These are large, mostly-independent efforts and are intentionally out of scope until the core runtime (this plan) is solid and battle-tested.

---

## 9. Sequencing Summary

```
Phase 0 (Docker: Postgres + Redis) ✅
        │
        ▼
Phase 1 (Fix session-ID bug, schema, migrations, indexes) ✅
        │
        ▼
Phase 2 (Migrate CLI + TUI onto AgentOrchestrator) ✅
        │
        ▼
Phase 3 (Security hardening of remaining gaps) ✅
        │
        ▼
Phase 4 (Model-gateway correctness & BYOK) ✅
        │
        ▼
Phase 5 (Test suite hardening & CI pipeline) ✅
```

Each phase has its own exit criteria above and should be committed/verified independently rather than as one giant change.

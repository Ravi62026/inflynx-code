/**
 * Integration Test for PostgresSessionStore against the Dockerized PostgreSQL
 * container (`pnpm docker:up` — see docker-compose.yml).
 */

import { PostgresSessionStore } from "../../packages/session-store/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { ToolRegistry } from "../../packages/tool-runtime/src/index.js";

async function runPostgresStoreTests() {
  console.log("🐘 Running PostgreSQL Session Store Integration Tests (Docker Container)...\n");

  const connectionString =
    process.env.DATABASE_URL || "postgresql://inflynx:inflynx_dev_pw@localhost:5432/inflynx_code";
  const store = new PostgresSessionStore(connectionString);

  try {
    // Test 1: Create Session in PostgreSQL
    const session = await store.createSession("/Users/ravishankar/Desktop/inflynx-code", "openai", "gpt-4o", "agent", "high", "Docker PostgreSQL Test Session");
    if (session && session.sessionId.startsWith("session_")) {
      console.log("✓ Test 1 Passed: PostgreSQL session created in DB ->", session.sessionId);
    } else {
      console.error("❌ Test 1 Failed: PostgreSQL session creation failed!", session);
      await store.close();
      process.exit(1);
    }

    // Test 2: Save Messages to PostgreSQL
    await store.saveMessage(session.sessionId, { role: "user", content: "Test prompt to PostgreSQL DB" });
    await store.saveMessage(session.sessionId, { role: "assistant", content: "Test response from PostgreSQL DB" });

    // Test 3: Save Tool Execution to PostgreSQL
    await store.saveToolExecution(session.sessionId, {
      toolCallId: "call_pg_123",
      toolName: "execute_shell",
      argsJson: JSON.stringify({ command: "pnpm test" }),
      output: "Tests passed 100%",
      isError: false,
      durationMs: 120,
    });

    // Test 4: Update Token Telemetry in PostgreSQL
    await store.updateTokenTelemetry(session.sessionId, {
      promptTokens: 1500,
      completionTokens: 350,
      reasoningTokens: 100,
      estimatedCostUsd: 0.015,
    });

    // Test 5: Hydrate Session from PostgreSQL
    const hydration = await store.getSessionHydration(session.sessionId);
    if (
      hydration &&
      hydration.messages.length === 2 &&
      hydration.toolExecutions.length === 1 &&
      hydration.telemetry.promptTokens === 1500
    ) {
      console.log("✓ Test 2 Passed: Full session hydration retrieved from PostgreSQL cleanly.");
    } else {
      console.error("❌ Test 2 Failed: Mismatch in PostgreSQL hydration!", hydration);
      await store.close();
      process.exit(1);
    }

    // ─── REGRESSION TEST: session-ID mismatch → FK violation crash ──────────
    // Previously, AgentOrchestrator's constructor fired an un-awaited
    // sessionStore.createSession(...) that generated a session row with a
    // DIFFERENT random ID than ExecutionContext.sessionId. Every subsequent
    // saveMessage(context.sessionId, ...) then violated the
    // agent_messages.session_id -> agent_sessions(session_id) foreign key,
    // crashing on the very first message of every orchestrator-driven turn
    // against Postgres. AgentOrchestrator.start() fixes this by creating the
    // row FIRST (awaited) with the exact ID the orchestrator then uses.
    const registry = new ToolRegistry();
    const orchestrator = await AgentOrchestrator.start(
      {
        workspaceRoot: "/Users/ravishankar/Desktop/inflynx-code",
        providerId: "openai",
        model: "gpt-4o",
        apiKey: "mock_key",
      },
      registry,
      undefined,
      async () => true,
      "low",
      store
    );

    // This is exactly what runTurn() does internally — if the ID were
    // mismatched, this line would throw a foreign_key_violation (code 23503).
    await store.saveMessage(orchestrator.sessionId, { role: "user", content: "FK regression check" });
    const regressionHydration = await store.getSessionHydration(orchestrator.sessionId);

    if (regressionHydration && regressionHydration.session.sessionId === orchestrator.sessionId) {
      console.log(
        `✓ Test 3 Passed: AgentOrchestrator.start() -> saveMessage() succeeded against Postgres with no FK violation (sessionId=${orchestrator.sessionId}).`
      );
    } else {
      console.error("❌ Test 3 Failed: Session-ID mismatch regression detected against Postgres!");
      await store.close();
      process.exit(1);
    }

    await store.close();
    console.log("\n🎉 All PostgreSQL Store Tests Passed 100%!");
  } catch (err: any) {
    console.error("❌ PostgreSQL Test Failed:", err);
    await store.close();
    process.exit(1);
  }
}

runPostgresStoreTests();

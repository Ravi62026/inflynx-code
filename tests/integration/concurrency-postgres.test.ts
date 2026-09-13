/**
 * Integration Test: High-Concurrency PostgreSQL Session Persistence
 *
 * Runs against the Dockerized PostgreSQL database (`pnpm docker:up`).
 * Validates:
 *   1. Concurrent transaction handling across multiple sessions.
 *   2. Foreign key lock safety under simultaneous turn/message insertions.
 *   3. Token telemetry and tool execution atomic commits under load.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { PostgresSessionStore } from "../../packages/session-store/src/PostgresSessionStore.js";

function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = (open: boolean) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(open);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => cleanup(true));
    socket.once("timeout", () => cleanup(false));
    socket.once("error", () => cleanup(false));
    socket.connect(port, host);
  });
}

async function runPostgresConcurrencyTests() {
  console.log("🐘 Running PostgreSQL High-Concurrency Integration Suite...\n");

  const connectionString =
    process.env.DATABASE_URL || "postgresql://inflynx:inflynx_dev_pw@localhost:5432/inflynx_code";

  // Check if PostgreSQL port is accessible
  const isAvailable = await isPortOpen("localhost", 5432);
  if (!isAvailable) {
    console.log("ℹ️  PostgreSQL (localhost:5432) is offline. Skipping PostgreSQL concurrency suite.");
    console.log("   Run 'pnpm docker:up' to spin up PostgreSQL & Redis and re-run this test.\n");
    process.exit(0);
  }

  const store = new PostgresSessionStore(connectionString);
  const sessionCount = 10;
  const messagesPerSession = 5;
  const testWorkspace = process.cwd();

  try {
    const start = Date.now();
    console.log(`🔹 Creating ${sessionCount} concurrent sessions in PostgreSQL...`);

    // 1. Create sessions concurrently
    const sessionPromises = Array.from({ length: sessionCount }, (_, i) =>
      store.createSession(
        testWorkspace,
        "openai",
        "gpt-5.6-luna",
        "agent",
        "medium",
        `Concurrency Test Session ${i}`
      )
    );

    const sessions = await Promise.all(sessionPromises);
    assert.equal(sessions.length, sessionCount);
    for (const session of sessions) {
      assert.ok(session.sessionId.startsWith("session_"));
    }
    console.log(`✓ ${sessionCount} sessions created concurrently without conflict.`);

    // 2. Concurrently insert messages and tool executions
    console.log(`🔹 Concurrently writing ${sessionCount * messagesPerSession} messages and tool executions...`);
    const writePromises: Promise<any>[] = [];

    for (const session of sessions) {
      for (let m = 0; m < messagesPerSession; m++) {
        writePromises.push(
          store.saveMessage(session.sessionId, {
            role: m % 2 === 0 ? "user" : "assistant",
            content: `Concurrent prompt ${m} for session ${session.sessionId}`,
          })
        );
      }
      writePromises.push(
        store.saveToolExecution(session.sessionId, {
          toolCallId: `call_pg_${session.sessionId}`,
          toolName: "read_file",
          argsJson: JSON.stringify({ path: "package.json" }),
          output: "Mock read output",
          isError: false,
          durationMs: 45,
        })
      );
      writePromises.push(
        store.updateTokenTelemetry(session.sessionId, {
          promptTokens: 1200,
          completionTokens: 300,
          reasoningTokens: 150,
          estimatedCostUsd: 0.012,
        })
      );
    }

    await Promise.all(writePromises);
    console.log(`✓ Concurrent writes committed cleanly without FK violation or transaction deadlock.`);

    // 3. Concurrently hydrate and verify all sessions
    console.log(`🔹 Hydrating all ${sessionCount} sessions concurrently...`);
    const hydrations = await Promise.all(
      sessions.map((s) => store.getSessionHydration(s.sessionId))
    );

    for (let i = 0; i < sessionCount; i++) {
      const hydration = hydrations[i];
      assert.ok(hydration, `Session ${sessions[i].sessionId} failed to hydrate`);
      assert.equal(hydration.messages.length, messagesPerSession);
      assert.equal(hydration.toolExecutions.length, 1);
      assert.equal(hydration.telemetry.promptTokens, 1200);
      assert.equal(hydration.telemetry.reasoningTokens, 150);
    }

    const elapsed = Date.now() - start;
    console.log(`✓ All ${sessionCount} sessions hydrated cleanly with exact data in ${elapsed}ms.`);

    await store.close();
    console.log("\n🎉 PostgreSQL Concurrency & Transaction Stress Test Passed 100%!");
  } catch (err: any) {
    console.error("❌ PostgreSQL Concurrency Test Failed:", err);
    await store.close();
    process.exit(1);
  }
}

runPostgresConcurrencyTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});


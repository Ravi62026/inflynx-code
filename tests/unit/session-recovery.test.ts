/**
 * Integration & Unit Tests for Session Crash Recovery & History Integrity
 *
 * Validates:
 *   1. Interrupted tool execution recovery via ensureHistoryIntegrity().
 *   2. Rehydration and repair of orphaned tool calls during resumeSession().
 *   3. AbortController signal reset after cancellation, enabling consecutive turns.
 *   4. Normal execution continuation following a crash recovery.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { ExecutionContext } from "../../packages/agent-core/src/orchestrator/ExecutionContext.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function finalTextResponse(text = "Turn after recovery succeeded."): Response {
  return sseResponse([
    JSON.stringify({ type: "response.output_text.delta", delta: text }),
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

async function runSessionRecoveryTests() {
  console.log("🔄 Running Phase 5 Session Recovery & History Integrity Tests...\n");

  const originalFetch = globalThis.fetch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-recovery-test-"));
  const store = new LocalJsonSessionStore(tmpDir);
  const registry = new ToolRegistry(CORE_TOOLS);

  try {
    // ── Test 1: Direct ensureHistoryIntegrity() repair of orphaned tool calls ───
    {
      const context = new ExecutionContext({
        workspaceRoot: tmpDir,
        providerId: "openai",
        model: "gpt-5.6-luna",
        apiKey: "mock_key",
      });

      context.addMessage({ role: "user", content: "read a file" });
      context.addMessage({
        role: "assistant",
        content: "I will read it",
        tool_calls: [
          { id: "call_orphaned_1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_orphaned_2", type: "function", function: { name: "list_directory", arguments: "{}" } },
        ],
      });
      // Simulate partial execution: only call_orphaned_1 received a tool response before a crash
      context.addMessage({ role: "tool", content: "file content", tool_call_id: "call_orphaned_1" });

      assert.equal(context.history.length, 3);
      context.ensureHistoryIntegrity();

      // ensureHistoryIntegrity must synthesize the missing response for call_orphaned_2
      assert.equal(context.history.length, 4);
      const repaired = context.history[3];
      assert.equal(repaired.role, "tool");
      assert.equal(repaired.tool_call_id, "call_orphaned_2");
      assert.ok(repaired.content?.includes("interrupted or failed"));
      console.log("✓ Test 1 Passed: ensureHistoryIntegrity() synthesized missing tool response for interrupted tool call.");
    }

    // ── Test 2: AbortController reset allows consecutive operations ─────────────
    {
      const context = new ExecutionContext({
        workspaceRoot: tmpDir,
        providerId: "openai",
        model: "gpt-5.6-luna",
        apiKey: "mock_key",
      });

      assert.equal(context.signal.aborted, false);
      context.abort();
      // After abort(), the old signal was aborted, but context now has a fresh signal
      assert.equal(context.signal.aborted, false);
      console.log("✓ Test 2 Passed: ExecutionContext.abort() refreshed AbortController for subsequent turns.");
    }

    // ── Test 3: Resume interrupted session and successfully run next turn ───────
    {
      const sessionId = "session_interrupted_crash_1";
      await store.createSession(tmpDir, "openai", "gpt-5.6-luna", "agent", "medium", "Crash Test Session", sessionId);

      // Seed persisted history with an interrupted tool call (crash happened mid-flight)
      await store.saveMessage(sessionId, { role: "user", content: "please patch a file" });
      await store.saveMessage(sessionId, {
        role: "assistant",
        content: "Patching file now",
        toolCallsJson: JSON.stringify([
          { id: "call_crash_midway", name: "patch_file", args: { file: "test.ts" } },
        ]),
      });
      // Note: No tool output message saved for call_crash_midway (simulating sudden kill)

      process.env.OPENAI_API_KEY = "mock_key";
      const eventBus = new AgentEventBus();
      const resumedOrchestrator = await AgentOrchestrator.resumeSession(
        tmpDir,
        sessionId,
        registry,
        eventBus,
        async () => true,
        store
      );

      assert.ok(resumedOrchestrator);
      assert.equal(resumedOrchestrator.sessionId, sessionId);

      // Now run a new turn on the resumed session to verify provider call doesn't fail
      globalThis.fetch = (async () => finalTextResponse("Successfully recovered and answered.")) as typeof fetch;

      const result = await resumedOrchestrator.runTurn("what did you do?");
      assert.ok(result.finalText.includes("Successfully recovered"));
      assert.equal(result.toolResults.length, 0);

      // Verify that SessionStore recorded the conversation continuation
      const hydration = await store.getSessionHydration(sessionId);
      assert.ok(hydration);
      assert.ok(hydration.messages.length >= 3);
      console.log("✓ Test 3 Passed: resumeSession() cleanly recovered crashed session state and completed follow-up turn.");
    }

    console.log("\n🎉 All Phase 5 Session Recovery & History Integrity Tests Passed 100%!");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runSessionRecoveryTests().catch((err) => {
  console.error("Session recovery test failed:", err);
  process.exit(1);
});

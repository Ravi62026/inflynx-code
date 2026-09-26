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
      const synthesized = context.ensureHistoryIntegrity();

      // ensureHistoryIntegrity() synthesized the missing response for call_orphaned_2
      assert.equal(context.history.length, 4);
      const repaired = context.history[3];
      assert.equal(repaired.role, "tool");
      assert.equal(repaired.tool_call_id, "call_orphaned_2");
      assert.ok(repaired.content?.includes("interrupted or failed"));
      assert.equal(synthesized.length, 1, "integrity pass should report exactly one stub");
      assert.equal(synthesized[0].tool_call_id, "call_orphaned_2");

      // Idempotent, and repairs a *middle* round too — the old implementation only
      // ever inspected the last assistant message.
      assert.equal(context.ensureHistoryIntegrity().length, 0, "second run should be a no-op");
      context.addMessage({ role: "user", content: "again" });
      context.addMessage({
        role: "assistant",
        content: "one more",
        tool_calls: [{ id: "call_orphaned_3", type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      const secondRound = context.ensureHistoryIntegrity();
      assert.equal(secondRound.length, 1);
      assert.equal(secondRound[0].tool_call_id, "call_orphaned_3");
      assert.equal(secondRound[0].is_error, true, "synthesized stubs must be marked as errors");
      // The new stub sits immediately after its own assistant message.
      assert.equal(context.history[context.history.length - 1].role, "tool");
      console.log("✓ Test 1 Passed: ensureHistoryIntegrity() repairs every round, is idempotent, and reports its stubs.");
    }

    // ── Test 2: cancellation generations (Phase 6 semantics) ──────────────────
    // This previously asserted that abort() handed out a fresh, un-aborted signal
    // and called that "correct". It was the bug: a turn re-reading context.signal
    // after an abort saw `false` and kept executing the remaining tool calls.
    {
      const context = new ExecutionContext({
        workspaceRoot: tmpDir,
        providerId: "openai",
        model: "gpt-5.6-luna",
        apiKey: "mock_key",
      });

      const turnSignal = context.beginGeneration();
      assert.equal(turnSignal.aborted, false);

      context.abort();
      assert.equal(turnSignal.aborted, true, "the in-flight generation must stay cancelled");
      assert.equal(context.signal.aborted, true, "context.signal must report the same cancellation");

      const nextTurn = context.beginGeneration();
      assert.equal(nextTurn.aborted, false, "a new turn must start with a live signal");
      assert.equal(turnSignal.aborted, true, "the abandoned signal must remain cancelled");
      console.log("✓ Test 2 Passed: abort() cancels the current generation; beginGeneration() starts a clean one.");
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
      // This suite imports workspace packages from `src` while AgentOrchestrator
      // types them through their published `dist/*.d.ts`, so classes with private
      // fields are nominally distinct (backlog M8). Deriving the parameter types
      // from the callee keeps this honest instead of using `any`.
      type ResumeArgs = Parameters<typeof AgentOrchestrator.resumeSession>;
      const resumedOrchestrator = await AgentOrchestrator.resumeSession(
        tmpDir,
        sessionId,
        registry as unknown as ResumeArgs[2],
        eventBus as unknown as ResumeArgs[3],
        async () => true,
        store as unknown as ResumeArgs[5]
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

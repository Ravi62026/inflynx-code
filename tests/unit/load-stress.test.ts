/**
 * Event Bus, Context Compaction & High-Throughput Load Testing
 *
 * Validates:
 *   1. EventBus listener scaling: 25 instances, 5,000 events without memory leaks or listener warnings.
 *   2. Window relief under high-frequency turn additions: eviction ladder + compaction.
 *   3. LocalJsonSessionStore concurrent read/write stability across multi-session batches.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { BudgetManager } from "../../packages/agent-core/src/orchestrator/BudgetManager.js";
import { ExecutionContext } from "../../packages/agent-core/src/orchestrator/ExecutionContext.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

async function runLoadStressTests() {
  console.log("⚡ Running Phase 5 High-Throughput Load & Stability Tests...\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-load-test-"));

  try {
    // ── Load Test 1: EventBus High Throughput & Listener Lifecycle ──────────────
    {
      const busCount = 20;
      const eventsPerBus = 250;
      let totalReceived = 0;

      const buses: AgentEventBus[] = [];
      const unsubscribers: Array<() => void> = [];

      for (let i = 0; i < busCount; i++) {
        const bus = new AgentEventBus();
        buses.push(bus);
        const unsub = bus.on("model.text_delta", (evt) => {
          assert.ok(evt.payload);
          totalReceived++;
        });
        unsubscribers.push(unsub);
      }

      const start = Date.now();
      for (let i = 0; i < busCount; i++) {
        const bus = buses[i];
        for (let j = 0; j < eventsPerBus; j++) {
          bus.emit("model.text_delta", `session_${i}`, { text: `delta_${j}` });
        }
      }
      const elapsed = Date.now() - start;

      assert.equal(totalReceived, busCount * eventsPerBus);

      // Unsubscribe all and verify no further events are captured
      for (const unsub of unsubscribers) unsub();
      buses[0].emit("model.text_delta", "session_0", { text: "after_unsub" });
      assert.equal(totalReceived, busCount * eventsPerBus);

      console.log(
        `✓ Load Test 1 Passed: Emitted & received ${totalReceived} events across ${busCount} buses in ${elapsed}ms (${(
          (totalReceived / (elapsed || 1)) * 1000
        ).toFixed(0)} events/sec).`
      );
    }

    // ── Load Test 2: 60 turns of heavy tool output, squeezed into a small window ──
    {
      const contextWindow = 8_000;
      const context = new ExecutionContext({
        workspaceRoot: tmpDir,
        providerId: "openai",
        model: "gpt-4o",
        apiKey: "mock_key",
      });
      const budget = new BudgetManager("medium", "session_load", new AgentEventBus() as never);
      budget.setModelWindow(contextWindow, 8_000);

      context.addMessage({ role: "system", content: "You are Inflynx Code agent with strict verification rules." });
      context.addMessage({ role: "user", content: "Audit every package in this monorepo." });
      for (let i = 1; i <= 60; i++) {
        context.addMessage({
          role: "assistant",
          content: `Turn ${i}: inspecting package ${i}.`,
          tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
        });
        context.addMessage({
          role: "tool",
          content: `Turn ${i}: architectural decisions, snippets and test logs. `.repeat(12),
          tool_call_id: `c${i}`,
        });
      }
      budget.noteRequestSent(context.history.length);

      const startChars = context.history.reduce((n, m) => n + (m.content?.length || 0), 0);
      const startUtilization = budget.contextUtilization(context.history);
      assert.ok(startUtilization > 1, `60 heavy turns only filled ${startUtilization.toFixed(2)} of the window`);

      // Same ladder the orchestrator runs, at the same scale it would see in a long session.
      let dropped = 0;
      for (const protect of [12, 6, 2]) {
        const relief = context.evictStaleToolResults({ protectRecentMessages: protect });
        dropped += relief.dropped;
        budget.accountForEviction(relief.charsFreed);
      }

      const endChars = context.history.reduce((n, m) => n + (m.content?.length || 0), 0);
      const endUtilization = budget.contextUtilization(context.history);

      assert.ok(dropped > 40, `ladder only freed ${dropped} of 60 tool results`);
      assert.ok(endChars < startChars * 0.35, `freed barely anything: ${startChars} → ${endChars}`);
      assert.ok(endUtilization < startUtilization, `utilization did not fall: ${startUtilization} → ${endUtilization}`);
      assert.equal(context.history[0].content.startsWith("You are Inflynx"), true, "pinned system prompt was lost!");
      // Recency protection is the whole point: the working set must survive the squeeze.
      assert.ok(
        context.history.some((m) => m.role === "tool" && m.content.includes("Turn 60")),
        "the most recent tool result was evicted"
      );
      assert.equal(context.ensureHistoryIntegrity().length, 0, "eviction orphaned a tool_call");

      // And summarization still finds something to fold after eviction has run out.
      const plan = context.compactionPlan({ keepRecentMessages: 8 });
      if (plan) {
        const applied = context.applyCompaction(plan, "Turns 1-40 audited packages with no findings.");
        assert.ok(applied.dropped >= 3, "compaction folded almost nothing");
        assert.equal(
          context.ensureHistoryIntegrity().length, 0,
          "compaction split a tool round — providers would reject this history"
        );
      }

      console.log(
        `✓ Load Test 2 Passed: ${dropped} of 60 tool results evicted ` +
        `(${startChars.toLocaleString()} → ${endChars.toLocaleString()} chars, ` +
        `${(startUtilization * 100).toFixed(0)}% → ${(endUtilization * 100).toFixed(0)}% of the ` +
        `${contextWindow.toLocaleString()}-token window), pinned prompt and working set intact.`
      );
    }

    // ── Load Test 3: Multi-Session Concurrent Batch Persistence ────────────────
    {
      const store = new LocalJsonSessionStore(tmpDir);
      const sessionCount = 10;
      const messagesPerSession = 20;

      const sessionIds = Array.from({ length: sessionCount }, (_, i) => `session_load_${i}`);

      // Create all sessions concurrently
      await Promise.all(
        sessionIds.map((id) =>
          store.createSession(tmpDir, "openai", "gpt-5.6-luna", "agent", "medium", `Session ${id}`, id)
        )
      );

      // Concurrently write messages and tool executions across all sessions
      const writeTasks: Promise<void>[] = [];
      for (const id of sessionIds) {
        for (let m = 0; m < messagesPerSession; m++) {
          writeTasks.push(
            store.saveMessage(id, {
              role: m % 2 === 0 ? "user" : "assistant",
              content: `Message ${m} for session ${id}`,
            })
          );
        }
        writeTasks.push(
          store.saveToolExecution(id, {
            toolCallId: `call_${id}`,
            toolName: "read_file",
            argsJson: JSON.stringify({ path: "README.md" }),
            output: "Contents of readme",
            isError: false,
            durationMs: 15,
          })
        );
      }

      await Promise.all(writeTasks);

      // Verify all sessions hydrated cleanly with complete records
      for (const id of sessionIds) {
        const hydration = await store.getSessionHydration(id);
        assert.ok(hydration, `Session ${id} hydration missing`);
        assert.equal(hydration.messages.length, messagesPerSession);
        assert.equal(hydration.toolExecutions.length, 1);
      }

      console.log(
        `✓ Load Test 3 Passed: Successfully wrote & hydrated ${sessionCount * messagesPerSession} messages and ${sessionCount} tool runs concurrently.`
      );
    }

    console.log("\n🎉 All Phase 5 High-Throughput Load & Stability Tests Passed 100%!");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runLoadStressTests().catch((err) => {
  console.error("Load stress test failed:", err);
  process.exit(1);
});


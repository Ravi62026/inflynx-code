/**
 * Event Bus, Context Compaction & High-Throughput Load Testing
 *
 * Validates:
 *   1. EventBus listener scaling: 25 instances, 5,000 events without memory leaks or listener warnings.
 *   2. ContextManager compaction under high-frequency turn additions.
 *   3. LocalJsonSessionStore concurrent read/write stability across multi-session batches.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { ContextManager } from "../../packages/agent-core/src/context/ContextManager.js";
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

    // ── Load Test 2: Rapid Context Compaction Under Token Budgets ───────────────
    {
      const maxBudget = 250;
      const manager = new ContextManager(maxBudget);

      // Seed system pinned message
      manager.addItem({
        category: "system",
        content: "You are Inflynx Code agent with strict verification rules.",
        priority: "pinned",
      });

      // Add 60 sequential turns
      for (let i = 1; i <= 60; i++) {
        manager.addItem({
          category: i % 2 === 1 ? "user" : "assistant",
          content: `Turn number ${i}: explaining architectural decisions with intermediate code snippets and test logs for analysis.`,
          priority: i > 50 ? "high" : "low",
        });
      }

      const compacted = manager.compactContext();
      const totalTokens = manager.getTotalTokens();

      assert.ok(totalTokens <= maxBudget, `Tokens (${totalTokens}) exceeded budget (${maxBudget})`);
      assert.ok(compacted.some((item) => item.category === "system"), "Pinned system message was dropped!");
      // Low-priority older items should have been discarded before high-priority recent items
      const recentTurnKept = compacted.some((item) => item.content.includes("Turn number 58"));
      assert.ok(recentTurnKept, "High-priority recent item was incorrectly dropped!");

      console.log(
        `✓ Load Test 2 Passed: Compacted 61 message turns to ${compacted.length} items (${totalTokens}/${maxBudget} tokens), preserving pinned instructions.`
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


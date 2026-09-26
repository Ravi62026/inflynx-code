/**
 * Backlog Epic 2 (Phases 12, 13, 14, 15, 16) — context-window management suite.
 *
 * Before this, nothing in the project knew what a context window was:
 * `contextWindow` existed on the catalog but was read only by a display string,
 * history grew without bound, and a provider overflow was a fatal error.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
  MODEL_CATALOG,
  resolveContextLimits,
} from "../../packages/config/src/model-catalog.js";
import { BudgetManager } from "../../packages/agent-core/src/orchestrator/BudgetManager.js";
import { ExecutionContext } from "../../packages/agent-core/src/orchestrator/ExecutionContext.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import type { Message } from "../../packages/model-gateway/src/types.js";

function sse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function readToolCall(pathValue: string): () => Response {
  return () =>
    sse([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, function: { name: "read_file", arguments: JSON.stringify({ path: pathValue }) } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ]);
}

function textResponse(text: string): () => Response {
  return () =>
    sse([
      JSON.stringify({ choices: [{ delta: { content: text } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ]);
}

/** A usage-bearing stream so occupancy is anchored on provider-reported totals. */
function readToolCallWithUsage(pathValue: string, promptTokens: number): () => Response {
  return () =>
    sse([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, function: { name: "read_file", arguments: JSON.stringify({ path: pathValue }) } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: promptTokens, completion_tokens: 50 } }),
      "[DONE]",
    ]);
}

async function runContextBudgetTests(): Promise<void> {
  console.log("📏 Running Epic 2 Context-Window Management Tests...\n");

  // ── Test 1: every model has a known window, and resolution never guesses up ──
  {
    for (const [providerId, models] of Object.entries(MODEL_CATALOG)) {
      for (const model of models) {
        assert.ok(model.contextWindow > 0, `${providerId}/${model.id} has no contextWindow`);
        assert.ok(
          model.maxOutputTokens > 0 && model.maxOutputTokens <= model.contextWindow,
          `${providerId}/${model.id} has an impossible maxOutputTokens`
        );
      }
    }

    const curated = resolveContextLimits("openai", "gpt-5.6-luna");
    assert.equal(curated.contextWindow, 1_050_000, "curated window not used");
    assert.equal(curated.maxOutputTokens, 128_000, "curated output ceiling not used");
    assert.equal(curated.curated, true);

    // Different providers, different windows: the whole point of Phase 12.
    const claude = resolveContextLimits("anthropic", "claude-sonnet-5");
    const deepseek = resolveContextLimits("deepseek", "deepseek-v4-flash");
    assert.ok(
      claude.contextWindow !== deepseek.contextWindow || claude.maxOutputTokens !== deepseek.maxOutputTokens,
      "all models still resolve to identical limits"
    );

    const unknown = resolveContextLimits("openai", "some-model-not-in-the-catalog");
    assert.equal(unknown.contextWindow, CONSERVATIVE_CONTEXT_WINDOW, "unknown model got a non-conservative window");
    assert.equal(unknown.maxOutputTokens, CONSERVATIVE_MAX_OUTPUT_TOKENS);
    assert.equal(unknown.curated, false, "unknown model claimed to be curated");

    const declared = resolveContextLimits("custom-openai-compatible", "byok-model", {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    });
    assert.equal(declared.contextWindow, 128_000, "BYOK declaration ignored");
    assert.equal(declared.maxOutputTokens, 16_384);

    const clamped = resolveContextLimits("custom-openai-compatible", "byok-model", { contextWindow: 4_000 });
    assert.ok(clamped.maxOutputTokens <= clamped.contextWindow, "output ceiling exceeded the declared window");
    console.log("✓ Test 1 Passed: limits resolve per model, BYOK declarations win, unknowns fall back conservatively.");
  }

  // ── Test 2: occupancy is measured against the window, not a cumulative sum ───
  {
    const bus = new AgentEventBus();
    const budget = new BudgetManager("medium", "session_ctx", bus as never);

    assert.equal(budget.windowKnown, false, "a window must not be assumed before one is set");
    assert.equal(budget.contextUtilization([]), 0, "utilization must be 0 when the window is unknown");

    budget.setModelWindow(32_000, 8_000);
    const history: Message[] = [{ role: "system", content: "sys" }];
    budget.noteRequestSent(history.length);
    budget.recordUsage({ promptTokens: 4_000, completionTokens: 200 });

    const baseline = budget.projectedContextTokens(history);
    assert.ok(baseline >= 4_200, `projection lost the provider anchor: ${baseline}`);

    history.push({ role: "tool", content: "x".repeat(8_000), tool_call_id: "t1" });
    const grown = budget.projectedContextTokens(history);
    assert.ok(grown >= baseline + 2_000, `8k chars appended but projection moved ${baseline} → ${grown}`);

    const utilization = budget.contextUtilization(history);
    assert.ok(utilization > 0.19 && utilization < 0.35, `utilization out of range for the growth: ${utilization}`);

    const state = budget.getBudgetState();
    assert.equal(state.contextWindow, 32_000, "budget snapshot lost the window");
    assert.ok(state.contextUtilizationPercent > 0, "budget snapshot reports 0% while over the threshold");
    // Cumulative prompt tokens keep growing per call; utilization must not be derived from them.
    budget.recordUsage({ promptTokens: 4_200, completionTokens: 100 });
    assert.ok(
      budget.getBudgetState().contextUtilizationPercent < 100,
      "utilization was computed from cumulative tokens"
    );
    console.log(
      `✓ Test 2 Passed: projection anchored on provider prompt_tokens (${baseline} → ${grown}), ` +
      `${Math.round(utilization * 100)}% of a 32k window.`
    );
  }

  // ── Test 3: eviction drops stale tool output and nothing else ───────────────
  {
    const context = new ExecutionContext({
      workspaceRoot: os.tmpdir(),
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "mock_key",
    });

    context.addMessage({ role: "system", content: "You are Inflynx Agent." });
    const bigOutput = "y".repeat(5_000);
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: `request ${i} `.repeat(30) });
      context.addMessage({
        role: "assistant",
        content: "reading",
        tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      context.addMessage({ role: "tool", content: bigOutput, tool_call_id: `call_${i}` });
    }

    const before = context.history.filter((m) => m.role === "tool").length;
    const result = context.evictStaleToolResults({ protectRecentMessages: 6 });

    assert.ok(result.dropped > 0, "nothing was evicted despite plenty of stale tool output");
    assert.ok(result.charsFreed > 0, "eviction reported no bytes freed");

    // Every tool_call still has a response object — eviction replaces content only.
    const toolMessages = context.history.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, before, "eviction removed a message instead of emptying one");
    for (const message of toolMessages) {
      assert.ok(message.tool_call_id, "a tool message lost its tool_call_id");
    }

    // Recent output survives, and non-tool content is never touched.
    const survivors = toolMessages.slice(-3).filter((m) => m.content.length > 1_000).length;
    assert.ok(survivors >= 1, "the protected recent window was evicted too");
    const assistantText = context.history.filter((m) => m.role === "assistant");
    assert.ok(assistantText.every((m) => m.content === "reading"), "assistant text was altered by eviction");
    assert.ok(
      context.history.some((m) => m.role === "user" && m.content.startsWith("request 0")),
      "user messages must survive eviction"
    );

    // Idempotent: a second pass finds nothing new worth dropping.
    const second = context.evictStaleToolResults({ protectRecentMessages: 6 });
    assert.ok(second.dropped <= 1, `second eviction pass re-dropped ${second.dropped} already-evicted entries`);
    console.log(
      `✓ Test 3 Passed: evicted ${result.dropped} stale tool result(s), freed ` +
      `${result.charsFreed.toLocaleString()} chars, kept ids and recent context intact.`
    );
  }

  // ── Test 4: end to end, a session stays inside a small declared window ───────
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-ctx-e2e-"));
    const originalFetch = (globalThis as any).fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      fs.writeFileSync(path.join(tmpDir, "huge.txt"), "z".repeat(200_000), "utf-8");

      const bodies: string[] = [];
      let call = 0;
      (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
        if (init?.body) bodies.push(init.body);
        call++;
        // Each read is reported as a fresh 3k-prompt-token call so projection has
        // something realistic to anchor on.
        return call <= 3 ? readToolCallWithUsage("huge.txt", 3_000 + call * 2_500)() : textResponse("done")();
      };

      const store = new LocalJsonSessionStore(tmpDir);
      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot: tmpDir,
          providerId: "custom-openai-compatible",
          model: "byok-small-window",
          apiKey: "",
          baseURL: "http://127.0.0.1:59999/v1",
          modelAdapter: "openai-chat",
          activeMode: "agent",
          allowUnauthenticated: true,
          allowLocalEndpoint: true,
          customCapabilities: {
            supportsTools: true,
            supportedEfforts: ["none"],
            contextWindow: 12_000,
            maxOutputTokens: 2_048,
          },
        },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,
        "high",
        store as never
      );

      assert.equal(orchestrator.budget.contextWindow, 12_000, "declared BYOK window not applied");

      await orchestrator.runTurn("read huge.txt");
      await orchestrator.runTurn("read huge.txt again");
      await orchestrator.runTurn("read huge.txt once more");
      const final = await orchestrator.runTurn("summarise it");

      assert.ok(final.finalText.includes("done"), "the multi-turn session did not complete");

      // D7: the output ceiling now comes from the model, not a hardcoded 4096.
      const ceilings = new Set(bodies.map((b) => JSON.parse(b).max_tokens));
      assert.deepEqual([...ceilings], [2_048], `requests did not all use the model's output ceiling: ${[...ceilings]}`);

      const largest = Math.max(...bodies.map((b) => b.length));
      assert.ok(
        warnings.some((w) => /evicted \d+ stale tool result/.test(w)),
        `eviction never fired; warnings were [${warnings.join(" | ")}]`
      );
      // Eviction does not make requests shrink turn over turn — each new read adds
      // bulk again. What it guarantees is that size stays *bounded* instead of
      // growing with every turn (4 un-evicted reads of this file exceed 100k chars).
      assert.ok(largest < 60_000, `request size was not bounded: peaked at ${largest.toLocaleString()} chars`);

      const utilization = orchestrator.budget.contextUtilizationPercent;
      assert.ok(utilization < 100, `session ended at ${utilization}% of the declared window`);

      const stored = await store.getSessionHydration(orchestrator.sessionId);

      // The tombstone belongs in what the *model* was sent, not in the audit record:
      // eviction shrinks the working window while the stored transcript keeps the
      // real output, so `/resume` and post-hoc review still see what happened.
      assert.ok(
        bodies.slice(1).some((b) => b.includes("[context evicted")),
        "no evicted placeholder ever reached the provider"
      );
      const storedToolMessages = stored!.messages.filter((m) => m.role === "tool");
      assert.ok(storedToolMessages.length > 0, "no tool output was persisted at all");
      assert.ok(
        storedToolMessages.some((m) => (m.content || "").length > 20_000),
        "the stored transcript was thinned by eviction (it must keep full output)"
      );
      assert.ok(
        storedToolMessages.every((m) => !!m.toolCallId),
        "a stored tool message lost its tool_call_id"
      );
      console.log(
        `✓ Test 4 Passed: 4 turns on a 12k window stayed bounded (peak ${largest.toLocaleString()} chars), ` +
        `eviction fired, finished at ${utilization}% utilization.`
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
      console.warn = originalWarn;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── Test 5: the summarization tier really compacts, and keeps history valid ───
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-ctx-compact-"));
    const originalFetch = (globalThis as any).fetch;
    const originalWarn = console.warn;
    try {
      fs.writeFileSync(path.join(tmpDir, "huge.txt"), "q".repeat(120_000), "utf-8");

      const bodies: string[] = [];
      let agentCalls = 0;
      let summaryCalls = 0;
      (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
        const body = init?.body || "";
        bodies.push(body);
        if (body.includes("You are compacting an AI coding agent")) {
          summaryCalls++;
          return textResponse("Read huge.txt repeatedly to check it. No failures. Task is nearly done.")();
        }
        agentCalls++;
        // Odd calls read the file, even calls answer with real prose — because a
        // prefix made only of tool output is *eviction*'s job. Summarization earns
        // its model call on the reasoning the model itself wrote.
        if (agentCalls % 2 === 1) return readToolCallWithUsage("huge.txt", 2_000 + agentCalls * 200)();
        return textResponse(`ANALYSIS ${agentCalls}: ` + "reasoned about the file contents. ".repeat(280))();
      };

      const store = new LocalJsonSessionStore(tmpDir);
      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot: tmpDir,
          providerId: "custom-openai-compatible",
          model: "byok-small-window",
          apiKey: "",
          baseURL: "http://127.0.0.1:59999/v1",
          modelAdapter: "openai-chat",
          activeMode: "agent",
          allowUnauthenticated: true,
          allowLocalEndpoint: true,
          contextStrategy: "compact",
          customCapabilities: {
            supportsTools: true,
            supportedEfforts: ["none"],
            contextWindow: 12_000,
            maxOutputTokens: 2_048,
          },
        },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,
        "high",
        store as never
      );

      await orchestrator.runTurn("read huge.txt for the task");
      await orchestrator.runTurn("read huge.txt again");
      await orchestrator.runTurn("read huge.txt once more");
      await orchestrator.runTurn("and again");
      await orchestrator.runTurn("one more time");

      const before = orchestrator.budget;
      const relief = await orchestrator.compactContextNow({ summarize: true });
      const after = orchestrator.budget;

      // The interesting fact is that the *automatic* tier fired: with
      // `contextStrategy: "compact"` the orchestrator summarized on its own once
      // eviction ran out, so the manual call below is already looking at a compacted
      // history. Assert the tier, not the button.
      assert.ok(summaryCalls >= 1, `strategy "compact" spent no summarization call (${summaryCalls})`);
      assert.ok(relief.utilizationPercent >= 0, "manual /compact stopped reporting a window");
      assert.ok(
        after.projectedContextTokens <= before.projectedContextTokens,
        `context grew across a compaction request: ${before.projectedContextTokens} → ${after.projectedContextTokens}`
      );

      // The compacted view, not the raw history, is what the next request carries.
      await orchestrator.runTurn("what were we doing?");
      const lastBody = bodies.at(-1)!;
      assert.ok(
        lastBody.includes("[Earlier conversation summarized"),
        "the summary never reached the model's context"
      );
      assert.ok(
        lastBody.includes("read huge.txt for the task"),
        "compaction dropped the original task statement"
      );

      // The invariant that makes compaction safe at all: no request may contain a
      // tool result whose call is missing, or a call with no result.
      for (const [index, body] of bodies.entries()) {
        const messages = JSON.parse(body).messages as Array<{
          role: string;
          tool_calls?: Array<{ id: string }>;
          tool_call_id?: string;
        }>;
        const called = new Set(messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
        const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
        assert.deepEqual(
          [...answered].filter((id) => id && !called.has(id)),
          [],
          `request ${index} has a tool result with no surviving call — a split tool round`
        );
        assert.deepEqual(
          [...called].filter((id) => !answered.has(id)),
          [],
          `request ${index} has a tool call with no result`
        );
      }

      // Context ≠ transcript: the store keeps what actually happened.
      const stored = await store.getSessionHydration(orchestrator.sessionId);
      assert.ok(
        stored!.messages.filter((m) => m.role === "tool").some((m) => (m.content || "").length > 20_000),
        "compaction thinned the persisted transcript"
      );
      console.log(
        `✓ Test 5 Passed: ${summaryCalls} automatic summarization pass(es) folded the oldest turns; ` +
        `the model saw the summary plus the original task, and all ${bodies.length} requests were ` +
        `structurally valid tool-call history.`
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
      console.warn = originalWarn;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── Test 6: the expensive tier stays opt-in ─────────────────────────────────
  {
    const saved = process.env.INFLYNX_CONTEXT_STRATEGY;
    delete process.env.INFLYNX_CONTEXT_STRATEGY;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-ctx-default-"));
    const originalFetch = (globalThis as any).fetch;
    const originalWarn = console.warn;
    try {
      // Three *distinct* large files. Reading the same file repeatedly would now be
      // served from the gateway's repeat-read dedupe (Phase 17), which correctly
      // keeps the history small — and would leave this test nothing to evict.
      for (const name of ["huge1.txt", "huge2.txt", "huge3.txt"]) {
        fs.writeFileSync(path.join(tmpDir, name), "w".repeat(120_000), "utf-8");
      }
      const bodies: string[] = [];
      let call = 0;
      (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
        if (init?.body) bodies.push(init.body);
        call++;
        return call <= 3
          ? readToolCallWithUsage(`huge${call}.txt`, 4_000 + call * 2_000)()
          : textResponse("done")();
      };

      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot: tmpDir,
          providerId: "custom-openai-compatible",
          model: "byok-small-window",
          apiKey: "",
          baseURL: "http://127.0.0.1:59999/v1",
          modelAdapter: "openai-chat",
          activeMode: "agent",
          allowUnauthenticated: true,
          allowLocalEndpoint: true,
          customCapabilities: {
            supportsTools: true,
            supportedEfforts: ["none"],
            contextWindow: 12_000,
            maxOutputTokens: 2_048,
          },
        },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,
        "high",
        new LocalJsonSessionStore(tmpDir) as never
      );

      assert.equal(orchestrator.contextStrategy, "evict", "the default window policy changed");
      await orchestrator.runTurn("read huge.txt");
      await orchestrator.runTurn("read huge.txt again");
      await orchestrator.runTurn("read huge.txt once more");
      await orchestrator.runTurn("finish");

      // Summarization rewrites what the model remembers, so it must not happen on a
      // default session — that is the whole reason it is behind a flag.
      assert.ok(
        bodies.every((b) => !b.includes("You are compacting an AI coding agent")),
        "a default session spent a summarization model call"
      );
      assert.ok(
        bodies.some((b) => b.includes("[context evicted")),
        "the free tier did not run — eviction is the default policy's whole job"
      );
      console.log("✓ Test 6 Passed: a default session evicts but never summarizes.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      console.warn = originalWarn;
      if (saved === undefined) delete process.env.INFLYNX_CONTEXT_STRATEGY;
      else process.env.INFLYNX_CONTEXT_STRATEGY = saved;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log("\n🎉 All Epic 2 Context-Window Management Tests Passed 100%!");
}

runContextBudgetTests().catch((err) => {
  console.error("Context-budget test failed:", err);
  process.exit(1);
});

/**
 * Backlog Phases 6, 7 & 8 — turn lifecycle regression suite.
 *
 * Covers three failure modes that were previously silent:
 *
 *   1. The state machine froze in `completed` after turn 1, so every later turn
 *      skipped all transitions and emitted no `state.changed` events (C7).
 *   2. Aborting a turn did NOT stop the remaining tool calls of that turn
 *      (because abort() replaced the controller the loop was still reading), and
 *      an interrupted assistant `tool_calls` message could be carried into the
 *      next request as a dangling call, which providers reject with a 400 (C6, C12).
 *   3. Policy denials and gateway security blocks were handed to Anthropic as
 *      successful tool results, because `is_error` was inferred from an "Error:"
 *      prefix those messages do not use (G4).
 *
 * Everything runs against a stubbed provider and a temp-dir session store, so the
 * real `.inflynx/` is never touched (backlog M2).
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentEventBus, type PublicAgentEvent } from "../../packages/protocol/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { formatAnthropicMessages } from "../../packages/model-gateway/src/anthropic.js";
import type { Message } from "../../packages/model-gateway/src/types.js";

// ─── Provider-stream stub ─────────────────────────────────────────────────────

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

function toolCallsResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): Response {
  const events: string[] = [];
  calls.forEach((call, index) => {
    events.push(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }],
      })
    );
  });
  events.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  events.push("[DONE]");
  return sse(events);
}

function textResponse(text: string): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

/** Same, but with literal (possibly broken) argument fragments, as a cut-off stream emits. */
function rawToolCallResponse(
  calls: Array<{ id: string; name: string; argsRaw: string }>,
  finishReason = "tool_calls"
): Response {
  const events = calls.map((call, index) =>
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: call.argsRaw } }] } }],
    })
  );
  events.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] }));
  events.push("[DONE]");
  return sse(events);
}

/** Installs a fetch stub that replays `script` once each and records every request body. */
function stubFetch(script: Array<() => Response>, bodies: string[]): void {
  let index = 0;
  (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(init.body);
    const next = script[Math.min(index, script.length - 1)];
    index++;
    return next();
  };
}

/** Reads the messages array out of a captured chat-completions request body. */
function messagesOf(body: string): Array<{
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
}> {
  return JSON.parse(body).messages;
}

type StartArgs = Parameters<typeof AgentOrchestrator.start>;

async function runLifecycleTests(): Promise<void> {
  console.log("🔄 Running Phase 6, 7 & 8 Turn Lifecycle Tests...\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-lifecycle-"));
  const originalFetch = (globalThis as any).fetch;
  fs.writeFileSync(path.join(tmpDir, "sample.txt"), "hello from sample\n", "utf-8");

  // One store shared by the suites so a test can read back what was persisted.
  const sharedStore = new LocalJsonSessionStore(tmpDir);

  // Tools resolve their root from the injected context since Phase 5, so the
  // orchestrator's workspaceRoot alone decides what is reachable.
  const makeOrchestrator = async (
    eventBus: AgentEventBus,
    approvalHandler: (req: any) => Promise<boolean>,
    overrides: { maxTokens?: number } = {}
  ): Promise<AgentOrchestrator> =>
    AgentOrchestrator.start(
      {
        workspaceRoot: tmpDir,
        providerId: "openai",
        model: "gpt-4o",
        apiKey: "mock_key",
        activeMode: "agent",
        modelAdapter: "openai-chat",
        ...overrides,
      },
      new ToolRegistry(CORE_TOOLS) as unknown as StartArgs[1],
      eventBus as unknown as StartArgs[2],
      approvalHandler,
      "low",
      sharedStore as unknown as StartArgs[5]
    );

  try {
    // ── Test 1: the state machine keeps living across turns ───────────────────
    {
      const eventBus = new AgentEventBus();
      const transitions: Array<Record<string, unknown>> = [];
      eventBus.on("state.changed", (evt: PublicAgentEvent) => {
        transitions.push(evt.payload as Record<string, unknown>);
      });

      const orchestrator = await makeOrchestrator(eventBus, async () => true);
      const bodies: string[] = [];
      stubFetch([() => textResponse("first answer"), () => textResponse("second answer")], bodies);

      // Phase 7's promise is that refusals are reported rather than swallowed.
      // Capturing them turns "no silent breakage" into an assertion: any illegal
      // transition on the ordinary read-only path fails this suite.
      const originalConsoleError = console.error;
      const refusals: string[] = [];
      console.error = (...args: unknown[]) => {
        refusals.push(args.map(String).join(" "));
      };

      const turn1 = await orchestrator.runTurn("turn one");
      const afterTurn1 = transitions.length;
      const turn2 = await orchestrator.runTurn("turn two");
      console.error = originalConsoleError;

      const turn2States = transitions.slice(afterTurn1).map((p) => p.currentState);

      try {
        assert.ok(afterTurn1 > 0, "turn 1 emitted no state transitions at all");
        assert.equal(orchestrator.state, "completed", `session ended in "${orchestrator.state}"`);

        // Pre-Phase-7 the count stayed at `afterTurn1`: `completed → classifying` was
        // illegal, so turn 2 transitioned nothing and the machine was decorative.
        assert.ok(
          transitions.length > afterTurn1,
          `turn 2 emitted no state transitions (FSM frozen after turn 1): ` +
          `${transitions.length} total, ${afterTurn1} from turn 1`
        );
        assert.ok(turn2States.includes("classifying"), `turn 2 states were [${turn2States.join(", ")}]`);
        assert.ok(turn2States.includes("exploring"), `turn 2 never re-entered exploring: [${turn2States.join(", ")}]`);

        // A plain question is a *complete* turn. Before this phase both reported
        // false because the machine could not reach `completed` from `exploring`.
        assert.equal(turn1.isCompleted, true, "read-only turn 1 reported isCompleted=false");
        assert.equal(turn2.isCompleted, true, "read-only turn 2 reported isCompleted=false");

        assert.deepEqual(
          refusals,
          [],
          `transitions were refused during normal read-only turns:\n${refusals.join("\n")}`
        );
      } finally {
        console.error = originalConsoleError;
      }

      console.log(
        `✓ Test 1 Passed: 2 read-only turns, ${turn2States.length} transitions in turn 2 ` +
        `(${turn2States.join(" → ")}), both isCompleted=true, zero refused transitions.`
      );
    }

    // ── Test 2: abort stops the turn, and nothing dangles into the next one ────
    {
      const eventBus = new AgentEventBus();
      const proposed: string[] = [];
      eventBus.on<{ toolCallId?: string }>("tool.proposed", (evt) => {
        proposed.push(evt.payload?.toolCallId || "");
      });

      let approvals = 0;
      const bodies: string[] = [];
      // Holder, because the approval handler has to abort the very orchestrator
      // that is being constructed below.
      const running: { orchestrator?: AgentOrchestrator } = {};
      const orchestrator = await makeOrchestrator(eventBus, async () => {
        approvals++;
        // Simulates the user pressing ESC while approving the first call: the rest
        // of that turn's proposed calls must not execute.
        running.orchestrator?.abort();
        return true;
      });
      running.orchestrator = orchestrator;

      stubFetch(
        [
          () =>
            toolCallsResponse([
              // Must be mutating tools: read-only calls are auto-approved and never
              // reach the approval handler, so they cannot trigger the mid-turn abort.
              { id: "call_a", name: "write_file", args: { path: "note-a.txt", content: "written before abort\n" } },
              { id: "call_b", name: "write_file", args: { path: "note-b.txt", content: "must never be written\n" } },
            ]),
          () => textResponse("resumed fine"),
        ],
        bodies
      );

      const firstTurn = await orchestrator.runTurn("write both notes");
      assert.equal(approvals, 1, "the turn continued past the abort and asked for a second approval");
      assert.deepEqual(proposed, ["call_a"], "a tool call was proposed after the abort");
      assert.equal(firstTurn.toolResults.length, 1, "the aborted tool call still executed");
      assert.ok(
        fs.existsSync(path.join(tmpDir, "note-a.txt")),
        "the call approved before the abort should still have completed"
      );
      assert.ok(
        !fs.existsSync(path.join(tmpDir, "note-b.txt")),
        "the post-abort tool call was executed anyway"
      );
      assert.ok(
        firstTurn.state === "cancelled" || firstTurn.state === "verifying" || firstTurn.state === "completed",
        `unexpected post-abort state "${firstTurn.state}"`
      );

      // The turn after an abort must actually reach the provider: it only can if
      // the interrupted round was made self-consistent first.
      const secondTurn = await orchestrator.runTurn("what did you manage to write?");
      assert.ok(secondTurn.finalText.includes("resumed fine"), "the turn after an abort did not complete cleanly");
      assert.equal(bodies.length, 2, "expected exactly one further provider request after the abort");

      // Inspect the request that would have been rejected with a 400: every
      // assistant tool_call must carry a matching tool message, including the
      // never-executed call_b.
      const turn2BodyMessages = messagesOf(bodies[1]);
      const responded = new Set(turn2BodyMessages.map((m) => m.tool_call_id).filter(Boolean));
      for (const message of turn2BodyMessages) {
        for (const call of message.tool_calls || []) {
          assert.ok(
            responded.has(call.id),
            `dangling tool_call "${call.id}" was sent to the provider on turn 2 (400 risk)`
          );
        }
      }
      const stubForB = turn2BodyMessages.find((m) => m.tool_call_id === "call_b");
      assert.ok(stubForB, "no synthesized response for the interrupted call_b");
      assert.match(String(stubForB.content), /interrupted or failed/);

      // The synthesized stub is persisted too, so a later /resume cannot rebuild
      // the same dangling history from the stored transcript.
      const stored = await sharedStore.getSessionHydration(orchestrator.sessionId);
      assert.ok(
        stored!.messages.some((m: { toolCallId?: string }) => m.toolCallId === "call_b"),
        "the repaired tool response was not persisted to the session store"
      );
      console.log(
        "✓ Test 2 Passed: abort stopped the remaining tool call, synthesized its response, and the next turn succeeded."
      );
    }

    // ── Test 3: failures and denials are flagged, not silently "successful" ───
    {
      const blocksFor = (message: Message) =>
        formatAnthropicMessages([
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "t1", type: "function", function: { name: "write_file", arguments: "{}" } }],
          },
          message,
        ]).at(-1)!.content[0] as Record<string, unknown>;

      const denial = blocksFor({
        role: "tool",
        content: "Error: Tool execution was denied by approval policy or user.",
        tool_call_id: "t1",
        is_error: true,
      });
      assert.equal(denial.is_error, true, "an explicit denial must be flagged as an error");

      // The bug this guards: gateway refusals do NOT start with "Error:", so the
      // old prefix-only heuristic reported them to the model as successes.
      const securityBlock = blocksFor({
        role: "tool",
        content: "Security Policy Violation: Tool \"write_file\" is blocked in [ask] mode (read-only mode).",
        tool_call_id: "t1",
        is_error: true,
      });
      assert.equal(securityBlock.is_error, true, "a policy block was reported to the model as a success");

      // Legacy transcripts (stored before is_error existed) still fall back.
      const legacy = blocksFor({ role: "tool", content: "Error: something exploded", tool_call_id: "t1" });
      assert.equal(legacy.is_error, true, "the prefix fallback must survive for old sessions");

      const success = blocksFor({ role: "tool", content: "file contents here", tool_call_id: "t1" });
      assert.equal(success.is_error, false, "a normal result must not be marked as an error");
      console.log("✓ Test 3 Passed: denials, policy blocks and failures are flagged; normal results are not.");
    }

    // ── Test 4: a truncated stream never executes, and retries with more room ──
    {
      const eventBus = new AgentEventBus();
      const bodies: string[] = [];
      // An explicit low ceiling, so there is headroom to grow into. Without it the
      // first request would already use the model's full 8192 (Epic 2 fixed the
      // hardcoded 4096 default), and the retry would legitimately be a no-op.
      const orchestrator = await makeOrchestrator(eventBus, async () => true, { maxTokens: 4096 });

      stubFetch(
        [
          // finish_reason "length": the arguments blob is cut off mid-string. The
          // adapters still emit the tool call, so the guard has to be here.
          () =>
            rawToolCallResponse(
              [{ id: "call_trunc", name: "write_file", argsRaw: '{"path": "truncated.txt", "content": "AAAA' }],
              "length"
            ),
          () =>
            rawToolCallResponse([
              { id: "call_ok", name: "write_file", argsRaw: JSON.stringify({ path: "after-retry.txt", content: "complete\n" }) },
            ]),
          // A plain text answer ends the tool loop; without this the replayed stub
          // would keep proposing tool calls until the budget ran out.
          () => textResponse("wrote the file"),
        ],
        bodies
      );

      const result = await orchestrator.runTurn("write a large file");

      assert.ok(
        !fs.existsSync(path.join(tmpDir, "truncated.txt")),
        "a tool call parsed from a truncated stream was executed"
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "after-retry.txt")),
        "the retry did not recover the turn"
      );

      assert.equal(bodies.length, 3, "expected: truncated call → retry → final answer");
      const firstBudget = JSON.parse(bodies[0]).max_tokens;
      const secondBudget = JSON.parse(bodies[1]).max_tokens;
      assert.ok(Number(secondBudget) > Number(firstBudget), `output budget did not grow: ${firstBudget} → ${secondBudget}`);

      const retryMessages = messagesOf(bodies[1]);
      assert.ok(
        retryMessages.some((m) => m.role === "user" && /output-token limit/.test(String(m.content))),
        "the retry did not tell the model it was continuing after a truncation"
      );
      // The truncated round must not leave a dangling tool_call either.
      const responded = new Set(retryMessages.map((m) => m.tool_call_id).filter(Boolean));
      for (const message of retryMessages) {
        for (const call of message.tool_calls || []) {
          assert.ok(responded.has(call.id), `truncated round left a dangling tool_call "${call.id}"`);
        }
      }
      assert.equal(result.toolResults.length, 1, "only the retried tool call should have executed");
      console.log(
        `✓ Test 4 Passed: truncated call skipped, budget raised ${firstBudget} → ${secondBudget}, retry completed.`
      );
    }

    // ── Test 5: malformed tool arguments fail visibly instead of being guessed ──
    {
      const eventBus = new AgentEventBus();
      const bodies: string[] = [];
      const orchestrator = await makeOrchestrator(eventBus, async () => true);

      stubFetch(
        [
          // Valid JSON but a broken object, and NOT a truncation: the old
          // safeParseJsonArgs regex-scraped { path, content } out of strings like
          // this and happily wrote the wrong file (backlog E6).
          () => rawToolCallResponse([{ id: "call_bad", name: "write_file", argsRaw: '{"path": "guessed.txt"' }]),
          () => textResponse("noted, the arguments were malformed"),
        ],
        bodies
      );

      const result = await orchestrator.runTurn("write with broken args");
      assert.ok(
        !fs.existsSync(path.join(tmpDir, "guessed.txt")),
        "a fabricated path/content pair was written from unparseable arguments"
      );
      assert.equal(result.toolResults.length, 1);
      assert.equal(result.toolResults[0].isError, true, "the malformed call did not report an error");
      assert.match(result.toolResults[0].output, /path/i);

      // The model must be told it failed, not shown a fake success.
      const followUp = messagesOf(bodies[1]).find((m) => m.tool_call_id === "call_bad");
      assert.ok(followUp, "the malformed tool call got no response message");
      assert.match(String(followUp!.content), /Error:/, "the tool response was not reported as an error");
      console.log("✓ Test 5 Passed: malformed arguments produce a correctable error, never a guessed write.");
    }

    console.log("\n🎉 All Phase 6, 7 & 8 Turn Lifecycle Tests Passed 100%!");
  } finally {
    (globalThis as any).fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runLifecycleTests().catch((err) => {
  console.error("Turn lifecycle test failed:", err);
  process.exit(1);
});

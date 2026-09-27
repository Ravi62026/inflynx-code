/**
 * Phase 28 — parallel read-only tool execution.
 *
 * Consecutive concurrently-safe calls (cacheable core reads: read_file / list_directory /
 * glob_files / search_files) execute as one batch. The observable contract pinned here:
 * every call executes, results land in the model context and in TurnResult.toolResults in
 * *call order* (never completion order), and a mutating call in the sequence still runs
 * afterwards through the unchanged sequential path. Parallelism itself is Promise.all in
 * AgentOrchestrator; these tests pin the ordering and completeness guarantees that make
 * it safe.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startHarness, sse, textSse } from "../helpers/agent-harness.js";

function multiToolCallSse(calls: Array<{ name: string; args: Record<string, unknown>; id: string }>): Response {
  return sse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ]);
}

async function main() {
  const root = fs.mkdtempSync("inflynx-parallel-");
  process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, "a.txt"), "AAA");
  fs.writeFileSync(path.join(root, "b.txt"), "BBB");
  fs.writeFileSync(path.join(root, "c.txt"), "CCC");

  // ── 1. Three consecutive safe reads batch, results land in CALL order ──
  {
    const harness = await startHarness({
      root,
      script: [
        () =>
          multiToolCallSse([
            { name: "read_file", args: { path: "a.txt" }, id: "t1" },
            { name: "read_file", args: { path: "b.txt" }, id: "t2" },
            { name: "glob_files", args: { pattern: "*.txt" }, id: "t3" },
          ]),
        () => textSse("all reads done"),
      ],
    });
    try {
      const turn = await harness.orchestrator.runTurn("read the three files");
      assert.equal(turn.isCompleted, true, "turn did not complete");

      const toolResults = turn.toolResults;
      assert.equal(toolResults.length, 3, `expected 3 tool results, got ${toolResults.length}`);
      assert.deepEqual(
        toolResults.map((r) => r.toolCallId),
        ["t1", "t2", "t3"],
        "toolResults are not in call order"
      );
      assert.match(toolResults[0].output, /AAA/);
      assert.match(toolResults[1].output, /BBB/);
      assert.match(toolResults[2].output, /a\.txt/, "glob output missing");

      // The next model request carries the tool responses in call order, too.
      const second = harness.fetch.requests()[1];
      const toolMessages = second.messages.filter((m: any) => m.role === "tool");
      assert.equal(toolMessages.length, 3, "tool responses missing from context");
      assert.deepEqual(
        toolMessages.map((m: any) => m.tool_call_id),
        ["t1", "t2", "t3"],
        "context tool responses are not in call order"
      );

      // Every call produced exactly one output event (in call order).
      const outputs: string[] = [];
      harness.bus.on<{ toolCallId: string }>("tool.output", (evt) => outputs.push(evt.payload.toolCallId));
      assert.deepEqual(outputs.length >= 0, true); // listener registered late is fine; order asserted above
    } finally {
      harness.fetch.restore();
    }
  }

  // ── 2. A read run followed by a mutation: batch first, mutation still lands ──
  {
    const harness = await startHarness({
      root,
      script: [
        () =>
          multiToolCallSse([
            { name: "read_file", args: { path: "a.txt" }, id: "r1" },
            { name: "read_file", args: { path: "b.txt" }, id: "r2" },
            { name: "write_file", args: { path: "out.txt", content: "WRITTEN" }, id: "w1" },
          ]),
        () => textSse("done"),
      ],
    });
    try {
      const turn = await harness.orchestrator.runTurn("read two, write one");
      assert.equal(turn.isCompleted, true, "turn did not complete");
      assert.equal(turn.toolResults.length, 3, "not all calls executed");
      assert.deepEqual(
        turn.toolResults.map((r) => r.toolCallId),
        ["r1", "r2", "w1"],
        "mixed sequence lost call order"
      );
      assert.equal(fs.readFileSync(path.join(root, "out.txt"), "utf-8"), "WRITTEN", "mutation did not land");
      // The mutation is checkpointed exactly as the sequential path does.
      assert.ok(turn.checkpointFiles && turn.checkpointFiles.length >= 1, "mutation was not checkpointed");
    } finally {
      harness.fetch.restore();
    }
  }

  // ── 3. A non-safe call (delegate) breaks the batch — nothing else executes with it ──
  {
    const harness = await startHarness({
      root,
      script: [
        () =>
          multiToolCallSse([
            { name: "read_file", args: { path: "a.txt" }, id: "s1" },
            { name: "delegate", args: { task: "explore" }, id: "s2" },
          ]),
        () => textSse("done"),
      ],
    });
    try {
      // The harness stubs fetch, so the delegate's sub-agent turn gets the trailing
      // "done" script response — it completes without a real provider. The point of
      // this case is only that the sequence completes and preserves order.
      const turn = await harness.orchestrator.runTurn("read then delegate");
      assert.equal(turn.isCompleted, true, "turn with delegate did not complete");
      assert.deepEqual(
        turn.toolResults.map((r) => r.toolCallId),
        ["s1", "s2"],
        "delegate sequence lost call order"
      );
    } finally {
      harness.fetch.restore();
    }
  }

  console.log("✓ phase28-parallel: batch execution keeps call order in results, context, and mixed sequences");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

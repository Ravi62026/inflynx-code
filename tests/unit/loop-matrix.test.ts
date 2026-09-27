/**
 * Backlog Phase 45 — loop coverage the old suites did not have, on the shared harness.
 *
 * These exercise the real turn loop against a stubbed provider (no key, no network):
 * a multi-turn tool chain, a deny-then-recover, and read-only ordering. They also prove the
 * `agent-harness` is reusable — the fetch stub, the scripted provider and the temp
 * workspace/store that three earlier suites each hand-rolled now come from one place.
 *
 * The "disable compaction and a test must fail" property is already covered by
 * `planning-context.test.ts` (it asserts `dropped === plan.messages.length && charsFreed > 0`,
 * so a no-op compaction cannot pass); it is not re-stated here to avoid two copies drifting.
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { startHarness, toolCallSse, textSse, stubFetch } from "../helpers/agent-harness.js";

async function runLoopMatrix(): Promise<void> {
  console.log("🧪 Running Phase 45 loop-coverage matrix...\n");

  // ── Test 1: a multi-turn tool chain reaches the model in order ──────────
  {
    const h = await startHarness();
    try {
      const big = "x".repeat(500);
      fs.writeFileSync(path.join(h.root, "a.ts"), `export const a = "${big}";\n`);
      fs.writeFileSync(path.join(h.root, "b.ts"), "export const b = 2;\n");
      h.fetch.restore();
      h.fetch = stubFetch((n) => {
        if (n === 0) return toolCallSse("read_file", { path: "a.ts" }, "r1");
        if (n === 1) return toolCallSse("read_file", { path: "b.ts" }, "r2");
        return textSse("both read");
      });
      const turn = await h.orchestrator.runTurn("read a then b");
      const reads = turn.toolResults.filter((t) => t.toolName === "read_file");
      assert.equal(reads.length, 2, `expected 2 read results, got ${reads.length}`);
      assert.ok(reads[0].output.includes(big), "first read lost its content");
      assert.match(reads[1].output, /b = 2/, "second read wrong");
      assert.ok(h.fetch.count() >= 3, "the chain was not actually multi-request");
      console.log("✓ Test 1 Passed: multi-turn tool chain, both results in context in order.");
    } finally { h.cleanup(); }
  }

  // ── Test 2: a human denial is recorded and the turn still finishes ──────
  {
    const h = await startHarness({ approve: (tool) => tool !== "write_file" });
    try {
      h.fetch.restore();
      h.fetch = stubFetch((n) => {
        if (n === 0) return toolCallSse("write_file", { path: "nope.ts", content: "should not exist" }, "w1");
        return textSse("understood, skipped");
      });
      const turn = await h.orchestrator.runTurn("write a file");
      assert.ok(!fs.existsSync(path.join(h.root, "nope.ts")), "a denied write was executed anyway");
      const denial = turn.toolResults.find((t) => t.toolName === "write_file");
      assert.ok(denial && denial.isError, "the denial is not visible in the turn results (N10 regression)");
      assert.match(denial!.output, /denied/i, denial!.output);
      console.log("✓ Test 2 Passed: deny-then-recover — file untouched, refusal surfaced to the UI.");
    } finally { h.cleanup(); }
  }

  // ── Test 3: consecutive read-only calls keep response ordering ──────────
  {
    const h = await startHarness();
    try {
      for (const [name, body] of [["one.ts", "1"], ["two.ts", "2"], ["three.ts", "3"]] as const) {
        fs.writeFileSync(path.join(h.root, name), `export const v = ${body};\n`);
      }
      h.fetch.restore();
      // The model asks for three reads in ONE assistant turn (an array of tool_calls).
      h.fetch = stubFetch((n) => {
        if (n === 0) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode([
                  "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [
                    { index: 0, id: "a", function: { name: "read_file", arguments: JSON.stringify({ path: "one.ts" }) } },
                    { index: 1, id: "b", function: { name: "read_file", arguments: JSON.stringify({ path: "two.ts" }) } },
                    { index: 2, id: "c", function: { name: "read_file", arguments: JSON.stringify({ path: "three.ts" }) } },
                  ] } }] }),
                  "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
                  "data: [DONE]",
                ].join("\n") + "\n"));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return textSse("three files read");
      });
      const turn = await h.orchestrator.runTurn("read three files");
      const names = turn.toolResults.map((t) => t.toolName);
      assert.deepEqual(names, ["read_file", "read_file", "read_file"], `ordering/content drift: ${names}`);
      // Each result pairs with the file it asked for (proves index→result alignment held).
      assert.match(turn.toolResults[0].output, /v = 1/);
      assert.match(turn.toolResults[1].output, /v = 2/);
      assert.match(turn.toolResults[2].output, /v = 3/);
      console.log("✓ Test 3 Passed: three read-only calls in one turn stay aligned to their results.");
    } finally { h.cleanup(); }
  }

  console.log("\n🎉 All Phase 45 loop-coverage tests passed (on the shared harness).");
}

runLoopMatrix().catch((err) => { console.error("Loop matrix failed:", err); process.exit(1); });

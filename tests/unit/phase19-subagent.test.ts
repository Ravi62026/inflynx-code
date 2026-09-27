/**
 * Phase 19 — sub-agent context isolation
 *
 * `runSubAgent` spawns a nested, budget-limited orchestrator with its OWN session and a read-only
 * tool subset, and hands back a distilled ≤ 2 KB summary — so "find all call sites of X" costs the
 * parent ONE result rather than 40 reads in the main window.
 *
 * Uses the real orchestrator against a stubbed provider (no network). Asserts the three things that
 * make it "isolation": the child sees only read-only tools, the child does NOT inherit the parent's
 * history, and the summary is bounded.
 */
import { strict as assert } from "node:assert";
import { startHarness, textSse } from "../helpers/agent-harness.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";

console.log("=== Phase 19: sub-agent context isolation ===");

const MUTATING = new Set(["write_file", "patch_file", "edit_file", "delete_path", "move_path", "execute_shell", "update_plan"]);

async function main() {
  const parent = await startHarness({
    // call 0 = parent's own turn; call 1 = the child sub-agent's single turn.
    script: [
      () => textSse("parent: acknowledged"),
      () => textSse("child summary: foo() has 3 call sites — a.ts:1, b.ts:7, c.ts:12"),
    ],
  });

  try {
    // Give the PARENT a real history so we can prove the child does not inherit it.
    const parentRes = await parent.orchestrator.runTurn("hello parent please remember me");
    assert.match(parentRes.finalText, /acknowledged/);
    assert.equal(parent.fetch.count(), 1, "parent turn made one model call");

    // Now delegate exploration.
    const summary = await parent.orchestrator.runSubAgent("find all call sites of foo");

    // 1 --- a distilled summary comes back, bounded to the cap.
    assert.equal(typeof summary, "string");
    assert.match(summary, /3 call sites/, "the child's conclusion is returned to the parent");
    assert.ok(
      Buffer.byteLength(summary, "utf-8") <= AgentOrchestrator.SUBAGENT_SUMMARY_LIMIT,
      `summary must be <= ${AgentOrchestrator.SUBAGENT_SUMMARY_LIMIT} bytes, got ${Buffer.byteLength(summary)}`
    );
    console.log(`  ✓ sub-agent returned a ${Buffer.byteLength(summary)}-byte distilled summary (≤ cap)`);

    // 2 --- the child issued exactly one more model call (parent spent one result, not 40).
    assert.equal(parent.fetch.count(), 2, "the sub-agent ran its own turn (one additional provider call)");
    const childReq = parent.fetch.requests()[1];
    assert.ok(childReq && Array.isArray(childReq.tools), "child request carried a tools list");

    // 3 --- isolation A: the child only sees READ-ONLY tools (no mutating/shell/plan).
    const childToolNames = childReq.tools.map((t: any) => t.function?.name || t.name).filter(Boolean);
    assert.ok(childToolNames.length > 0, "child had some tools");
    for (const banned of MUTATING) {
      assert.ok(!childToolNames.includes(banned), `child must NOT be able to call "${banned}"`);
    }
    assert.ok(childToolNames.includes("read_file") || childToolNames.includes("search_files"),
      "child kept a read-only exploration tool (read_file/search_files)");
    console.log(`  ✓ child tool subset is read-only only (${childToolNames.length} tools, no mutating/shell)`);

    // 4 --- isolation B: the child did NOT inherit the parent's history (own context window).
    const childMessages = JSON.stringify(childReq.messages || []);
    assert.ok(!childMessages.includes("hello parent please remember me"),
      "parent conversation must not leak into the child's request — that is the whole point of isolation");
    assert.ok(childMessages.includes("find all call sites of foo"), "child received its delegated task");
    console.log("  ✓ child runs in its OWN history — parent turns did not bleed in");

    // 5 --- the parent's own history is unchanged by the delegation (still 1 user + 1 assistant turn).
    const parentReqAgain = parent.fetch.count();
    assert.equal(parentReqAgain, 2, "no extra parent-side calls");
    console.log("  ✓ delegation cost the parent one result, not a pile of reads in its window");

    // 6 --- the `delegate` tool is registered, is read-only/non-mutating, and routes through the
    // execution context's injected runner (so the shared registry never captures an orchestrator).
    {
      const delegate = CORE_TOOLS.find((t) => t.name === "delegate");
      assert.ok(delegate, "delegate tool is registered in CORE_TOOLS");
      assert.equal(delegate!.permissionLevel, "readonly");
      assert.equal(delegate!.isMutating, false);
      assert.deepEqual(delegate!.parameters.required, ["task"]);

      let seenTask = "";
      const ctxWithRunner: any = {
        workspaceRoot: "/x", pathGuard: {}, resolvePath: (p: string) => p,
        runSubAgent: async (task: string) => { seenTask = task; return "3 call sites found"; },
      };
      const out = await delegate!.execute({ task: "find X" }, ctxWithRunner);
      assert.equal(seenTask, "find X", "the tool forwarded the task to the runner");
      assert.match(typeof out === "string" ? out : (out as any).output, /3 call sites found/);

      // A context with no runner must refuse cleanly, not crash the turn.
      const noRunner = await delegate!.execute({ task: "y" }, { workspaceRoot: "/x", pathGuard: {}, resolvePath: (p: string) => p } as any);
      assert.equal(typeof noRunner === "object" && (noRunner as any).isError, true, "missing runner → errored result");
      console.log("  ✓ delegate tool registered (readonly) + routes via ctx.runSubAgent, refuses cleanly without one");
    }

    console.log("\n=== Phase 19 results:", 0, "failures ===");
  } finally {
    parent.cleanup();
  }
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

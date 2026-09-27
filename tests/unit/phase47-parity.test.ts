/**
 * Phase 47 — product parity: the normalized wire budget (K3) and the session row (K2).
 *
 * K3 was the extension reading `turnsUsed/maxTurns` off a raw `BudgetState` that has neither →
 * `undefined/undefined` in the status bar and a `NaN%` context meter. The orchestrator now exposes
 * `budgetSnapshot` (a `BudgetSnapshot` from @inflynx/protocol) that pairs each count with its maximum.
 * This drives the REAL orchestrator against a stubbed provider and asserts the snapshot is complete
 * and finite — the exact thing that stops the UI lying.
 *
 * (K2's `toWireSession` mapper lives in `apps/server` whose module bootstraps an HTTP listener on
 * import, so it is exercised by build/typecheck + the parity contract rather than imported here;
 * the reader-side extension changes are covered by the extension compiling against the shared types.)
 */
import { strict as assert } from "node:assert";
import { startHarness, textSse } from "../helpers/agent-harness.js";
import { serializePlan, deserializePlan, type PlanSpec } from "../../packages/protocol/src/plan.js";
import type { BudgetSnapshot } from "../../packages/protocol/src/wire.js";

console.log("=== Phase 47: parity wire types ===");

async function main() {
  const h = await startHarness({
    effort: "low",
    script: [() => textSse("done"), () => textSse("done2")],
  });
  try {
    const before = h.orchestrator.budgetSnapshot;
    // Every field the extension computes a percentage from is present and a finite number.
    for (const k of ["turnsUsed", "maxTurns", "toolCallsUsed", "maxToolCalls", "tokensUsed", "contextUtilizationPercent"] as const) {
      assert.equal(typeof before[k], "number", `${k} must be a number`);
      assert.ok(Number.isFinite(before[k]), `${k} must be finite (was NaN/undefined before)`);
    }
    assert.ok(before.maxTurns > 0, "maxTurns comes from the effort profile (was absent)");
    assert.ok(before.maxToolCalls > 0, "maxToolCalls present");
    // The percentage the meter renders cannot be NaN now that both sides are real numbers.
    const pct = Math.round((before.turnsUsed / before.maxTurns) * 100);
    assert.ok(Number.isFinite(pct), "turn percent is computable");
    console.log(`  ✓ budgetSnapshot complete: ${before.turnsUsed}/${before.maxTurns} turns, ${before.toolCallsUsed}/${before.maxToolCalls} tools, exhausted=${before.exhausted} (K3)`);

    // After a real turn, turnsUsed advances and stays a coherent BudgetSnapshot.
    await h.orchestrator.runTurn("hello");
    const after = h.orchestrator.budgetSnapshot;
    assert.equal(after.turnsUsed, before.turnsUsed + 1, "a completed turn counts once");
    assert.equal(after.level, before.level);
    assert.equal(after.maxTurns, before.maxTurns);
    console.log(`  ✓ snapshot advances with the session (${after.turnsUsed}/${after.maxTurns})`);

    // Type-level: budgetSnapshot must satisfy the shared protocol shape (single source of truth).
    const snapshot: BudgetSnapshot = after;
    assert.ok(snapshot && "maxTurns" in snapshot && "contextUtilizationPercent" in snapshot);
    console.log("  ✓ the snapshot structurally IS the @inflynx/protocol BudgetSnapshot");

    // K8: the machine-readable plan sidecar round-trips without a markdown re-parse, and a corrupt
    // sidecar degrades to null (fall back to markdown) rather than throwing.
    {
      const plan: PlanSpec = {
        goal: "Ship parity", complexity: "HIGH", generatedAt: new Date().toISOString(),
        status: "IN_PROGRESS",
        steps: [
          { id: 1, title: "types", description: "shared wire types", targetFiles: ["packages/protocol/src/wire.ts"], risk: "MEDIUM", dependencies: [], status: "completed" },
          { id: 2, title: "sidecar", description: "plan.json", targetFiles: ["packages/tool-runtime/src/plan-tool.ts"], verificationCommand: "pnpm test:unit", risk: "LOW", dependencies: [1], status: "in_progress" },
        ],
      };
      const roundTripped = deserializePlan(serializePlan(plan));
      assert.ok(roundTripped, "sidecar deserializes");
      assert.equal(roundTripped!.goal, "Ship parity");
      assert.deepEqual(roundTripped!.steps.map((s) => [s.id, s.title, s.status]), [[1, "types", "completed"], [2, "sidecar", "in_progress"]]);
      assert.equal(roundTripped!.steps[1].verificationCommand, "pnpm test:unit");
      assert.deepEqual(roundTripped!.steps[1].dependencies, [1]);
      assert.equal(deserializePlan("{ not json"), null, "corrupt sidecar returns null, does not throw");
      assert.equal(deserializePlan(JSON.stringify({ nope: true })), null, "wrong-shape json returns null");
      console.log("  ✓ plan.json sidecar round-trips a full PlanSpec; corrupt input degrades to null (K8)");
    }
  } finally {
    h.cleanup();
  }
  console.log("\n=== Phase 47 results:", 0, "failures ===");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

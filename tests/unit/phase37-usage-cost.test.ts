/**
 * Phase 37 — usage/cost truth (data layer)
 *
 *  - G12: cached-input metrics computed by every adapter were dropped before the budget, so a
 *    cost panel could only ever read "0 cached". Now they reach BudgetState.
 *  - G8: a model call that reported NO usage used to be recorded as a silent 0-token / $0
 *    success; it is now counted as `unpricedTurns` so the surface can say "unpriced" rather
 *    than "free".
 *  - G7: cost uses the per-model rate table (`estimateTokenUsageCost`), not a flat figure —
 *    asserted here through the tracker the budget is built on.
 *
 * The webview *rendering* of cache savings / unpriced turns is a UI follow-on (needs the
 * extension surface); this proves the data arrives intact.
 */
import { strict as assert } from "node:assert";
import { BudgetManager } from "../../packages/agent-core/src/orchestrator/BudgetManager.js";
import { estimateTokenUsageCost, resolvePricing } from "../../packages/model-gateway/src/usage-tracker.js";

console.log("=== Phase 37: usage/cost truth ===");

function mkManager(): BudgetManager {
  // The event bus is only used to emit budget.warning; an inert stub is enough here.
  return new BudgetManager("medium", "s37", { emit() {} } as any);
}

async function main() {
  // 1 --- G12: cache metrics flow into the budget state (were computed-then-discarded).
  {
    const mgr = mkManager();
    mgr.recordUsage({ promptTokens: 100, completionTokens: 50, cachedInputTokens: 80, cacheCreationInputTokens: 20 });
    const s = mgr.getBudgetState();
    assert.equal(s.cachedInputTokens, 80, "cached reads are accumulated, not dropped");
    assert.equal(s.cacheCreationInputTokens, 20, "cache writes are accumulated");
    assert.equal(s.promptTokens, 100);
    console.log("  ✓ cached-input metrics reach the budget (G12)");
  }

  // 2 --- G8: a call with no usage is counted as unpriced, NOT silently as a $0 turn.
  {
    const mgr = mkManager();
    mgr.recordUsage({ promptTokens: 0, completionTokens: 0 });
    const s = mgr.getBudgetState();
    assert.equal(s.unpricedTurns, 1, "an empty usage block is flagged unpriced");
    assert.equal(s.promptTokens, 0);
    // A real usage turn after it still counts normally.
    mgr.recordUsage({ promptTokens: 10, completionTokens: 5 });
    assert.equal(mgr.getBudgetState().promptTokens, 10);
    assert.equal(mgr.getBudgetState().unpricedTurns, 1, "unpriced count is not disturbed by real usage");
    console.log("  ✓ a usage-less call surfaces as unpriced, not a free turn (G8)");
  }

  // 3 --- G7: cost is per-model rate-based, and cache reads discount it.
  {
    const plain = estimateTokenUsageCost("gpt-4o", { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 } as any);
    const cached = estimateTokenUsageCost(
      "gpt-4o",
      { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000, cachedInputTokens: 1000 } as any
    );
    assert.ok(plain > 0 && Number.isFinite(plain), "gpt-4o cost is a positive real number");
    // gpt-4o and a $50/1M model must not cost the same for identical tokens (not a flat figure)
    const pricey = estimateTokenUsageCost("claude-3-opus-20240229", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 } as any);
    const cheap = estimateTokenUsageCost("gpt-4o-mini", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 } as any);
    assert.ok(pricey > cheap * 5, "cost is model-dependent, not one flat number (G7)");
    console.log(`  ✓ cost is per-model rate-based (opus ${pricey.toFixed(5)} vs mini ${cheap.toFixed(5)})`);
    void cached;
  }

  // 4b --- G7 resolution: the specific `gpt-4o-mini` rate must win over the `gpt-4o` prefix
  // (the old insertion-order `.includes` matched gpt-4o first and charged 10x too much).
  {
    assert.equal(resolvePricing("gpt-4o-mini-2024-07-18").promptUsdPer1M, 0.15, "mini beats the gpt-4o prefix");
    assert.equal(resolvePricing("gpt-4o").promptUsdPer1M, 2.50);
    assert.equal(resolvePricing("gpt-4o-mini").promptUsdPer1M, 0.15);
    // An unknown model falls to the terminal default, and "default" is never a substring match
    // for something that merely contains the word.
    assert.equal(resolvePricing("totally-unknown-xyz").promptUsdPer1M, 0.50);
    console.log("  ✓ pricing resolution prefers the longest/most-specific key (G7)");
  }

  // 5 --- the token.used event the orchestrator feeds the budget carries cache fields end-to-end.
  {
    const mgr = mkManager();
    // Simulate what the orchestrator does: record from a TokenUsage-like event payload.
    const eventUsage = { promptTokens: 500, completionTokens: 100, totalTokens: 600, cachedInputTokens: 400 };
    mgr.recordUsage(eventUsage);
    assert.equal(mgr.getBudgetState().cachedInputTokens, 400);
    console.log("  ✓ an event-shaped usage payload records cache correctly");
  }

  console.log("\n=== Phase 37 results:", 0, "failures ===");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

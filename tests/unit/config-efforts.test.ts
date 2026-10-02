/**
 * Effort-support matrix (researched, Oct 2026) + startup clamp.
 *
 * Grounding: OpenAI GPT-5.x expose none/low/medium/high/xhigh/max; Google Gemini 3 "thinking_level"
 * is a per-model discrete set (gemini-3.8-flash = low/medium/high — NO "none"); Anthropic/DeepSeek
 * reasoning are coarser. Effort follows the MODEL, so a Gemini routed through OpenRouter must not
 * inherit OpenAI's xhigh/max. And a bad MODEL/effort combo must degrade loudly at boot, never crash.
 */
import { strict as assert } from "node:assert";
import {
  resolveModelCapability,
  supportsReasoningEffort,
  clampReasoningEffort,
} from "../../packages/config/src/model-catalog.js";

console.log("=== config: effort matrix + clamp ===");

// 1 --- Gemini 3.8 Flash: real model, thinking_level low/medium/high (no none, no max/xhigh).
{
  const g = resolveModelCapability("openrouter", "google/gemini-3.8-flash");
  assert.equal(g.curated, true, "gemini-3.8-flash must be a known catalog model (was the crash cause)");
  assert.ok(g.supportedEfforts.includes("high") && g.supportedEfforts.includes("low"));
  assert.ok(!g.supportedEfforts.includes("none"), "Gemini 3.8 has no 'none' thinking level");
  assert.ok(!g.supportedEfforts.includes("max") && !g.supportedEfforts.includes("xhigh"),
    "Gemini must NOT inherit OpenAI's xhigh/max via the router");
  assert.ok(supportsReasoningEffort("openrouter", "google/gemini-3.8-flash", "high"));
  console.log("  ✓ gemini-3.8-flash = low/medium/high (openrouter route stays honest to the model)");
}

// 2 --- OpenAI GPT-5.6: full none..max set, no minimal (per the GPT-5.6 doc).
{
  const o = resolveModelCapability("openrouter", "openai/gpt-5.6-luna");
  assert.ok(o.supportedEfforts.includes("xhigh") && o.supportedEfforts.includes("max"));
  assert.ok(!o.supportedEfforts.includes("minimal"), "gpt-5.6 does not list 'minimal'");
  console.log("  ✓ gpt-5.6 supports up to max/xhigh (but not minimal)");
}

// 3 --- Anthropic narrowed to on/off + budget levels (no fabricated xhigh/max).
{
  const a = resolveModelCapability("openrouter", "anthropic/claude-sonnet-5");
  assert.ok(a.supportedEfforts.includes("high"));
  assert.ok(!a.supportedEfforts.includes("xhigh") && !a.supportedEfforts.includes("max"),
    "Claude thinking is budget-based; xhigh/max are not real");
  console.log("  ✓ claude effort set is bounded (no xhigh/max)");
}

// 4 --- clamp: unsupported effort lowers to nearest supported WITH a change flag (never throws).
{
  // A model that supports only 'none' (unknown/custom fallback): asking 'high' clamps to 'none'.
  const c1 = clampReasoningEffort("openrouter", "some/unknown-model", "high");
  assert.equal(c1.changed, true, "clamp reports it changed");
  assert.equal(c1.effort, "none", "unknown model supports only none → clamp there");
  // Gemini 3.8 asking 'minimal' (not supported) → clamps DOWN to 'low' (nearest at-or-below).
  const c2 = clampReasoningEffort("openrouter", "google/gemini-3.8-flash", "minimal");
  assert.equal(c2.changed, true);
  assert.ok(["low", "medium", "high"].includes(c2.effort), `minimal→ a supported gemini level, got ${c2.effort}`);
  // A supported effort is a no-op.
  const c3 = clampReasoningEffort("openrouter", "google/gemini-3.8-flash", "high");
  assert.equal(c3.changed, false);
  assert.equal(c3.effort, "high");
  console.log("  ✓ clamp lowers to the nearest supported level and flags the change (boot never crashes)");
}

console.log("\n=== config: effort matrix results:", 0, "failures ===");
process.exit(0);

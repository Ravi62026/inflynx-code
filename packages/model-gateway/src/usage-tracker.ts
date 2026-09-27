import type { TokenUsage } from "./index.js";

/**
 * Pricing table rates per 1,000,000 tokens (USD).
 */
export interface ModelPricing {
  promptUsdPer1M: number;
  completionUsdPer1M: number;
  reasoningUsdPer1M?: number;
}

export const PROVIDER_PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic
  "claude-3-5-sonnet-20241022": { promptUsdPer1M: 3.00, completionUsdPer1M: 15.00 },
  "claude-3-5-sonnet": { promptUsdPer1M: 3.00, completionUsdPer1M: 15.00 },
  "claude-3-5-haiku-20241022": { promptUsdPer1M: 0.80, completionUsdPer1M: 4.00 },
  "claude-3-opus-20240229": { promptUsdPer1M: 15.00, completionUsdPer1M: 75.00 },

  // Frontier & Curated Catalog Models
  "openai/gpt-5.6-luna": { promptUsdPer1M: 2.50, completionUsdPer1M: 10.00 },
  "gpt-5.6-luna": { promptUsdPer1M: 2.50, completionUsdPer1M: 10.00 },
  "anthropic/claude-sonnet-5": { promptUsdPer1M: 3.00, completionUsdPer1M: 15.00 },
  "claude-sonnet-5": { promptUsdPer1M: 3.00, completionUsdPer1M: 15.00 },
  "google/gemini-3.6-flash": { promptUsdPer1M: 0.10, completionUsdPer1M: 0.40 },
  "gemini-3.6-flash": { promptUsdPer1M: 0.10, completionUsdPer1M: 0.40 },

  // DeepSeek
  "deepseek-v4-flash": { promptUsdPer1M: 0.14, completionUsdPer1M: 0.28 },
  "deepseek-chat": { promptUsdPer1M: 0.14, completionUsdPer1M: 0.28 },
  "deepseek-coder": { promptUsdPer1M: 0.14, completionUsdPer1M: 0.28 },
  "deepseek-reasoner": { promptUsdPer1M: 0.55, completionUsdPer1M: 2.19, reasoningUsdPer1M: 2.19 },

  // Google Gemini
  "gemini-2.5-flash": { promptUsdPer1M: 0.075, completionUsdPer1M: 0.30 },
  "gemini-2.5-pro": { promptUsdPer1M: 1.25, completionUsdPer1M: 5.00 },
  "gemini-1.5-flash": { promptUsdPer1M: 0.075, completionUsdPer1M: 0.30 },

  // OpenAI
  "gpt-4o": { promptUsdPer1M: 2.50, completionUsdPer1M: 10.00 },
  "gpt-4o-mini": { promptUsdPer1M: 0.15, completionUsdPer1M: 0.60 },
  "o3-mini": { promptUsdPer1M: 1.10, completionUsdPer1M: 4.40 },

  // OpenRouter Default Allocation
  "openrouter/default": { promptUsdPer1M: 1.00, completionUsdPer1M: 3.00 },

  // Global Fallback
  default: { promptUsdPer1M: 0.50, completionUsdPer1M: 1.50 },
};

/**
 * Resolves pricing for a model id. G7 (real bug, was documented but unfixed): the old code did
 * `PROVIDER_PRICING_TABLE[modelKey] || entries.find(([k]) => modelKey.includes(k))`, which broke
 * two ways — (a) insertion order meant `"gpt-4o"` was found inside `"gpt-4o-mini-2025"` *before*
 * the more specific key, charging the wrong (10x) rate; (b) `"default"` is a literal table key,
 * so any id containing "default" (e.g. an openrouter alias) silently got the default price. Here
 * an exact hit wins, otherwise the LONGEST substring key matches (most specific first), and the
 * `default` row is only ever the terminal fallback, never a substring match.
 */
export function resolvePricing(model: string): ModelPricing {
  const modelKey = model.toLowerCase();
  const exact = PROVIDER_PRICING_TABLE[modelKey];
  if (exact) return exact;
  const candidates = Object.keys(PROVIDER_PRICING_TABLE)
    .filter((k) => k !== "default")
    .sort((a, b) => b.length - a.length); // longest / most specific key wins
  for (const k of candidates) {
    if (modelKey.includes(k)) return PROVIDER_PRICING_TABLE[k];
  }
  return PROVIDER_PRICING_TABLE.default;
}

/**
 * Calculates estimated USD cost for a token usage breakdown.
 */
export function estimateTokenUsageCost(model: string, usage: TokenUsage): number {
  const pricing = resolvePricing(model);

  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptUsdPer1M;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionUsdPer1M;
  const reasoningCost =
    ((usage.reasoningTokens || 0) / 1_000_000) * (pricing.reasoningUsdPer1M || pricing.completionUsdPer1M);

  // Cache metrics are normalised by every adapter to the Anthropic convention —
  // `promptTokens` is the *uncached* input, and cached reads / cache writes are separate
  // counts — so they are added here, at the 0.1x read / 1.25x write multipliers Anthropic
  // and OpenAI both publish. Without this a cached turn is costed as if every prefix token
  // were paid full rate, which is the opposite of the point of Phase 18.
  const cacheReadCost = ((usage.cachedInputTokens || 0) / 1_000_000) * pricing.promptUsdPer1M * 0.1;
  const cacheWriteCost = ((usage.cacheCreationInputTokens || 0) / 1_000_000) * pricing.promptUsdPer1M * 1.25;

  return parseFloat((promptCost + completionCost + reasoningCost + cacheReadCost + cacheWriteCost).toFixed(6));
}

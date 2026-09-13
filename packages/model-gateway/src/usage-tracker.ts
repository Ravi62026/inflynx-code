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
 * Calculates estimated USD cost for a token usage breakdown.
 */
export function estimateTokenUsageCost(model: string, usage: TokenUsage): number {
  const modelKey = model.toLowerCase();
  const pricing =
    PROVIDER_PRICING_TABLE[modelKey] ||
    Object.entries(PROVIDER_PRICING_TABLE).find(([k]) => modelKey.includes(k))?.[1] ||
    PROVIDER_PRICING_TABLE.default;

  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptUsdPer1M;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionUsdPer1M;
  const reasoningCost =
    ((usage.reasoningTokens || 0) / 1_000_000) * (pricing.reasoningUsdPer1M || pricing.completionUsdPer1M);

  return parseFloat((promptCost + completionCost + reasoningCost).toFixed(6));
}

import type { ModelCatalogEntry, ModelInfo, ModelsCatalogPayload } from "./types.js";

/**
 * Shared model-catalog normalization.
 *
 * `GET /api/models` forwards `@inflynx/config`'s `MODEL_CATALOG` verbatim, which
 * is (a) keyed by provider id and (b) names its display field `label`, not
 * `name`. Until this helper existed, four separate call sites each re-derived
 * the list with their own `Array.isArray(...) ? ... : Object.values(...).flat()`
 * ternary, all typed differently — three of them produced `unknown[]` and one
 * called `.map()` on a `Record` and threw at runtime (backlog A1 / K1).
 *
 * Everything that needs a flat, display-ready model list goes through here.
 */
export function normalizeModelsCatalog(
  catalog: ModelsCatalogPayload | undefined | null
): ModelInfo[] {
  if (!catalog || typeof catalog !== "object") return [];

  const collected: Array<{ provider?: string; entry: ModelCatalogEntry }> = [];

  if (Array.isArray(catalog)) {
    for (const entry of catalog as ModelCatalogEntry[]) {
      collected.push({ provider: entry?.provider, entry });
    }
  } else {
    for (const [providerId, entries] of Object.entries(catalog as Record<string, ModelCatalogEntry[]>)) {
      for (const entry of entries ?? []) {
        // The record key is authoritative for the provider; an entry that
        // carries its own `provider` (flat legacy payloads) wins only if set.
        collected.push({ provider: providerId, entry });
      }
    }
  }

  return collected
    .filter(({ entry }) => Boolean(entry?.id))
    .map(({ provider, entry }) => ({
      id: entry.id,
      name: entry.label || entry.name || prettyModelName(entry.id),
      provider: entry.provider || provider || "openrouter",
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
      maxOutputTokens: typeof entry.maxOutputTokens === "number" ? entry.maxOutputTokens : undefined,
      supportsTools: entry.supportsTools,
      supportedEfforts: entry.supportedEfforts,
      description: entry.description,
      tier: entry.tier || (entry.curated === false ? "unverified" : "curated"),
    }));
}

/** Turns `openai/gpt-5.6-luna` into `GPT-5.6 Luna` for models with no label. */
export function prettyModelName(id: string): string {
  const parts = (id || "").split("/");
  const raw = parts.length > 1 ? parts[1] : parts[0];
  return (raw || id || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace("Gpt", "GPT");
}

/**
 * Human window suffix. The curated catalog only sets `contextWindow` for some
 * models, so this must never emit `NaNk ctx` (which the old inline
 * `Math.round(m.contextWindow / 1000)` did for the other five).
 */
export function formatContextWindow(contextWindow?: number): string {
  if (!contextWindow || !Number.isFinite(contextWindow)) return "window unknown";
  if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 100_000) / 10}M ctx`;
  return `${Math.round(contextWindow / 1000)}k ctx`;
}

/** Display label for a model id, preferring the catalog label and falling back to a guess. */
export function describeModelLabel(models: ModelInfo[], id?: string): string {
  if (!id) return "Select Model";
  const found = models.find((model) => model.id === id);
  return found?.name || prettyModelName(id);
}

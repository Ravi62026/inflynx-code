import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId, ReasoningEffort } from "./model-catalog.js";

export interface DiscoveredModel {
  providerId: ProviderId;
  id: string;
  label: string;
  supportsTools: true;
  supportsThinking: boolean;
  supportedEfforts: ReasoningEffort[];
  unverified: true;
  discoveredAt: number;
}

interface DiscoveryCache {
  version: 1;
  models: DiscoveredModel[];
}

function cachePath(): string {
  return path.join(process.env.INFLYNX_CONFIG_HOME || os.homedir(), ".inflynx", "discovered-models.json");
}

function readCache(): DiscoveryCache {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as DiscoveryCache;
    if (cache.version === 1 && Array.isArray(cache.models)) return cache;
  } catch {
    // A missing cache is normal; malformed discovery data should not impair
    // use of the curated catalog.
  }
  return { version: 1, models: [] };
}

function writeCache(cache: DiscoveryCache): void {
  const directory = path.dirname(cachePath());
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${cachePath()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, cachePath());
}

export function listDiscoveredModels(providerId?: ProviderId): DiscoveredModel[] {
  return readCache().models
    .filter((model) => !providerId || model.providerId === providerId)
    .sort((left, right) => right.discoveredAt - left.discoveredAt || left.id.localeCompare(right.id));
}

/**
 * Refreshes a provider's documented model endpoint. It only records entries
 * that explicitly advertise tool support, marks them unverified, and never
 * mutates MODEL_CATALOG. Callers may offer these as an advanced BYOK choice
 * after user review; they are never default routing targets.
 */
export async function refreshModelCatalog(
  providerId: ProviderId,
  apiKey?: string,
  fetcher: typeof fetch = fetch
): Promise<DiscoveredModel[]> {
  const endpoint = discoveryEndpoint(providerId, apiKey);
  if (!endpoint) {
    throw new Error(`${providerId} does not expose a supported official model-discovery endpoint.`);
  }

  const headers: Record<string, string> = {};
  if (apiKey && providerId !== "google") headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetcher(endpoint, { headers, redirect: "error" });
  if (!response.ok) {
    throw new Error(`${providerId} model catalog request failed with HTTP ${response.status}.`);
  }
  const payload = await response.json() as any;
  const rawModels: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const now = Date.now();
  const discovered = rawModels
    .filter((model) => advertisesToolSupport(model))
    .map((model) => ({
      providerId,
      id: String(model.id || model.name || model.model),
      label: String(model.name || model.id || model.model),
      supportsTools: true as const,
      supportsThinking: advertisesThinkingSupport(model),
      supportedEfforts: [] as ReasoningEffort[],
      unverified: true as const,
      discoveredAt: now,
    }))
    .filter((model) => Boolean(model.id));

  const cache = readCache();
  cache.models = [
    ...cache.models.filter((model) => model.providerId !== providerId),
    ...discovered,
  ];
  writeCache(cache);
  return discovered;
}

function discoveryEndpoint(providerId: ProviderId, apiKey?: string): string | undefined {
  switch (providerId) {
    case "openrouter":
      return "https://openrouter.ai/api/v1/models";
    case "openai":
      return "https://api.openai.com/v1/models";
    case "google":
      return apiKey
        ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        : undefined;
    case "deepseek":
      return "https://api.deepseek.com/models";
    // Anthropic has no public Models-list API suitable for capability
    // discovery; keeping it manual is safer than scraping docs.
    case "anthropic":
      return undefined;
  }
}

function advertisesToolSupport(model: any): boolean {
  const parameters = model.supported_parameters || model.supportedParameters || model.capabilities;
  if (Array.isArray(parameters)) {
    return parameters.some((parameter) => ["tools", "tool_use", "function_calling", "functionCalling"].includes(String(parameter)));
  }
  return model.supports_tools === true || model.supportsTools === true || model.tool_use === true;
}

function advertisesThinkingSupport(model: any): boolean {
  const parameters = model.supported_parameters || model.supportedParameters || model.capabilities;
  return model.supports_reasoning === true ||
    model.supportsThinking === true ||
    (Array.isArray(parameters) && parameters.some((parameter) => String(parameter).includes("reasoning")));
}

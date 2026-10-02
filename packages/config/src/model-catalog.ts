/**
 * Curated model capability catalog.
 *
 * Entries are deliberately hand-curated rather than automatically promoted
 * from a provider's discovery API. Runtime discovery can add profiles marked
 * "unverified", but only this catalog is offered as an Inflynx default.
 */

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ProviderId = "openrouter" | "openai" | "anthropic" | "deepseek" | "google";
export type ModelAdapter = "openai-responses" | "anthropic-messages" | "gemini-generate-content" | "openai-chat";

export interface ModelCapability {
  id: string;
  label: string;
  adapter: ModelAdapter;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportedEfforts: readonly ReasoningEffort[];
  /**
   * Required. These two numbers are what every context-budget decision is made
   * against, so "we didn't write it down" is not an acceptable state — that is how
   * a 1M-window model and an unknown one ended up treated identically (backlog D1/D2).
   */
  contextWindow: number;
  maxOutputTokens: number;
  curated: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  envKey: string;
  defaultModel: string;
  models: string[];
  adapter: ModelAdapter;
  credentialRequired: boolean;
}

// Effort support is a property of the *model*, not of the routing provider — mapping it per
// provider family (and per model where the vendor differs) is what stops `google/gemini-*` routed
// through OpenRouter from falsely claiming OpenAI's `xhigh`/`max`. Values verified against vendor
// docs (Oct 2026): OpenAI reasoning models expose none/low/medium/high/xhigh/max (GPT-5.x); Google
// Gemini "thinking_level" is a discrete set per model (see the table below, e.g. gemini-3.8-flash =
// low/medium/high — there is no "none"); Anthropic extended thinking is on/off + a budget
// (none/low/medium/high); DeepSeek reasoning is coarse (none/low/medium/high).
const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORTS = ["none", "low", "medium", "high"] as const;
const DEEPSEEK_EFFORTS = ["none", "low", "medium", "high"] as const;
// Gemini's family superset (minimal only on some flash tiers); individual entries narrow it.
const GEMINI_EFFORTS = ["minimal", "low", "medium", "high"] as const;
const GEMINI_FLASH_3_8_EFFORTS = ["low", "medium", "high"] as const; // ai.google.dev/gemini-api/docs/thinking
const OPENROUTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_CATALOG: Record<ProviderId, ModelCapability[]> = {
  openrouter: [
    {
      id: "openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENAI_EFFORTS,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      curated: true,
    },
    {
      id: "anthropic/claude-sonnet-5",
      label: "Claude Sonnet 5",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: ANTHROPIC_EFFORTS,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      curated: true,
    },
    {
      id: "deepseek/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: DEEPSEEK_EFFORTS,
      contextWindow: 164_000,
      maxOutputTokens: 8_192,
      curated: true,
    },
    {
      id: "google/gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: GEMINI_EFFORTS,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      curated: true,
    },
    {
      id: "google/gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: GEMINI_FLASH_3_8_EFFORTS,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      curated: true,
    },
  ],
  openai: [
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      adapter: "openai-responses",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENAI_EFFORTS,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      curated: true,
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      adapter: "anthropic-messages",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: ANTHROPIC_EFFORTS,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      curated: true,
    },
  ],
  deepseek: [
    {
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: DEEPSEEK_EFFORTS,
      contextWindow: 164_000,
      maxOutputTokens: 8_192,
      curated: true,
    },
  ],
  google: [
    {
      id: "gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      adapter: "gemini-generate-content",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: GEMINI_EFFORTS,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      curated: true,
    },
    {
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      adapter: "gemini-generate-content",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: GEMINI_FLASH_3_8_EFFORTS,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      curated: true,
    },
  ],
};

export const TOP_PROVIDERS: ProviderInfo[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-5.6-luna",
    models: MODEL_CATALOG.openrouter.map((model) => model.id),
    adapter: "openai-chat",
    credentialRequired: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-luna",
    models: MODEL_CATALOG.openai.map((model) => model.id),
    adapter: "openai-responses",
    credentialRequired: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    models: MODEL_CATALOG.anthropic.map((model) => model.id),
    adapter: "anthropic-messages",
    credentialRequired: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    models: MODEL_CATALOG.deepseek.map((model) => model.id),
    adapter: "openai-chat",
    credentialRequired: true,
  },
  {
    id: "google",
    name: "Google Gemini",
    envKey: "GOOGLE_API_KEY",
    defaultModel: "gemini-3.6-flash",
    models: MODEL_CATALOG.google.map((model) => model.id),
    adapter: "gemini-generate-content",
    credentialRequired: true,
  },
];

export function getProvider(providerId: string): ProviderInfo | undefined {
  return TOP_PROVIDERS.find((provider) => provider.id === providerId);
}

export function getModelCapability(providerId: string, modelId: string): ModelCapability | undefined {
  return MODEL_CATALOG[providerId as ProviderId]?.find((model) => model.id === modelId);
}

/**
 * Conservative fallback used for anything not in the catalog (custom/BYOK endpoints).
 * Deliberately tiny: under-estimating the window only means the agent evicts and
 * compacts earlier than it had to; over-estimating is what corrupts sessions with a
 * provider 400. Unverified numbers here are the Claude Sonnet 5 and DeepSeek V4
 * windows plus the `maxOutputTokens` of every OpenRouter route — confirm them
 * against provider documentation before relying on long-context behaviour.
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 32_768;
export const CONSERVATIVE_MAX_OUTPUT_TOKENS = 8_192;

export function resolveModelCapability(providerId: string, modelId: string): ModelCapability {
  return getModelCapability(providerId, modelId) || {
    id: modelId,
    label: `Custom model: ${modelId}`,
    adapter: getProvider(providerId)?.adapter || "openai-chat",
    supportsTools: false,
    supportsThinking: false,
    supportedEfforts: ["none"],
    contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
    maxOutputTokens: CONSERVATIVE_MAX_OUTPUT_TOKENS,
    curated: false,
  };
}

/**
 * The limits to enforce for one (provider, model) pair, plus how they were obtained.
 *
 * Resolution order: an explicit BYOK declaration, then the curated catalog, then the
 * conservative fallback. It never guesses upward, because an over-large assumption is
 * what ends a session with a provider 400.
 */
export interface ContextLimits {
  contextWindow: number;
  maxOutputTokens: number;
  /** False when the conservative fallback stood in for a known figure. */
  curated: boolean;
}

export function resolveContextLimits(
  providerId: string,
  modelId: string,
  custom?: { contextWindow?: number; maxOutputTokens?: number }
): ContextLimits {
  if (custom?.contextWindow && custom.contextWindow > 0) {
    const window = custom.contextWindow;
    const output =
      custom.maxOutputTokens && custom.maxOutputTokens > 0
        ? Math.min(custom.maxOutputTokens, window)
        : Math.min(CONSERVATIVE_MAX_OUTPUT_TOKENS, window);
    return { contextWindow: window, maxOutputTokens: output, curated: true };
  }

  const capability = resolveModelCapability(providerId, modelId);
  const contextWindow = capability.contextWindow > 0 ? capability.contextWindow : CONSERVATIVE_CONTEXT_WINDOW;
  const maxOutputTokens =
    capability.maxOutputTokens > 0
      ? Math.min(capability.maxOutputTokens, contextWindow)
      : Math.min(CONSERVATIVE_MAX_OUTPUT_TOKENS, contextWindow);
  return { contextWindow, maxOutputTokens, curated: capability.curated };
}

/**
 * How hard the agent may work to stay inside the window it was just given.
 *
 * - `off`     never touches history. Debugging aid; a long session will overflow.
 * - `evict`   drops stale tool output only. Free, and lossless for anything the
 *             model already acted on. **Default.**
 * - `compact` also folds the oldest turns into a generated summary. Costs a model
 *             call and changes what the model remembers, so it stays opt-in until
 *             the Phase 45 evals measure whether it hurts task success.
 */
export const CONTEXT_STRATEGIES = ["off", "evict", "compact"] as const;
export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number];

export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = "evict";

/** Reads `INFLYNX_CONTEXT_STRATEGY`. An unrecognised value is reported, not ignored. */
export function resolveContextStrategy(env: NodeJS.ProcessEnv = process.env): ContextStrategy {
  const raw = (env.INFLYNX_CONTEXT_STRATEGY || "").trim().toLowerCase();
  if (!raw) return DEFAULT_CONTEXT_STRATEGY;
  if ((CONTEXT_STRATEGIES as readonly string[]).includes(raw)) return raw as ContextStrategy;
  console.warn(
    `[config] INFLYNX_CONTEXT_STRATEGY="${raw}" is not one of ${CONTEXT_STRATEGIES.join("|")}; ` +
    `using ${DEFAULT_CONTEXT_STRATEGY}.`
  );
  return DEFAULT_CONTEXT_STRATEGY;
}

export function supportsReasoningEffort(
  providerId: string,
  modelId: string,
  effort: ReasoningEffort
): boolean {
  return resolveModelCapability(providerId, modelId).supportedEfforts.includes(effort);
}

/**
 * Returns a provider-correct requested effort or an actionable error. We never
 * silently lower the user's requested effort.
 */
export function assertSupportedReasoningEffort(
  providerId: string,
  modelId: string,
  effort: ReasoningEffort
): ReasoningEffort {
  if (!supportsReasoningEffort(providerId, modelId, effort)) {
    const supported = resolveModelCapability(providerId, modelId).supportedEfforts.join(", ");
    throw new Error(
      `Model "${modelId}" on ${providerId} does not support effort "${effort}". ` +
      `Supported levels: ${supported || "none"}.`
    );
  }
  return effort;
}

/**
 * Startup-tolerant sibling of `assertSupportedReasoningEffort`: instead of throwing, it lowers an
 * unsupported effort to the highest level the model actually supports (by the REASONING_EFFORTS
 * order), reporting that it changed. This is NOT silent — the caller surfaces the warning — but a
 * bad `MODEL`/`INFLYNX_REASONING_EFFORT` combo must not brick `icode` at boot with a stack trace
 * the user cannot act on. Returns `changed` so the caller can print "effort 'high' → 'high'
 * unsupported, using 'medium'".
 */
export function clampReasoningEffort(
  providerId: string,
  modelId: string,
  effort: ReasoningEffort
): { effort: ReasoningEffort; changed: boolean; supported: readonly ReasoningEffort[] } {
  const supported = resolveModelCapability(providerId, modelId).supportedEfforts;
  if (supported.includes(effort)) return { effort, changed: false, supported };
  // Pick the closest supported level at-or-below the requested one, else the highest available.
  const rank = (e: ReasoningEffort) => REASONING_EFFORTS.indexOf(e);
  const desired = rank(effort);
  const atOrBelow = supported.filter((e) => rank(e) <= desired).sort((a, b) => rank(b) - rank(a));
  const highestFirst = [...supported].sort((a, b) => rank(b) - rank(a));
  const picked = atOrBelow[0] ?? highestFirst[0] ?? "none";
  return { effort: picked as ReasoningEffort, changed: true, supported };
}

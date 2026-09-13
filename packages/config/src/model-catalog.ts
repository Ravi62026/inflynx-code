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
  contextWindow?: number;
  maxOutputTokens?: number;
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

const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const DEEPSEEK_EFFORTS = ["none", "low", "high", "max"] as const;
const GEMINI_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
const OPENROUTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_CATALOG: Record<ProviderId, ModelCapability[]> = {
  openrouter: [
    {
      id: "openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENROUTER_EFFORTS,
      contextWindow: 1_050_000,
      curated: true,
    },
    {
      id: "anthropic/claude-sonnet-5",
      label: "Claude Sonnet 5",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENROUTER_EFFORTS,
      curated: true,
    },
    {
      id: "deepseek/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENROUTER_EFFORTS,
      curated: true,
    },
    {
      id: "google/gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      adapter: "openai-chat",
      supportsTools: true,
      supportsThinking: true,
      supportedEfforts: OPENROUTER_EFFORTS,
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

export function resolveModelCapability(providerId: string, modelId: string): ModelCapability {
  return getModelCapability(providerId, modelId) || {
    id: modelId,
    label: `Custom model: ${modelId}`,
    adapter: getProvider(providerId)?.adapter || "openai-chat",
    supportsTools: false,
    supportsThinking: false,
    supportedEfforts: ["none"],
    curated: false,
  };
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

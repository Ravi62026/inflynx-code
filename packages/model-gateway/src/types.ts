import type { ModelAdapter, ProviderId, ReasoningEffort } from "@inflynx/config";

export type { ModelAdapter, ProviderId, ReasoningEffort };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  reasoningTokens?: number;
  /**
   * Prompt-cache metrics (backlog Phase 18). `cachedInputTokens` were read from cache
   * (billed far below the normal input rate); `cacheCreationInputTokens` were written to
   * cache this turn (billed slightly above it). Reporting them separately is the whole
   * point: without it a cached turn and an uncached one look identical in cost telemetry,
   * and you cannot tell whether the stable-prefix work is actually paying.
   */
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type ProviderMetadata = Record<string, unknown>;

/**
 * A provider-neutral image carried on a message (backlog Phase 27). The old flow serialised
 * an image into the text as a markdown data-URL and let the OpenAI adapter regex it back
 * out — so Anthropic and Gemini received an unreadable base64 blob and the whole thing broke
 * on any formatting change. Carrying it structurally lets each adapter build its native
 * image block. `dataBase64` is the raw base64 (no `data:` prefix); `mediaType` is e.g. `image/png`.
 */
export interface MessageImage {
  mediaType: string;
  dataBase64: string;
  /** Original filename, for the adapter's alt text / logging only. */
  name?: string;
}
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; thought: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "done";
      usage: TokenUsage;
      finishReason: FinishReason;
      actualModel?: string;
      providerMetadata?: ProviderMetadata;
    };

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Provider-neutral persisted conversation message. `provider_metadata` holds
 * opaque, JSON-safe continuation state (Anthropic thinking blocks, OpenAI
 * Responses output items, Gemini thought signatures, OpenRouter reasoning
 * details). It never contains credentials.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Multimodal image parts on a user message. Adapters render these as native image blocks
   * alongside `content`; they are never smuggled through `content` as a data-URL string.
   */
  images?: MessageImage[];
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallMessage[];
  provider_metadata?: ProviderMetadata;
  /**
   * Set when a `tool` message reports a failure or a policy denial. Adapters
   * must not infer this from the content prefix: gateway refusals such as
   * "Security Policy Violation …" do not start with "Error:", and were being
   * handed to the model as successful tool results (backlog G4).
   */
  is_error?: boolean;
}

export interface CustomModelCapabilities {
  supportsTools: boolean;
  supportedEfforts: readonly ReasoningEffort[];
  /**
   * BYOK endpoints must declare these, because a wrong guess in the unsafe
   * direction (too large) ends the session with a provider 400. When absent, the
   * conservative fallback in `@inflynx/config` applies.
   */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelRequest {
  provider: ProviderId | "custom-openai-compatible";
  model: string;
  messages: Message[];
  tools?: object[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Kept for compatibility with pre-Phase 4 callers. Native providers use
   * `reasoningEffort`; only legacy Anthropic manual-thinking models interpret
   * this numeric budget.
   */
  thinkingBudget?: number;
  reasoningEffort?: ReasoningEffort;
  apiKey?: string;
  baseURL?: string;
  adapter?: ModelAdapter | "openai-chat";
  allowUnauthenticated?: boolean;
  allowLocalEndpoint?: boolean;
  customCapabilities?: CustomModelCapabilities;
  /**
   * Some strict OpenAI-compatible servers reject `stream_options` (finding G10). Set true on
   * a BYOK profile that does, and the chat adapter omits it (losing only streamed usage).
   */
  strictStreamOptions?: boolean;
}

import type { ModelAdapter, ProviderId, ReasoningEffort } from "@inflynx/config";

export type { ModelAdapter, ProviderId, ReasoningEffort };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  reasoningTokens?: number;
}

export type ProviderMetadata = Record<string, unknown>;
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
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallMessage[];
  provider_metadata?: ProviderMetadata;
}

export interface CustomModelCapabilities {
  supportsTools: boolean;
  supportedEfforts: readonly ReasoningEffort[];
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
}

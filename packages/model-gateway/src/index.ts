/**
 * @inflynx/model-gateway
 * Provider-correct, normalized streaming model gateway.
 *
 * Each adapter converts its native request/response protocol into the common
 * ModelEvent stream consumed by AgentOrchestrator. Provider continuation
 * metadata is carried separately on Message.provider_metadata so tool loops
 * can replay opaque reasoning/signature state without exposing credentials.
 */

export {
  type CustomModelCapabilities,
  type FinishReason,
  type Message,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ProviderId,
  type ProviderMetadata,
  type ReasoningEffort,
  type TokenUsage,
  type ToolCallMessage,
} from "./types.js";
import type { ModelEvent, ModelRequest } from "./types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamGemini } from "./gemini.js";
import { streamOpenAiCompatible } from "./openai-chat.js";
import { streamOpenAiResponses } from "./openai-responses.js";

export { estimateTokenUsageCost, PROVIDER_PRICING_TABLE, type ModelPricing } from "./usage-tracker.js";
export { formatAnthropicMessages, formatAnthropicTools, streamAnthropic } from "./anthropic.js";
export { formatGeminiContents, streamGemini } from "./gemini.js";
export { formatOpenAiCompatibleMessages, streamOpenAiCompatible } from "./openai-chat.js";
export { formatOpenAiResponsesInput, streamOpenAiResponses } from "./openai-responses.js";

export async function* streamModel(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  switch (request.adapter) {
    case "openai-responses":
      yield* streamOpenAiResponses(request, signal);
      return;
    case "anthropic-messages":
      yield* streamAnthropic(request, signal);
      return;
    case "gemini-generate-content":
      yield* streamGemini(request, signal);
      return;
    case "openai-chat":
      yield* streamOpenAiCompatible(request, signal);
      return;
    default:
      break;
  }

  // Safe defaults for callers created before the capability catalog exists.
  if (request.provider === "openai") {
    yield* streamOpenAiResponses(request, signal);
  } else if (request.provider === "anthropic") {
    yield* streamAnthropic(request, signal);
  } else if (request.provider === "google") {
    yield* streamGemini(request, signal);
  } else {
    yield* streamOpenAiCompatible(request, signal);
  }
}

/** Backwards-compatible entry point; DeepSeek now uses the generic adapter. */
export const streamDeepSeek = streamModel;

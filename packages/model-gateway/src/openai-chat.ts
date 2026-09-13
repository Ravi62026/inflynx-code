import { redactSecrets, validateCustomModelEndpointForUse } from "@inflynx/config";
import type { Message, ModelEvent, ModelRequest } from "./types.js";
import {
  buildUsage,
  fallbackUsage,
  fetchWithRetry,
  networkError,
  normalizeFinishReason,
  parseSse,
  parseToolArguments,
  providerError,
} from "./utils.js";

function resolveChatBaseUrl(request: ModelRequest): string {
  if (request.baseURL) return request.baseURL.replace(/\/+$/, "");
  switch (request.provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "custom-openai-compatible":
      throw new Error("A custom OpenAI-compatible model requires a configured base URL.");
    default:
      throw new Error(`No Chat Completions endpoint exists for provider "${request.provider}".`);
  }
}

function defaultApiKey(provider: ModelRequest["provider"]): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY;
    case "openrouter":
      return process.env.OPENROUTER_API_KEY;
    default:
      return undefined;
  }
}

export function formatOpenAiCompatibleMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id || "tool",
      };
    }

    if (message.role === "assistant") {
      const formatted: Record<string, unknown> = {
        role: "assistant",
        content: message.content || null,
      };
      if (message.reasoning_content) formatted.reasoning_content = message.reasoning_content;
      if (message.tool_calls?.length) formatted.tool_calls = message.tool_calls;

      // OpenRouter returns opaque reasoning_details. They must be replayed
      // unchanged on continuation calls and are never logged separately.
      const reasoningDetails = message.provider_metadata?.openrouterReasoningDetails;
      if (reasoningDetails) formatted.reasoning_details = reasoningDetails;
      return formatted;
    }

    return { role: message.role, content: message.content };
  });
}

export async function* streamOpenAiCompatible(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  const provider = request.provider;
  const apiKey = request.apiKey || defaultApiKey(provider);
  if (!apiKey && !request.allowUnauthenticated) {
    throw new Error(`API key missing for provider: ${provider}`);
  }

  const baseURL = resolveChatBaseUrl(request);
  if (provider === "custom-openai-compatible") {
    await validateCustomModelEndpointForUse(baseURL, Boolean(request.allowLocalEndpoint));
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/inflynx-cloud/inflynx-code";
    headers["X-Title"] = "Inflynx Code Agent";
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages: formatOpenAiCompatibleMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    temperature: request.temperature ?? 0,
    max_tokens: request.maxTokens ?? 4096,
  };

  if (request.tools?.length) {
    if (request.customCapabilities && !request.customCapabilities.supportsTools) {
      throw new Error("Custom model profile does not declare tool-calling support.");
    }
    body.tools = request.tools;
    // DeepSeek documents tool_choice incompatibilities with V4 thinking mode.
    if (provider !== "deepseek") body.tool_choice = "auto";
  }

  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    if (request.customCapabilities && !request.customCapabilities.supportedEfforts.includes(request.reasoningEffort)) {
      throw new Error(`Custom model profile does not support reasoning effort "${request.reasoningEffort}".`);
    }
    if (provider === "deepseek") {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = request.reasoningEffort === "max" ? "max" : request.reasoningEffort === "low" ? "low" : "high";
    } else if (provider === "openrouter") {
      body.reasoning = { effort: request.reasoningEffort };
      body.provider = { require_parameters: true };
    } else if (provider === "custom-openai-compatible") {
      throw new Error("Custom model profile does not declare reasoning support.");
    }
  } else if (provider === "deepseek") {
    body.thinking = { type: "disabled" };
  } else if (provider === "openrouter" && request.reasoningEffort === "none") {
    body.reasoning = { enabled: false };
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      provider,
      `${baseURL}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(body) },
      signal
    );
  } catch (err: unknown) {
    throw networkError(provider, redactSecrets((err as Error).message));
  }
  if (!response.ok) throw providerError(provider, response.status, await response.text());

  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let toolCallsFlushed = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let outputTextLength = 0;
  let finishReason = "stop";
  let actualModel: string | undefined;
  let openrouterReasoningDetails: unknown[] = [];

  const flushTools = function* (): Generator<ModelEvent> {
    if (toolCallsFlushed) return;
    toolCallsFlushed = true;
    for (const toolCall of toolCalls.values()) {
      if (toolCall.id && toolCall.name) {
        yield {
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          args: parseToolArguments(toolCall.args),
        };
      }
    }
  };

  for await (const event of parseSse(response)) {
    if (event === "[DONE]") break;
    const parsed = event as any;
    actualModel = parsed.model || actualModel;
    if (parsed.usage) {
      promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
      completionTokens = parsed.usage.completion_tokens ?? completionTokens;
      reasoningTokens =
        parsed.usage.completion_tokens_details?.reasoning_tokens ??
        parsed.usage.reasoning_tokens ??
        reasoningTokens;
    }

    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      outputTextLength += delta.content.length;
      yield { type: "text_delta", text: delta.content };
    }
    if (delta?.reasoning_content) {
      yield { type: "thought_delta", thought: delta.reasoning_content };
    }
    if (delta?.reasoning_details) {
      openrouterReasoningDetails.push(
        ...(Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [delta.reasoning_details])
      );
    }

    for (const toolCall of delta?.tool_calls || []) {
      const index = toolCall.index ?? 0;
      const current = toolCalls.get(index) || { id: "", name: "", args: "" };
      if (toolCall.id) current.id = toolCall.id;
      if (toolCall.function?.name) current.name = toolCall.function.name;
      if (toolCall.function?.arguments) current.args += toolCall.function.arguments;
      toolCalls.set(index, current);
    }

    const rawFinishReason = parsed.choices?.[0]?.finish_reason;
    if (rawFinishReason) {
      finishReason = rawFinishReason;
      if (normalizeFinishReason(rawFinishReason) === "tool_calls") yield* flushTools();
    }
  }

  yield* flushTools();
  const usage = promptTokens || completionTokens
    ? buildUsage(request.model, promptTokens, completionTokens, reasoningTokens)
    : fallbackUsage(request.model, body, outputTextLength, reasoningTokens);
  yield {
    type: "done",
    usage,
    finishReason: normalizeFinishReason(finishReason),
    actualModel,
    providerMetadata: openrouterReasoningDetails.length ? { openrouterReasoningDetails } : undefined,
  };
}

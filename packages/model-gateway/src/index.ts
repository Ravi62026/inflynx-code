/**
 * @inflynx/model-gateway
 * Unified streaming model gateway interface & cost optimization router.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; thought: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "done"; usage: TokenUsage; finishReason: string };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ModelRequest {
  provider: "google" | "openai" | "anthropic" | "deepseek" | "openrouter" | "ollama";
  model: string;
  messages: Message[];
  tools?: object[];
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  apiKey?: string;
  baseURL?: string;
}

// ─── Anthropic Native Messages API ───────────────────────────────────────────

export async function* streamAnthropic(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const apiKey = request.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key missing");

  const systemMessage = request.messages.find((m) => m.role === "system")?.content || "You are Inflynx Agent.";
  const conversationMessages = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const body: Record<string, unknown> = {
    model: request.model || "claude-3-5-sonnet-20241022",
    system: systemMessage,
    messages: conversationMessages,
    max_tokens: request.maxTokens ?? 4096,
    stream: true,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ANTHROPIC API error (${response.status}): ${errorText}`);
  }

  if (!response.body) throw new Error("No response body from Anthropic");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentToolId = "";
  let currentToolName = "";
  let currentToolInput = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          currentToolId = parsed.content_block.id;
          currentToolName = parsed.content_block.name;
          currentToolInput = "";
        } else if (parsed.type === "content_block_delta") {
          if (parsed.delta?.type === "text_delta") {
            yield { type: "text_delta", text: parsed.delta.text };
          } else if (parsed.delta?.type === "input_json_delta") {
            currentToolInput += parsed.delta.partial_json;
          }
        } else if (parsed.type === "content_block_stop" && currentToolName) {
          try {
            const args = JSON.parse(currentToolInput || "{}");
            yield { type: "tool_call", id: currentToolId, name: currentToolName, args };
          } catch {
            yield { type: "tool_call", id: currentToolId, name: currentToolName, args: { raw: currentToolInput } };
          }
          currentToolName = "";
          currentToolInput = "";
        } else if (parsed.type === "message_stop") {
          yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
          return;
        }
      } catch { /* ignore partial chunk */ }
    }
  }

  yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
}

// ─── OpenAI-Compatible Streaming (DeepSeek, OpenRouter, OpenAI, Gemini) ──────

export async function* streamOpenAiCompatible(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const provider = request.provider;
  let baseURL = request.baseURL;
  let apiKey = request.apiKey;

  if (provider === "deepseek") {
    baseURL = baseURL || "https://api.deepseek.com";
    apiKey = apiKey || process.env.DEEPSEEK_API_KEY;
  } else if (provider === "google") {
    baseURL = baseURL || "https://generativelanguage.googleapis.com/v1beta/openai";
    apiKey = apiKey || process.env.GOOGLE_API_KEY;
  } else if (provider === "openrouter") {
    baseURL = baseURL || "https://openrouter.ai/api/v1";
    apiKey = apiKey || process.env.OPENROUTER_API_KEY;
  } else if (provider === "openai") {
    baseURL = baseURL || "https://api.openai.com/v1";
    apiKey = apiKey || process.env.OPENAI_API_KEY;
  }

  if (!apiKey) throw new Error(`API key missing for provider: ${provider}`);

  const url = `${(baseURL || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/inflynx-cloud/inflynx-code";
    headers["X-Title"] = "Inflynx Code Agent";
  }

  // Format messages for OpenAI: inject tool results and DeepSeek R1 reasoning_content
  const formattedMessages = request.messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.tool_call_id || "tool" };
    }
    if (m.role === "assistant") {
      const msgObj: Record<string, unknown> = {
        role: "assistant",
        content: m.content || null,
      };
      if (m.reasoning_content) {
        msgObj.reasoning_content = m.reasoning_content;
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        msgObj.tool_calls = m.tool_calls;
      }
      return msgObj;
    }
    return { role: m.role, content: m.content };
  });

  const body: Record<string, unknown> = {
    model: request.model,
    messages: formattedMessages,
    stream: true,
    temperature: request.temperature ?? 0,
    max_tokens: request.maxTokens ?? 4096,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${provider.toUpperCase()} API error (${response.status}): ${errorText}`);
  }

  if (!response.body) throw new Error(`No response body from ${provider}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Accumulate tool call delta
  const toolCallAccumulator: Record<number, { id: string; name: string; args: string }> = {};
  let toolCallsFlushed = false;

  function* flushAccumulatedTools(): Generator<ModelEvent> {
    if (toolCallsFlushed) return;
    toolCallsFlushed = true;
    for (const [, tc] of Object.entries(toolCallAccumulator)) {
      if (!tc.id && !tc.name) continue;
      try {
        yield { type: "tool_call", id: tc.id, name: tc.name, args: JSON.parse(tc.args || "{}") };
      } catch {
        yield { type: "tool_call", id: tc.id, name: tc.name, args: { raw: tc.args } };
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") {
        yield* flushAccumulatedTools();
        yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
        return;
      }

      if (trimmed.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            yield { type: "text_delta", text: delta.content };
          }
          if (delta?.reasoning_content) {
            yield { type: "thought_delta", thought: delta.reasoning_content };
          }

          // Accumulate tool call deltas (streaming JSON args)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulator[idx]) {
                toolCallAccumulator[idx] = { id: tc.id || "", name: tc.function?.name || "", args: "" };
              }
              if (tc.id) toolCallAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallAccumulator[idx].args += tc.function.arguments;
            }
          }

          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason === "tool_calls") {
            yield* flushAccumulatedTools();
          }
        } catch { /* ignore partial chunk */ }
      }
    }
  }

  yield* flushAccumulatedTools();
  yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
}

// ─── Unified Entry Point ──────────────────────────────────────────────────────

export async function* streamModel(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  if (request.provider === "anthropic") {
    yield* streamAnthropic(request, signal);
  } else {
    yield* streamOpenAiCompatible(request, signal);
  }
}

export const streamDeepSeek = streamModel;

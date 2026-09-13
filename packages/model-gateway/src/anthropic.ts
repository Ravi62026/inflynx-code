import { redactSecrets } from "@inflynx/config";
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

type AnthropicContentBlock = Record<string, unknown>;
type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

function textBlock(text: string): AnthropicContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

function assistantBlocks(message: Message): AnthropicContentBlock[] {
  const savedBlocks = message.provider_metadata?.anthropicContentBlocks;
  if (Array.isArray(savedBlocks)) return savedBlocks as AnthropicContentBlock[];

  const blocks = textBlock(message.content);
  for (const toolCall of message.tool_calls || []) {
    const name = toolCall.function?.name || (toolCall as any).name || "unknown_tool";
    const rawArgs =
      toolCall.function?.arguments ||
      (typeof (toolCall as any).args === "string"
        ? (toolCall as any).args
        : JSON.stringify((toolCall as any).args || {}));
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name,
      input: parseToolArguments(rawArgs),
    });
  }
  return blocks;
}

/**
 * Converts normalized Inflynx history to Anthropic's native Messages shape.
 * Adjacent tool-result messages are combined into one user message because
 * Anthropic requires `tool_result` blocks to immediately follow the
 * preceding assistant `tool_use` turn.
 */
export function formatAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const formatted: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      formatted.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id || "missing_tool_call_id",
        content: message.content,
        is_error: message.content.startsWith("Error:"),
      });
      continue;
    }

    flushToolResults();
    if (message.role === "assistant") {
      formatted.push({ role: "assistant", content: assistantBlocks(message) });
    } else {
      formatted.push({ role: "user", content: textBlock(message.content) });
    }
  }
  flushToolResults();
  return formatted;
}

export function formatAnthropicTools(tools: object[] | undefined): object[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool: any) => {
    const definition = tool.function || tool;
    return {
      name: definition.name,
      description: definition.description || "",
      input_schema: definition.parameters || { type: "object", properties: {} },
    };
  });
}

export async function* streamAnthropic(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  const apiKey = request.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key missing");

  const system = request.messages.find((message) => message.role === "system")?.content || "You are Inflynx Agent.";
  const body: Record<string, unknown> = {
    model: request.model,
    system,
    messages: formatAnthropicMessages(request.messages),
    max_tokens: request.maxTokens ?? 8_192,
    stream: true,
  };
  const tools = formatAnthropicTools(request.tools);
  if (tools) body.tools = tools;

  // Claude Sonnet 5 uses adaptive thinking, not the deprecated numeric
  // budget. The legacy field remains only for callers explicitly targeting
  // older Anthropic models.
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: request.reasoningEffort };
  } else if (request.reasoningEffort === "none") {
    body.thinking = { type: "disabled" };
  } else if (request.thinkingBudget) {
    const maxTokens = body.max_tokens as number;
    if (request.thinkingBudget < 1_024) {
      throw new Error("Anthropic thinkingBudget must be at least 1024.");
    }
    // Auto-adjust max_tokens when thinking budget is set, since Anthropic
    // requires budget_tokens < max_tokens (thinking tokens count toward the
    // turn limit). If the caller didn't set maxTokens, bump it to fit.
    if (request.thinkingBudget >= maxTokens) {
      body.max_tokens = request.thinkingBudget + 1024;
    }
    body.thinking = { type: "enabled", budget_tokens: request.thinkingBudget };
  }

  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (body.thinking && (body.thinking as any).type !== "disabled") {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    response = await fetchWithRetry(
      "anthropic",
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      signal
    );
  } catch (err: unknown) {
    throw networkError("anthropic", redactSecrets((err as Error).message));
  }
  if (!response.ok) throw providerError("anthropic", response.status, await response.text());

  const blocks = new Map<number, AnthropicContentBlock>();
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let outputTextLength = 0;
  let finishReason = "stop";
  let actualModel: string | undefined;

  for await (const event of parseSse(response)) {
    if (event === "[DONE]") break;
    const parsed = event as any;

    if (parsed.type === "message_start") {
      actualModel = parsed.message?.model || actualModel;
      promptTokens = parsed.message?.usage?.input_tokens ?? promptTokens;
      completionTokens = parsed.message?.usage?.output_tokens ?? completionTokens;
    }

    if (parsed.type === "content_block_start") {
      const index = parsed.index ?? 0;
      const block = { ...(parsed.content_block || {}) };
      blocks.set(index, block);
      if (block.type === "thinking" && block.thinking) {
        yield { type: "thought_delta", thought: String(block.thinking) };
      }
    }

    if (parsed.type === "content_block_delta") {
      const index = parsed.index ?? 0;
      const block = blocks.get(index) || {};
      const delta = parsed.delta || {};
      if (delta.type === "text_delta") {
        const text = String(delta.text || "");
        block.text = `${block.text || ""}${text}`;
        outputTextLength += text.length;
        yield { type: "text_delta", text };
      } else if (delta.type === "thinking_delta") {
        const thought = String(delta.thinking || "");
        block.thinking = `${block.thinking || ""}${thought}`;
        yield { type: "thought_delta", thought };
      } else if (delta.type === "input_json_delta") {
        block.input = `${typeof block.input === "string" ? block.input : ""}${delta.partial_json || ""}`;
      } else if (delta.type === "signature_delta") {
        block.signature = `${block.signature || ""}${delta.signature || ""}`;
      }
      blocks.set(index, block);
    }

    if (parsed.type === "content_block_stop") {
      const index = parsed.index ?? 0;
      const block = blocks.get(index);
      if (block?.type === "tool_use") {
        const rawInput = typeof block.input === "string" ? block.input : JSON.stringify(block.input || {});
        yield {
          type: "tool_call",
          id: String(block.id || `tool_${index}`),
          name: String(block.name || "unknown_tool"),
          args: parseToolArguments(rawInput),
        };
        block.input = parseToolArguments(rawInput);
        blocks.set(index, block);
      }
    }

    if (parsed.type === "message_delta") {
      const usage = parsed.usage || {};
      completionTokens = usage.output_tokens ?? completionTokens;
      reasoningTokens = usage.output_tokens_details?.thinking_tokens ?? reasoningTokens;
      finishReason = parsed.delta?.stop_reason || finishReason;
    }
    if (parsed.type === "message_stop") break;
  }

  const usage = promptTokens || completionTokens
    ? buildUsage(request.model, promptTokens, completionTokens, reasoningTokens)
    : fallbackUsage(request.model, body, outputTextLength, reasoningTokens);
  yield {
    type: "done",
    usage,
    finishReason: normalizeFinishReason(finishReason),
    actualModel,
    providerMetadata: { anthropicContentBlocks: [...blocks.values()] },
  };
}

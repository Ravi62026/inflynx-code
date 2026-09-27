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

/** Anthropic image block from the provider-neutral `MessageImage` (Phase 27). */
function imageBlocks(message: Message): AnthropicContentBlock[] {
  return (message.images ?? []).map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
  }));
}

function stripLegacyImageMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, "[Attached Screenshot]")
    .replace(/data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+/g, "[Attached Screenshot]");
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
        // Explicit flag wins. The prefix heuristic is only a fallback for history
        // persisted before `is_error` existed — without this, policy denials and
        // security-block results were reported to the model as successes.
        is_error: message.is_error ?? message.content.startsWith("Error:"),
      });
      continue;
    }

    flushToolResults();
    if (message.role === "assistant") {
      const blocks = assistantBlocks(message);
      // Anthropic rejects `content: []`. A history message can legitimately be empty
      // (an interrupted turn, a persisted stub), and used to be sent as an empty array —
      // which the API answers with a 400 that kills the session.
      formatted.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: " " }] });
    } else {
      // Text and images are separate blocks; an image is never a base64 string in the text.
      const blocks = [...textBlock(stripLegacyImageMarkdown(message.content)), ...imageBlocks(message)];
      formatted.push({ role: "user", content: blocks.length ? blocks : textBlock(message.content) });
    }
  }
  flushToolResults();
  return formatted;
}

export function formatAnthropicTools(tools: object[] | undefined, cacheLast = false): object[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool: any, i: number) => {
    const definition = tool.function || tool;
    return {
      name: definition.name,
      description: definition.description || "",
      input_schema: definition.parameters || { type: "object", properties: {} },
      // The cache breakpoint goes on the LAST cached block of the stable prefix, which is
      // the tool list here: everything before it (system + all tools) becomes one cached unit.
      ...(cacheLast && i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    };
  });
}

/**
 * Maps a qualitative reasoning effort to Anthropic's real extended-thinking budget. The
 * previous code sent `{ type: "adaptive" }` and an `output_config` field — neither of which
 * exists in the Anthropic Messages API (finding G5), so any reasoning request was a 400. The
 * real control is `{ type: "enabled", budget_tokens }` with `1024 <= budget < max_tokens`.
 */
const THINKING_BUDGET_BY_EFFORT: Record<string, number> = { low: 2_048, medium: 6_144, high: 16_384, max: 24_576 };

function applyThinking(body: Record<string, unknown>, request: ModelRequest): void {
  const effort = request.reasoningEffort;
  if (effort === "none") {
    body.thinking = { type: "disabled" };
    return;
  }
  const raw = request.thinkingBudget ?? (effort ? THINKING_BUDGET_BY_EFFORT[String(effort)] : undefined);
  if (effort && raw === undefined) {
    // An effort we do not have a table entry for still means "think"; use a safe default.
    body.thinking = { type: "enabled", budget_tokens: clampBudget(6_144, body) };
    return;
  }
  if (!raw) return; // no effort, no explicit budget → no thinking block at all
  if (request.thinkingBudget !== undefined && request.thinkingBudget < 1_024) {
    throw new Error("Anthropic thinkingBudget must be at least 1024.");
  }
  body.thinking = { type: "enabled", budget_tokens: clampBudget(raw, body) };
}

/** Keep `1024 <= budget < max_tokens`, raising `max_tokens` if the caller's ceiling is too low. */
function clampBudget(budget: number, body: Record<string, unknown>): number {
  const capped = Math.max(1_024, budget);
  const maxTokens = body.max_tokens as number;
  if (capped >= maxTokens) body.max_tokens = capped + 1_024;
  return capped;
}

/**
 * Builds the Anthropic request body. Extracted (and exported) because prompt caching depends
 * on the *stable prefix* — `system` + `tools` — being byte-identical turn after turn; keeping
 * it a pure function of the request is what lets that property be tested without a live call.
 */
export function buildAnthropicBody(request: ModelRequest): Record<string, unknown> {
  const system = request.messages.find((message) => message.role === "system")?.content || "You are Inflynx Agent.";
  const body: Record<string, unknown> = {
    model: request.model,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: formatAnthropicMessages(request.messages),
    max_tokens: request.maxTokens ?? 8_192,
    stream: true,
  };
  const tools = formatAnthropicTools(request.tools, true);
  if (tools) body.tools = tools;
  applyThinking(body, request);
  return body;
}

/** Honour a proxy/BYOK `baseURL`; default to the Anthropic endpoint. */
export function anthropicMessagesUrl(request: ModelRequest): string {
  const base = request.baseURL?.trim();
  if (!base) return "https://api.anthropic.com/v1/messages";
  const clean = base.replace(/\/+$/, "");
  if (/\/messages$/.test(clean)) return clean;
  return clean.endsWith("/v1") ? `${clean}/messages` : `${clean}/v1/messages`;
}

export async function* streamAnthropic(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  const apiKey = request.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key missing");

  const body = buildAnthropicBody(request);

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
      anthropicMessagesUrl(request),
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
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let outputTextLength = 0;
  let finishReason = "stop";
  let actualModel: string | undefined;

  for await (const event of parseSse(response)) {
    if (event === "[DONE]") break;
    const parsed = event as any;

    if (parsed.type === "message_start") {
      actualModel = parsed.message?.model || actualModel;
      const u = parsed.message?.usage || {};
      // Anthropic reports cache read / cache creation as tokens SEPARATE from input_tokens,
      // which is exactly the convention estimateTokenUsageCost expects.
      promptTokens = u.input_tokens ?? promptTokens;
      completionTokens = u.output_tokens ?? completionTokens;
      cachedInputTokens = u.cache_read_input_tokens ?? cachedInputTokens;
      cacheCreationInputTokens = u.cache_creation_input_tokens ?? cacheCreationInputTokens;
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
    ? buildUsage(request.model, promptTokens, completionTokens, reasoningTokens, { cachedInputTokens, cacheCreationInputTokens })
    : fallbackUsage(request.model, body, outputTextLength, reasoningTokens);
  yield {
    type: "done",
    usage,
    finishReason: normalizeFinishReason(finishReason),
    actualModel,
    providerMetadata: { anthropicContentBlocks: [...blocks.values()] },
  };
}

import type { Message, ModelEvent, ModelRequest } from "./types.js";
import {
  buildUsage,
  fallbackUsage,
  fetchWithRetry,
  normalizeFinishReason,
  parseSse,
  parseToolArguments,
  providerError,
} from "./utils.js";

function toResponseTools(tools: object[] | undefined): object[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool: any) => {
    const definition = tool.function || tool;
    return {
      type: "function",
      name: definition.name,
      description: definition.description || "",
      parameters: definition.parameters || { type: "object", properties: {} },
    };
  });
}

/**
 * Converts normalized history into Responses API input items. When an earlier
 * response supplies opaque reasoning items, they are replayed exactly before
 * tool outputs so reasoning-enabled GPT models can continue their tool loop.
 */
export function formatOpenAiResponsesInput(messages: Message[]): object[] {
  const input: object[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const savedItems = message.provider_metadata?.openaiResponseItems;
      if (Array.isArray(savedItems)) {
        input.push(...savedItems as object[]);
        continue;
      }
      if (message.tool_calls?.length) {
        for (const toolCall of message.tool_calls) {
          const name = toolCall.function?.name || (toolCall as any).name || "unknown_tool";
          const args =
            toolCall.function?.arguments ||
            (typeof (toolCall as any).args === "string"
              ? (toolCall as any).args
              : JSON.stringify((toolCall as any).args || {}));
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name,
            arguments: args,
          });
        }
        continue;
      }
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || "missing_tool_call_id",
        output: message.content,
      });
      continue;
    }
    input.push({
      role: message.role === "system" ? "developer" : "user",
      content: [{ type: "input_text", text: message.content }],
    });
  }
  return input;
}

export async function* streamOpenAiResponses(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  const apiKey = request.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key missing");

  const body: Record<string, unknown> = {
    model: request.model,
    input: formatOpenAiResponsesInput(request.messages),
    stream: true,
    max_output_tokens: request.maxTokens ?? 8_192,
  };
  const tools = toResponseTools(request.tools);
  if (tools) body.tools = tools;
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    body.reasoning = { effort: request.reasoningEffort };
  }

  const baseURL = (request.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetchWithRetry(
    "openai",
    `${baseURL}/responses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    signal
  );
  if (!response.ok) throw providerError("openai", response.status, await response.text());

  const outputItems = new Map<string, Record<string, unknown>>();
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let outputTextLength = 0;
  let finishReason = "stop";
  let actualModel: string | undefined;

  for await (const event of parseSse(response)) {
    if (event === "[DONE]") break;
    const parsed = event as any;
    const responseInfo = parsed.response;
    actualModel = responseInfo?.model || parsed.model || actualModel;
    if (responseInfo?.usage) {
      promptTokens = responseInfo.usage.input_tokens ?? promptTokens;
      completionTokens = responseInfo.usage.output_tokens ?? completionTokens;
      reasoningTokens = responseInfo.usage.output_tokens_details?.reasoning_tokens ?? reasoningTokens;
    }

    if (parsed.type === "response.output_text.delta") {
      const text = String(parsed.delta || "");
      outputTextLength += text.length;
      yield { type: "text_delta", text };
    }
    if (parsed.type === "response.reasoning_summary_text.delta") {
      yield { type: "thought_delta", thought: String(parsed.delta || "") };
    }
    if (parsed.type === "response.output_item.added" && parsed.item) {
      const item = parsed.item as Record<string, unknown>;
      const key = String(item.id || item.call_id || outputItems.size);
      outputItems.set(key, { ...item });
    }
    if (parsed.type === "response.function_call_arguments.delta") {
      const key = String(parsed.item_id || parsed.call_id || "");
      const item = outputItems.get(key) || {
        id: parsed.item_id,
        call_id: parsed.call_id,
        type: "function_call",
        name: parsed.name,
        arguments: "",
      };
      item.arguments = `${item.arguments || ""}${parsed.delta || ""}`;
      outputItems.set(key, item);
    }
    if (parsed.type === "response.output_item.done" && parsed.item) {
      const item = parsed.item as Record<string, unknown>;
      const key = String(item.id || item.call_id || outputItems.size);
      outputItems.set(key, { ...item });
      if (item.type === "function_call") {
        const callId = String(item.call_id || item.id || key);
        yield {
          type: "tool_call",
          id: callId,
          name: String(item.name || "unknown_tool"),
          args: parseToolArguments(String(item.arguments || "{}")),
        };
      }
    }
    if (parsed.type === "response.completed") {
      finishReason = responseInfo?.status === "incomplete" ? responseInfo?.incomplete_details?.reason || "length" : "stop";
    }
    if (parsed.type === "response.failed") {
      finishReason = "error";
    }
  }

  const usage = promptTokens || completionTokens
    ? buildUsage(request.model, promptTokens, completionTokens, reasoningTokens)
    : fallbackUsage(request.model, body, outputTextLength, reasoningTokens);
  yield {
    type: "done",
    usage,
    finishReason: normalizeFinishReason(finishReason),
    actualModel,
    providerMetadata: { openaiResponseItems: [...outputItems.values()] },
  };
}

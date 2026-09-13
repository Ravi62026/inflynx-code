import type { Message, ModelEvent, ModelRequest } from "./types.js";
import {
  buildUsage,
  fallbackUsage,
  fetchWithRetry,
  normalizeFinishReason,
  parseSse,
  providerError,
} from "./utils.js";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

function findToolName(messages: Message[], toolCallId: string | undefined): string {
  if (!toolCallId) return "unknown_tool";
  for (const message of [...messages].reverse()) {
    const match = message.tool_calls?.find((call) => call.id === toolCallId);
    if (match) return match.function.name;
    const savedParts = message.provider_metadata?.geminiParts;
    if (Array.isArray(savedParts)) {
      const savedCall = (savedParts as GeminiPart[])
        .map((part) => part.functionCall || part.function_call)
        .find((call: any) => call?.id === toolCallId);
      if (savedCall && typeof (savedCall as any).name === "string") {
        return (savedCall as any).name;
      }
    }
  }
  return "unknown_tool";
}

/**
 * Gemini requires thought signatures returned with function-call parts to be
 * preserved verbatim. Stored native parts are therefore preferred over
 * reconstructing a generic assistant message.
 */
export function formatGeminiContents(messages: Message[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const contents: GeminiContent[] = [];
  const systemMessages = messages.filter((message) => message.role === "system");

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: findToolName(messages, message.tool_call_id),
            response: { name: findToolName(messages, message.tool_call_id), content: message.content },
          },
        }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const savedParts = message.provider_metadata?.geminiParts;
      if (Array.isArray(savedParts)) {
        contents.push({ role: "model", parts: savedParts as GeminiPart[] });
      } else {
        const parts: GeminiPart[] = message.content ? [{ text: message.content }] : [];
        for (const call of message.tool_calls || []) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = { raw: call.function.arguments };
          }
          parts.push({ functionCall: { id: call.id, name: call.function.name, args } });
        }
        contents.push({ role: "model", parts });
      }
      continue;
    }

    contents.push({ role: "user", parts: [{ text: message.content }] });
  }

  return {
    systemInstruction: systemMessages.length
      ? { parts: systemMessages.map((message) => ({ text: message.content })) }
      : undefined,
    contents,
  };
}

function formatGeminiTools(tools: object[] | undefined): object[] | undefined {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map((tool: any) => {
      const definition = tool.function || tool;
      return {
        name: definition.name,
        description: definition.description || "",
        parametersJsonSchema: definition.parameters || { type: "object", properties: {} },
      };
    }),
  }];
}

export async function* streamGemini(
  request: ModelRequest,
  signal?: AbortSignal
): AsyncIterable<ModelEvent> {
  const apiKey = request.apiKey || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Google Gemini API key missing");

  const { systemInstruction, contents } = formatGeminiContents(request.messages);
  const body: Record<string, unknown> = {
    contents,
    systemInstruction,
    tools: formatGeminiTools(request.tools),
    generationConfig: {
      maxOutputTokens: request.maxTokens ?? 8_192,
      ...(request.reasoningEffort
        ? { thinkingConfig: { thinkingLevel: request.reasoningEffort } }
        : {}),
    },
  };

  const baseURL = (request.baseURL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const url = `${baseURL}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithRetry(
    "google",
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    signal
  );
  if (!response.ok) throw providerError("google", response.status, await response.text());

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let outputTextLength = 0;
  let finishReason = "stop";
  let actualModel: string | undefined;
  const finalParts: GeminiPart[] = [];
  const emittedCalls = new Set<string>();

  for await (const event of parseSse(response)) {
    if (event === "[DONE]") break;
    const parsed = event as any;
    actualModel = parsed.modelVersion || actualModel;
    const usage = parsed.usageMetadata || {};
    promptTokens = usage.promptTokenCount ?? promptTokens;
    completionTokens = usage.candidatesTokenCount ?? completionTokens;
    reasoningTokens = usage.thoughtsTokenCount ?? reasoningTokens;

    const candidate = parsed.candidates?.[0];
    if (!candidate) continue;
    finishReason = candidate.finishReason || finishReason;
    for (const part of candidate.content?.parts || []) {
      finalParts.push(part);
      if (part.text) {
        const text = String(part.text);
        outputTextLength += text.length;
        yield { type: "text_delta", text };
      }
      const functionCall = part.functionCall || part.function_call;
      if (functionCall?.name) {
        const callId = String(functionCall.id || `${functionCall.name}_${emittedCalls.size}`);
        if (!emittedCalls.has(callId)) {
          emittedCalls.add(callId);
          yield {
            type: "tool_call",
            id: callId,
            name: String(functionCall.name),
            args: (functionCall.args || {}) as Record<string, unknown>,
          };
        }
      }
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
    providerMetadata: { geminiParts: finalParts },
  };
}

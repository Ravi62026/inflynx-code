import { redactSecrets } from "@inflynx/config";
import { estimateTokenUsageCost } from "./usage-tracker.js";
import type { FinishReason, TokenUsage } from "./types.js";

export function buildUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reasoningTokens?: number
): TokenUsage {
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens: reasoningTokens && reasoningTokens > 0 ? reasoningTokens : undefined,
  };
  usage.estimatedCostUsd = estimateTokenUsageCost(model, usage);
  return usage;
}

export function fallbackUsage(
  model: string,
  requestPayload: unknown,
  outputTextLength: number,
  reasoningTokens?: number
): TokenUsage {
  return buildUsage(
    model,
    Math.ceil(JSON.stringify(requestPayload).length / 4),
    Math.ceil(outputTextLength / 4),
    reasoningTokens
  );
}

export function normalizeFinishReason(rawReason: unknown): FinishReason {
  const reason = String(rawReason || "").toLowerCase();
  if (reason === "tool_calls" || reason === "tool_use" || reason === "function_call" || reason === "function_calls") {
    return "tool_calls";
  }
  if (reason === "length" || reason === "max_tokens" || reason === "max_output_tokens") {
    return "length";
  }
  if (reason === "content_filter" || reason === "safety") {
    return "content_filter";
  }
  if (reason === "error") return "error";
  return "stop";
}

export function providerError(provider: string, status: number, rawBody: string): Error {
  return new Error(`${provider.toUpperCase()} API error (${status}): ${redactSecrets(rawBody)}`);
}

export function networkError(provider: string, rawMessage: string): Error {
  return new Error(
    `${provider.toUpperCase()} network connection failed: ${redactSecrets(rawMessage || "fetch failed")}. ` +
      "Please check your internet connection, endpoint configuration, or network proxy and try again."
  );
}

export async function fetchWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  maxAttempts = 4
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok || (response.status !== 429 && response.status < 500) || attempt === maxAttempts) {
        return response;
      }

      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(15_000, Math.max(50, Number.parseInt(retryAfter, 10) * 1000))
        : Math.min(2_000, attempt * 250);
      await sleep(waitMs, signal);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted || attempt === maxAttempts) break;
      await sleep(Math.min(2_000, attempt * 250), signal);
    }
  }

  throw networkError(provider, lastError?.message || "fetch failed");
}

export async function* parseSse(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new Error("No response body from provider.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        yield "[DONE]";
        continue;
      }
      try {
        yield JSON.parse(payload);
      } catch {
        // A malformed individual SSE event must not kill a valid stream.
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const payload = trailing.slice(5).trim();
    if (payload === "[DONE]") yield "[DONE]";
    else {
      try {
        yield JSON.parse(payload);
      } catch {
        // Ignore malformed trailing event.
      }
    }
  }
}

export function parseToolArguments(rawArgs: string): Record<string, unknown> {
  const trimmed = (rawArgs || "{}").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Model request aborted by user signal."));
      },
      { once: true }
    );
  });
}

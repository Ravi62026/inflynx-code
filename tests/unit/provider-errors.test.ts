/**
 * Backlog Phase 9 — provider error taxonomy.
 *
 * Every provider failure used to arrive as a plain `Error` with the status code
 * embedded in prose, so the layer above could only guess: `runTurn` regex-matched
 * the message for "too long" and put everything else — a bad API key, a 503, a
 * cancelled request — into one undifferentiated `turn.failed`. These tests pin the
 * classification down, including the parts that were previously mislabelled.
 */

import assert from "node:assert/strict";
import {
  classifyProviderError,
  InflynxProviderError,
  isProviderError,
  networkError,
  providerError,
  toProviderError,
} from "../../packages/model-gateway/src/errors.js";
import { streamOpenAiCompatible } from "../../packages/model-gateway/src/openai-chat.js";
import { streamAnthropic } from "../../packages/model-gateway/src/anthropic.js";
import { fetchWithRetry } from "../../packages/model-gateway/src/utils.js";

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    /* consume to the throw */
  }
}

async function runErrorTaxonomyTests(): Promise<void> {
  console.log("🧯 Running Phase 9 Provider Error Taxonomy Tests...\n");

  // ── Test 1: every kind is distinguishable, with the right response attached ──
  {
    const cases: Array<{ status: number; body: string; kind: string; retryable: boolean; label: string }> = [
      { status: 401, body: `{"error":{"code":"invalid_api_key"}}`, kind: "auth", retryable: false, label: "401 key" },
      { status: 403, body: "forbidden", kind: "auth", retryable: false, label: "403" },
      // No status at all: how a 200-with-error-body or a raw SDK throw arrives when
      // `toProviderError` has nothing but the message to go on.
      { status: 0, body: "Your API key is invalid", kind: "auth", retryable: false, label: "auth by wording" },
      { status: 429, body: "rate limit", kind: "rate_limit", retryable: true, label: "429" },
      { status: 413, body: "", kind: "context_overflow", retryable: false, label: "413 (no body)" },
      {
        status: 400,
        body: `{"error":{"code":"context_length_exceeded","message":"This model's maximum context length is 8192 tokens"}}`,
        kind: "context_overflow",
        retryable: false,
        label: "openai overflow",
      },
      {
        status: 400,
        body: "prompt is too long: 210000 tokens > 200000 maximum",
        kind: "context_overflow",
        retryable: false,
        label: "anthropic overflow",
      },
      {
        status: 400,
        body: `{"error":{"message":"Too many input tokens for this model's context window"}}`,
        kind: "context_overflow",
        retryable: false,
        label: "gemini overflow",
      },
      { status: 400, body: "unknown tool schema", kind: "invalid_request", retryable: false, label: "400" },
      { status: 404, body: "model not found", kind: "invalid_request", retryable: false, label: "404" },
      {
        status: 400,
        body: `{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}`,
        kind: "content_filter",
        retryable: false,
        label: "safety block",
      },
      { status: 500, body: "internal", kind: "server_error", retryable: true, label: "500" },
      { status: 503, body: "overloaded_error", kind: "server_error", retryable: true, label: "503" },
      { status: 418, body: "teapot", kind: "unknown", retryable: false, label: "unclassified" },
    ];

    // Overflow first: a 400 that *says* "too long" must not be filed as malformed.
    for (const expectation of cases) {
      const info = classifyProviderError("openai", expectation.status, expectation.body);
      assert.equal(
        info.kind,
        expectation.kind,
        `${expectation.label}: classified as "${info.kind}", expected "${expectation.kind}"`
      );
      assert.equal(info.retryable, expectation.retryable, `${expectation.label}: wrong retryable flag`);
      assert.ok(
        info.userMessage.length > 25 && /\.$/.test(info.userMessage.trim()),
        `${expectation.label}: userMessage is not a usable sentence: "${info.userMessage}"`
      );
    }
    console.log(`✓ Test 1 Passed: ${cases.length} failure shapes classify into the right kind and response.`);
  }

  // ── Test 2: a wrapped error never leaks the credential it was handed ─────────
  {
    const secret = "sk-or-v1-supersecret-token-value";
    const err = providerError("openrouter", 401, `upstream echoed: Authorization: Bearer ${secret}`);
    assert.ok(err instanceof InflynxProviderError);
    assert.equal(err.kind, "auth");
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(secret), "the raw API key reached the error message");
    assert.ok(!err.userMessage.includes(secret), "the raw API key reached the user-facing sentence");
    assert.ok(!String(err.providerBody).includes(secret), "the raw API key reached the retained body");
    assert.ok(isProviderError(err) && !isProviderError(new Error("nope")), "type guard is wrong");

    const wrapped = toProviderError("openrouter", new Error(`boom ${secret}`));
    assert.ok(!wrapped.userMessage.includes(secret), "toProviderError leaked the secret");
    // The converse contract: redaction must not cost the developer the diagnostic.
    // `userMessage` is for the UI; `detail`/`message` still carry the provider's own
    // wording, redacted — which is what makes a failure debuggable after the fact.
    assert.ok(err.detail.includes("[REDACTED"), "provider wording lost from the diagnostic");
    assert.ok(err.message.includes("Authorization:"), "the provider's own wording was dropped from `message`");
    console.log("✓ Test 2 Passed: redaction holds across message, sentence and retained body.");
  }

  // ── Test 3: cancellation and connectivity are not the same failure ──────────
  {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

    assert.equal(toProviderError("openai", abortError).kind, "aborted");
    assert.equal(toProviderError("openai", abortError).retryable, false);
    assert.equal(toProviderError("openai", new TypeError("fetch failed")).kind, "network");
    assert.equal(networkError("openai", "socket hang up").kind, "network");
    assert.equal(networkError("openai", "socket hang up").retryable, true);

    // An abort in flight used to be reported as "check your internet connection".
    const originalFetch = (globalThis as any).fetch;
    try {
      (globalThis as any).fetch = async (_url: string, init?: { signal?: AbortSignal }) => {
        await new Promise((resolve, reject) => {
          const signal = init?.signal!;
          if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
          setTimeout(resolve, 5_000);
        });
        return new Response("never reached");
      };
      await assert.rejects(
        fetchWithRetry("openai", "https://example.invalid/v1/chat/completions", {}, controller.signal),
        (err: unknown) =>
          isProviderError(err) && err.kind === "aborted" && err.userMessage === "The request was cancelled."
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
    console.log("✓ Test 3 Passed: abort is `aborted`, unreachable host is `network` — not one in the other.");
  }

  // ── Test 4: the adapters actually throw the typed error, on both protocols ──
  {
    const originalFetch = (globalThis as any).fetch;
    const responses: Array<{ status: number; body: string }> = [
      { status: 400, body: `{"error":{"code":"context_length_exceeded"}}` },
      { status: 429, body: `{"error":{"message":"rate limit exceeded"}}` },
    ];
    let index = 0;
    try {
      (globalThis as any).fetch = async () => {
        const next = responses[Math.min(index++, responses.length - 1)];
        return new Response(next.body, { status: next.status });
      };

      const request = {
        provider: "openai" as const,
        model: "gpt-4o",
        apiKey: "k",
        messages: [{ role: "user" as const, content: "hi" }],
      };

      await assert.rejects(
        drain(streamOpenAiCompatible({ ...request, adapter: "openai-chat" })),
        (err: unknown) => isProviderError(err) && err.kind === "context_overflow"
      );
      index = 1;
      await assert.rejects(
        drain(streamOpenAiCompatible({ ...request, adapter: "openai-chat" })),
        (err: unknown) => isProviderError(err) && err.kind === "rate_limit" && err.retryable
      );
      // Different wire protocol, same taxonomy — the point of centralizing it.
      index = 0;
      await assert.rejects(
        drain(streamAnthropic({ ...request, provider: "anthropic" as any, model: "claude-sonnet-5" })),
        (err: unknown) => isProviderError(err) && err.kind === "context_overflow"
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
    console.log("✓ Test 4 Passed: openai-chat and anthropic adapters both surface InflynxProviderError.");
  }

  // ── Test 5: an overflow is recognisable from a bare message (recovery intact) ─
  {
    // A BYOK gateway can answer 200-with-error, and an SDK can throw a bare Error.
    // If classification loses these, Phase 16's recovery silently stops working.
    const bare = toProviderError("custom-openai-compatible", new Error("400 context_length_exceeded: too many tokens"));
    assert.equal(bare.kind, "context_overflow", `bare overflow classified as ${bare.kind}`);
    assert.ok(bare.userMessage.toLowerCase().includes("context window"));
    console.log("✓ Test 5 Passed: a status-less overflow is still recognised as recoverable.");
  }

  console.log("\n🎉 All Phase 9 Provider Error Taxonomy Tests Passed 100%!");
}

runErrorTaxonomyTests().catch((err) => {
  console.error("Provider-error test failed:", err);
  process.exit(1);
});

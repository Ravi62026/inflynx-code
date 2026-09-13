import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCredentialProfile,
  MODEL_CATALOG,
  redactSecrets,
  resolveCredentialSecret,
  setCredentialBackendForTests,
  validateCustomModelEndpoint,
  validateCustomModelEndpointForUse,
} from "../../packages/config/src/index.js";
import {
  estimateTokenUsageCost,
  formatAnthropicMessages,
  formatGeminiContents,
  formatOpenAiCompatibleMessages,
  formatOpenAiResponsesInput,
  streamModel,
  type ModelEvent,
} from "../../packages/model-gateway/src/index.js";

const encoder = new TextEncoder();

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${event === "[DONE]" ? "[DONE]" : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function runModelGatewayTests() {
  console.log("Running Phase 4 model-gateway tests...");

  // Curated catalog must not offer the previous broken Ollama or Groq aliases.
  assert.equal(Object.hasOwn(MODEL_CATALOG, "ollama"), false);
  assert.equal(Object.hasOwn(MODEL_CATALOG, "groq"), false);
  assert.equal(MODEL_CATALOG.openrouter[0].id, "openai/gpt-5.6-luna");

  // OpenAI Responses continuation preserves opaque reasoning/output items.
  const responseInput = formatOpenAiResponsesInput([
    { role: "system", content: "system" },
    {
      role: "assistant",
      content: "",
      provider_metadata: {
        openaiResponseItems: [
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        ],
      },
    },
    { role: "tool", content: "file content", tool_call_id: "call_1" },
  ]);
  assert.deepEqual(responseInput[1], { type: "reasoning", id: "rs_1", summary: [] });
  assert.deepEqual(responseInput[3], {
    type: "function_call_output",
    call_id: "call_1",
    output: "file content",
  });

  let lastRequest: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    lastRequest = JSON.parse(String(init?.body));
    return sse([
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"path\":\"a.ts\"}" },
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "response.completed", response: { model: "gpt-5.6-luna-served", status: "completed", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } },
      "[DONE]",
    ]);
  }) as typeof fetch;
  const openAiEvents = await collect(streamModel({
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-test-secret-key-1234567890",
    reasoningEffort: "high",
    messages: [{ role: "user", content: "read a file" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }));
  assert.equal(lastRequest?.model, "gpt-5.6-luna");
  assert.deepEqual(lastRequest?.reasoning, { effort: "high" });
  assert.deepEqual(openAiEvents.find((event) => event.type === "tool_call"), {
    type: "tool_call",
    id: "call_1",
    name: "read_file",
    args: { path: "a.ts" },
  });
  const openAiDone = openAiEvents.find((event) => event.type === "done");
  assert.equal(openAiDone?.type, "done");
  assert.equal(openAiDone?.actualModel, "gpt-5.6-luna-served");

  // Anthropic native serialization uses tool_use + tool_result and preserves
  // full thinking blocks for the subsequent continuation.
  const anthropicMessages = formatAnthropicMessages([
    {
      role: "assistant",
      content: "",
      provider_metadata: {
        anthropicContentBlocks: [
          { type: "thinking", thinking: "private", signature: "sig_1" },
          { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    },
    { role: "tool", tool_call_id: "tool_1", content: "ok" },
  ]);
  assert.equal((anthropicMessages[0].content[0] as any).signature, "sig_1");
  assert.deepEqual(anthropicMessages[1], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool_1", content: "ok", is_error: false }],
  });

  globalThis.fetch = (async () => sse([
    { type: "message_start", message: { model: "claude-sonnet-5-served", usage: { input_tokens: 11, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_2" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_2", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"b.ts\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } } },
    { type: "message_stop" },
  ])) as typeof fetch;
  const anthropicEvents = await collect(streamModel({
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-secret-1234567890",
    reasoningEffort: "high",
    messages: [{ role: "user", content: "read" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }));
  assert.equal(anthropicEvents.find((event) => event.type === "done")?.type, "done");
  assert.equal((anthropicEvents.find((event) => event.type === "done") as any).providerMetadata.anthropicContentBlocks[0].signature, "sig_2");

  // Verify content_block_start with initial thinking yields thought_delta
  let lastAnthropicBody: any;
  let lastAnthropicHeaders: any;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    lastAnthropicBody = JSON.parse(String(init?.body));
    lastAnthropicHeaders = init?.headers;
    return sse([
      { type: "message_start", message: { model: "claude-sonnet-5-served", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "initial thought " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "continuation" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 5 } } },
      { type: "message_stop" },
    ]);
  }) as typeof fetch;
  const initialThinkingEvents = await collect(streamModel({
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-test",
    thinkingBudget: 8192, // equals default max_tokens (8192) - should auto-bump
    messages: [{ role: "user", content: "test" }],
  }));
  const thoughtDeltas = initialThinkingEvents.filter((e) => e.type === "thought_delta");
  assert.equal(thoughtDeltas.length, 2);
  assert.equal((thoughtDeltas[0] as any).thought, "initial thought ");
  assert.equal((thoughtDeltas[1] as any).thought, "continuation");
  assert.equal(lastAnthropicBody.max_tokens, 8192 + 1024); // verified auto-adjustment
  assert.equal(lastAnthropicHeaders["anthropic-beta"], "interleaved-thinking-2025-05-14"); // verified beta header

  // Gemini native content preserves thought signatures and function responses.
  const geminiContents = formatGeminiContents([
    {
      role: "assistant",
      content: "",
      provider_metadata: { geminiParts: [{ functionCall: { id: "g_1", name: "read_file", args: {} }, thoughtSignature: "g-sig" }] },
    },
    { role: "tool", tool_call_id: "g_1", content: "done" },
  ]);
  assert.equal((geminiContents.contents[0].parts[0] as any).thoughtSignature, "g-sig");
  assert.equal((geminiContents.contents[1].parts[0] as any).functionResponse.name, "read_file");

  globalThis.fetch = (async () => sse([
    {
      modelVersion: "gemini-3.6-flash-001",
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 1 },
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hi" }, { functionCall: { id: "g_2", name: "read_file", args: { path: "g.ts" } }, thoughtSignature: "sig-g" }] } }],
    },
  ])) as typeof fetch;
  const geminiEvents = await collect(streamModel({
    provider: "google",
    model: "gemini-3.6-flash",
    apiKey: "AIzaSyabcdefghijklmnopqrstuvwx123456789",
    reasoningEffort: "medium",
    messages: [{ role: "user", content: "read" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }));
  assert.equal(geminiEvents.some((event) => event.type === "tool_call"), true);
  assert.equal((geminiEvents.find((event) => event.type === "done") as any).providerMetadata.geminiParts[1].thoughtSignature, "sig-g");

  // DeepSeek retains reasoning_content, does not force tool_choice, and maps
  // its documented thinking controls. OpenRouter replays reasoning_details.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    lastRequest = JSON.parse(String(init?.body));
    return sse([
      { choices: [{ delta: { reasoning_content: "why", tool_calls: [{ index: 0, id: "d_1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      { usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } },
      "[DONE]",
    ]);
  }) as typeof fetch;
  await collect(streamModel({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiKey: "deepseek-secret-1234567890",
    reasoningEffort: "high",
    messages: [{ role: "assistant", content: "", reasoning_content: "previous reasoning" }, { role: "user", content: "next" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }));
  assert.equal((lastRequest?.messages as any)[0].reasoning_content, "previous reasoning");
  assert.equal(lastRequest?.tool_choice, undefined);
  assert.deepEqual(lastRequest?.thinking, { type: "enabled" });

  globalThis.fetch = (async () => sse([
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", text: "r" }], content: "answer" }, finish_reason: "stop" }] },
    "[DONE]",
  ])) as typeof fetch;
  const routerEvents = await collect(streamModel({
    provider: "openrouter",
    model: "openai/gpt-5.6-luna",
    apiKey: "sk-or-v1-routersecret123456789",
    reasoningEffort: "high",
    messages: [{ role: "user", content: "answer" }],
  }));
  const routerDone = routerEvents.find((event) => event.type === "done") as any;
  const routerContinuation = formatOpenAiCompatibleMessages([{
    role: "assistant",
    content: "answer",
    provider_metadata: routerDone.providerMetadata,
  }]);
  assert.deepEqual((routerContinuation[0] as any).reasoning_details, [{ type: "reasoning.summary", text: "r" }]);

  // Endpoint policy and gateway error paths must never expose credentials.
  assert.throws(() => validateCustomModelEndpoint("http://localhost:11434/v1", false), /explicit/i);
  assert.throws(() => validateCustomModelEndpoint("https://user:secret@example.com/v1", false), /embedded/i);
  assert.doesNotThrow(() => validateCustomModelEndpoint("http://127.0.0.1:8080/v1", true));
  await assert.rejects(validateCustomModelEndpointForUse("https://169.254.169.254/v1", true), /metadata/i);
  globalThis.fetch = (async () => new Response("bad api_key=sk-secret-key-1234567890", { status: 401 })) as typeof fetch;
  await assert.rejects(
    collect(streamModel({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      apiKey: "sk-secret-key-1234567890",
      messages: [{ role: "user", content: "hello" }],
    })),
    (error: Error) => !error.message.includes("sk-secret-key-1234567890") && error.message.includes("[REDACTED")
  );
  assert.equal(redactSecrets("Bearer sk-secret-key-1234567890"), "Bearer [REDACTED]");

  // Profiles persist no key material; tests substitute an in-memory keychain.
  const secrets = new Map<string, string>();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-profile-"));
  process.env.INFLYNX_CONFIG_HOME = testHome;
  setCredentialBackendForTests({
    set: (id, secret) => secrets.set(id, secret),
    get: (id) => secrets.get(id) || null,
    delete: (id) => { secrets.delete(id); },
  });
  const profile = createCredentialProfile({
    label: "test router",
    providerId: "openrouter",
    defaultModel: "openai/gpt-5.6-luna",
    apiKey: "sk-profile-secret-1234567890",
  });
  assert.equal(resolveCredentialSecret(profile), "sk-profile-secret-1234567890");
  const registry = fs.readFileSync(path.join(testHome, ".inflynx", "credentials.json"), "utf8");
  assert.equal(registry.includes("sk-profile-secret-1234567890"), false);
  setCredentialBackendForTests();
  delete process.env.INFLYNX_CONFIG_HOME;
  fs.rmSync(testHome, { recursive: true, force: true });

  // Retain existing cost-estimation coverage.
  assert.ok(estimateTokenUsageCost("unknown-custom-model", { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 }) > 0);

  // --- Phase 5 Hardening: Stream Cancellation via AbortSignal ---
  const abortController = new AbortController();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    // If signal aborted before fetch, fail immediately as standard fetch does
    if (init?.signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return sse([
      { type: "response.output_item.added", item: { id: "fc_cancel", type: "function_call", call_id: "call_cancel", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_cancel", delta: "{\"path\":\"cancel.ts\"}" },
      "[DONE]",
    ]);
  }) as typeof fetch;

  const streamWithAbort = streamModel({
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-test-secret-key-1234567890",
    messages: [{ role: "user", content: "read file" }],
  }, abortController.signal);

  // Consume first chunk, then abort
  let receivedFirstChunk = false;
  try {
    for await (const _event of streamWithAbort) {
      receivedFirstChunk = true;
      abortController.abort();
    }
  } catch (err: any) {
    assert.ok(err.name === "AbortError" || err.message.includes("abort"));
  }
  assert.equal(receivedFirstChunk, true);
  assert.equal(abortController.signal.aborted, true);

  // --- Phase 5 Hardening: 429 Rate-Limit Retry & Backoff ---
  let attemptsMade = 0;
  globalThis.fetch = (async () => {
    attemptsMade++;
    if (attemptsMade === 1) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    return sse([
      { choices: [{ delta: { content: "recovered after rate limit" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  }) as typeof fetch;

  const retryEvents = await collect(streamModel({
    provider: "openrouter",
    model: "openai/gpt-5.6-luna",
    apiKey: "sk-test-secret-key-1234567890",
    messages: [{ role: "user", content: "test 429 retry" }],
  }));
  assert.equal(attemptsMade, 2);
  const textEvents = retryEvents.filter((e) => e.type === "text_delta");
  assert.equal(textEvents.length, 1);
  assert.equal((textEvents[0] as any).text, "recovered after rate limit");

  // --- Phase 5 Hardening: Anthropic Multi-Turn tool_result Formatting ---
  const anthropicFormatted = formatAnthropicMessages([
    { role: "system", content: "You are a test agent" },
    { role: "user", content: "run a tool" },
    {
      role: "assistant",
      content: "Running tool",
      tool_calls: [{ id: "tool_use_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"test.txt\"}" } }],
    },
    { role: "tool", content: "file content here", tool_call_id: "tool_use_1" },
  ]);
  // Anthropic messages array must exclude system role (system is sent top-level)
  assert.equal(anthropicFormatted.some((m) => m.role === "system"), false);
  // Tool response must be formatted as tool_result content block in user role
  const lastAnthropicMsg = anthropicFormatted[anthropicFormatted.length - 1];
  assert.equal(lastAnthropicMsg.role, "user");
  assert.ok(Array.isArray(lastAnthropicMsg.content));
  const toolResultBlock = (lastAnthropicMsg.content as any[])[0];
  assert.equal(toolResultBlock.type, "tool_result");
  assert.equal(toolResultBlock.tool_use_id, "tool_use_1");
  assert.equal(toolResultBlock.content, "file content here");

  globalThis.fetch = originalFetch;
  console.log("Phase 4 & Phase 5 model-gateway tests passed.");
}

runModelGatewayTests().catch((error) => {
  globalThis.fetch = globalThis.fetch;
  console.error(error);
  process.exit(1);
});

/**
 * Backlog Phase 18 — prompt caching & stable-prefix ordering.
 *
 * Caching is two things: the *stable prefix* (system + tools byte-identical turn to turn) and
 * the cache *metrics* (knowing a turn hit the cache and pricing it right). Both are tested here
 * without a live API — the prefix by asserting `buildAnthropicBody`'s head does not change while
 * the user turn does, and the metrics by feeding a recorded Anthropic/OpenAI SSE that carries
 * cache fields and asserting the parsed `TokenUsage` and the cost model reflect them.
 */

import assert from "node:assert/strict";
import { buildAnthropicBody, streamAnthropic } from "../../packages/model-gateway/src/anthropic.js";
import { buildUsage } from "../../packages/model-gateway/src/utils.js";
import { estimateTokenUsageCost } from "../../packages/model-gateway/src/usage-tracker.js";
import { streamOpenAiCompatible } from "../../packages/model-gateway/src/openai-chat.js";
import type { Message, ModelRequest, TokenUsage } from "../../packages/model-gateway/src/types.js";

function req(messages: Message[], tools: ModelRequest["tools"]): ModelRequest {
  return {
    providerId: "anthropic", model: "claude-sonnet-4-5", adapter: "anthropic-messages",
    apiKey: "k", messages, tools, maxTokens: 1024,
  } as unknown as ModelRequest;
}

function sse(lines: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collectUsage(gen: AsyncIterable<{ type: string; usage?: TokenUsage }>): Promise<TokenUsage> {
  let usage: TokenUsage | undefined;
  for await (const ev of gen) if (ev.type === "done") usage = ev.usage;
  assert.ok(usage, "no usage emitted");
  return usage;
}

async function runPhase18Tests(): Promise<void> {
  console.log("🧪 Running Phase 18 Prompt-Caching & Stable-Prefix Tests...\n");

  // ── Test 1: cache breakpoints on the stable head ─────────────────────────
  {
    const body = buildAnthropicBody(req(
      [{ role: "system", content: "You are Inflynx." }, { role: "user", content: "hi" }],
      [{ name: "read_file", parameters: { type: "object", properties: {} } }, { name: "write_file", parameters: { type: "object", properties: {} } }] as never,
    ));
    const system = body.system as Array<Record<string, any>>;
    assert.equal(system[0].cache_control?.type, "ephemeral", "system block has no cache breakpoint");
    const tools = body.tools as Array<Record<string, any>>;
    assert.equal(tools.length, 2);
    assert.ok(!tools[0].cache_control, "the FIRST tool should not carry the breakpoint");
    assert.equal(tools[1].cache_control?.type, "ephemeral", "the LAST tool must carry the breakpoint");
    // No tools → no `tools` key, and the system breakpoint is still there.
    const notools = buildAnthropicBody(req([{ role: "user", content: "x" }], undefined));
    assert.equal((notools.system as Array<Record<string, any>>)[0].cache_control?.type, "ephemeral");
    console.log("✓ Test 1 Passed: cache_control on system + last tool only (the cached head).");
  }

  // ── Test 2: the stable prefix really is stable across turns ─────────────
  {
    const tools = [{ name: "a", parameters: { type: "object", properties: {} } }, { name: "b", parameters: { type: "object", properties: {} } }] as never;
    const head = (msgs: Message[]) => {
      const b = buildAnthropicBody(req(msgs, tools));
      return JSON.stringify({ system: b.system, tools: b.tools });
    };
    const turnA = head([{ role: "system", content: "SYS" }, { role: "user", content: "first ask" }]);
    const turnB = head([
      { role: "system", content: "SYS" },
      { role: "user", content: "first ask" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second ask — very different" },
    ]);
    assert.equal(turnA, turnB, "the system+tools prefix changed between turns — caching is impossible");
    // …while the messages portion legitimately differs.
    const msgA = JSON.stringify(buildAnthropicBody(req([{ role: "system", content: "SYS" }, { role: "user", content: "first ask" }], tools)).messages);
    assert.notEqual(msgA, JSON.stringify(buildAnthropicBody(req([
      { role: "system", content: "SYS" }, { role: "user", content: "first ask" }, { role: "user", content: "second ask" }], tools)).messages));
    console.log("✓ Test 2 Passed: system+tools bytes identical across turns; only the transcript grows.");
  }

  // ── Test 3: cost model reflects cache reads/writes ───────────────────────
  {
    const fresh = estimateTokenUsageCost("claude-sonnet-4-5", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 } as TokenUsage);
    // Same 1000 input tokens, but 800 served from cache → strictly cheaper.
    const cached = estimateTokenUsageCost("claude-sonnet-4-5", { promptTokens: 200, completionTokens: 0, totalTokens: 200, cachedInputTokens: 800 } as TokenUsage);
    assert.ok(cached < fresh, `cache reads were not discounted: ${cached} >= ${fresh}`);
    // Writing to cache costs a premium over the same fresh tokens.
    const withWrite = estimateTokenUsageCost("claude-sonnet-4-5", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cacheCreationInputTokens: 500 } as TokenUsage);
    assert.ok(withWrite > fresh, `cache writes were not premium-priced: ${withWrite} <= ${fresh}`);
    assert.ok(fresh > 0, "pricing table returned zero — the comparisons above proved nothing");
    console.log("✓ Test 3 Passed: cached reads discounted, cache writes premium, all non-zero.");
  }

  // ── Test 4: buildUsage carries the metrics through ──────────────────────
  {
    const u = buildUsage("claude-sonnet-4-5", 300, 40, undefined, { cachedInputTokens: 1200, cacheCreationInputTokens: 300 });
    assert.equal(u.cachedInputTokens, 1200);
    assert.equal(u.cacheCreationInputTokens, 300);
    assert.equal(u.totalTokens, 340, "totalTokens should stay prompt+completion");
    // Absent cache → the fields are undefined, not 0, so telemetry stays clean.
    const bare = buildUsage("claude-sonnet-4-5", 10, 5);
    assert.equal(bare.cachedInputTokens, undefined);
    console.log("✓ Test 4 Passed: buildUsage surfaces cache metrics (and omits them when absent).");
  }

  // ── Test 5: Anthropic usage parsing (separate-token convention) ─────────
  {
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => sse([
      JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
      "[DONE]",
    ]);
    try {
      const usage = await collectUsage(streamAnthropic(req([{ role: "user", content: "x" }], undefined)));
      assert.equal(usage.promptTokens, 100, "input_tokens must stay the *uncached* count");
      assert.equal(usage.cachedInputTokens, 800);
      assert.equal(usage.cacheCreationInputTokens, 150);
      console.log("✓ Test 5 Passed: a recorded Anthropic turn parses cache read/creation into usage.");
    } finally { (globalThis as any).fetch = original; }
  }

  // ── Test 6: OpenAI usage parsing (subset-token convention, normalised) ──
  {
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => sse([
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } } }),
      "[DONE]",
    ]);
    try {
      const usage = await collectUsage(streamOpenAiCompatible({
        providerId: "openai", model: "gpt-4o", adapter: "openai-chat", apiKey: "k",
        messages: [{ role: "user", content: "x" }], baseURL: "http://93.184.216.34/v1",
      } as never));
      // OpenAI reports cached as a subset of prompt_tokens; the adapter normalises to
      // uncached prompt + separate cached, so both conventions cost the same way downstream.
      assert.equal(usage.cachedInputTokens, 600, "cached_tokens not parsed");
      assert.equal(usage.promptTokens, 400, "prompt_tokens should be reduced by the cached subset");
      console.log("✓ Test 6 Passed: OpenAI's subset-style cached_tokens normalised to the shared convention.");
    } finally { (globalThis as any).fetch = original; }
  }

  console.log("\n🎉 All Phase 18 Prompt-Caching & Stable-Prefix Tests Passed 100%!");
}

runPhase18Tests().catch((err) => {
  console.error("Phase 18 test failed:", err);
  process.exit(1);
});

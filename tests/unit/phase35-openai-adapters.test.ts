/**
 * Backlog Phase 35 — Responses + Chat adapter correctness, verified on recorded bodies.
 *
 * G6 (assistant prose dropped whenever the turn had tool calls), no `store:false`, no
 * encrypted-reasoning request, a `finish_reason` that was always "stop" even for a tool turn,
 * and `stream_options` sent unconditionally (strict servers 400 on it, G10). Each is asserted
 * from the exact JSON we would put on the wire — no live call.
 */

import assert from "node:assert/strict";
import {
  formatOpenAiResponsesInput,
  streamOpenAiResponses,
} from "../../packages/model-gateway/src/openai-responses.js";
import { streamOpenAiCompatible } from "../../packages/model-gateway/src/openai-chat.js";
import { stubFetch, sse } from "../helpers/agent-harness.js";
import type { Message, ModelRequest } from "../../packages/model-gateway/src/types.js";

function req(over: Partial<ModelRequest>): ModelRequest {
  return { provider: "openai", model: "gpt-5", adapter: "openai-responses", apiKey: "k", messages: [{ role: "user", content: "hi" }], ...over } as unknown as ModelRequest;
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) { void _; }
}

async function run() {
  console.log("🧪 Running Phase 35 Responses + Chat correctness tests...\n");

  // ── Test 1: G6 — assistant prose survives alongside tool calls ───────────
  {
    const input = formatOpenAiResponsesInput([
      { role: "user", content: "read it" },
      { role: "assistant", content: "I'll open the file now.", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } as unknown as Message,
    ] as Message[]);
    const json = JSON.stringify(input);
    assert.ok(json.includes("I'll open the file now."), "assistant prose was dropped from the tool turn");
    assert.ok(json.includes("function_call"), "the tool call itself disappeared");
    console.log("✓ Test 1 Passed: assistant text AND its tool call are both in `input`.");
  }

  // ── Test 2: store:false + encrypted reasoning on the wire ────────────────
  {
    const f = stubFetch(() => sse([JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1 } } }), "[DONE]"]));
    try {
      await drain(streamOpenAiResponses(req({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "high" })));
    } finally { f.restore(); }
    const sent = f.requests()[0];
    assert.equal(sent.store, false, "store:false not sent");
    assert.deepEqual(sent.include, ["reasoning.encrypted_content"], "encrypted reasoning not requested");
    console.log("✓ Test 2 Passed: store:false and reasoning.encrypted_content are requested.");
  }

  // ── Test 3: a tool turn reports finish_reason tool_calls, not stop ───────
  {
    const f = stubFetch(() => sse([
      JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" } }),
      JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } }),
      "[DONE]",
    ]));
    try {
      let done: { finishReason?: string } | undefined;
      let sawTool = false;
      for await (const ev of streamOpenAiResponses(req({}))) {
        if (ev.type === "tool_call") sawTool = true;
        if (ev.type === "done") done = ev as { finishReason?: string };
      }
      assert.ok(sawTool, "no tool_call surfaced");
      assert.equal(done?.finishReason, "tool_calls", "finishReason should be tool_calls for a tool turn");
    } finally { f.restore(); }
    console.log("✓ Test 3 Passed: a Responses tool turn ends with finishReason 'tool_calls'.");
  }

  // ── Test 4: stream_options is opt-out for strict servers (G10) ───────────
  {
    const ok = stubFetch(() => sse([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }), "[DONE]"]));
    try { await drain(streamOpenAiCompatible(req({ provider: "openai", adapter: "openai-chat" }))); } finally { ok.restore(); }
    assert.deepEqual(ok.requests()[0].stream_options, { include_usage: true }, "default chat request should ask for usage");

    const strict = stubFetch(() => sse([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }), "[DONE]"]));
    try { await drain(streamOpenAiCompatible(req({ provider: "openai", adapter: "openai-chat", strictStreamOptions: true }))); } finally { strict.restore(); }
    assert.ok(!("stream_options" in strict.requests()[0]), "a strict server was still sent stream_options");
    console.log("✓ Test 4 Passed: stream_options present by default, omitted for a strict endpoint.");
  }

  console.log("\n🎉 All Phase 35 Responses + Chat correctness tests passed.");
}
run().catch((e) => { console.error("Phase 35 failed:", e); process.exit(1); });

/**
 * Backlog Phase 34 — Anthropic adapter correctness, verified on the recorded request shape.
 *
 * The old body carried `{ thinking: { type: "adaptive" } }` and an `output_config` field,
 * neither of which the Anthropic Messages API accepts (finding G5) — every reasoning request
 * was a guaranteed 400. It could also emit `content: []` (rejected) and ignored `baseURL`
 * (no proxy support). Each is asserted from the exact body/URL we would send, no live call.
 */

import assert from "node:assert/strict";
import {
  buildAnthropicBody,
  formatAnthropicMessages,
  anthropicMessagesUrl,
} from "../../packages/model-gateway/src/anthropic.js";
import type { Message, ModelRequest } from "../../packages/model-gateway/src/types.js";

function request(over: Partial<ModelRequest>): ModelRequest {
  return {
    providerId: "anthropic", model: "claude-sonnet-4-5", adapter: "anthropic-messages",
    apiKey: "k", messages: [{ role: "user", content: "hi" }], ...over,
  } as unknown as ModelRequest;
}

async function run() {
  console.log("🧪 Running Phase 34 Anthropic adapter correctness tests...\n");

  // ── Test 1: reasoning effort → real thinking shape (no fabrication) ──────
  {
    for (const effort of ["low", "medium", "high"] as const) {
      const body = buildAnthropicBody(request({ reasoningEffort: effort }));
      const thinking = body.thinking as Record<string, unknown>;
      assert.equal(thinking.type, "enabled", `${effort} must use the real 'enabled' type`);
      assert.equal(typeof thinking.budget_tokens, "number", "budget_tokens missing");
      assert.ok((thinking.budget_tokens as number) >= 1_024, "budget below the 1024 API floor");
      assert.ok((thinking.budget_tokens as number) < (body.max_tokens as number), "budget must be < max_tokens");
      assert.ok(!("output_config" in body), "the fabricated output_config field is still sent");
    }
    const off = buildAnthropicBody(request({ reasoningEffort: "none" }));
    assert.deepEqual(off.thinking, { type: "disabled" }, "effort none must disable thinking");
    const plain = buildAnthropicBody(request({}));
    assert.ok(!("thinking" in plain), "no reasoning signal should add a thinking block");
    console.log("✓ Test 1 Passed: effort maps to {enabled,budget} / {disabled}; no 'adaptive', no output_config.");
  }

  // ── Test 2: an empty assistant turn never sends content: [] ──────────────
  {
    const out = formatAnthropicMessages([
      { role: "user", content: "x" },
      { role: "assistant", content: "" },              // empty, no tool calls
      { role: "user", content: "continue" },
    ] as Message[]);
    for (const m of out) {
      assert.ok(Array.isArray(m.content) && m.content.length > 0, `empty content array: ${JSON.stringify(m)}`);
      assert.ok(m.role === "user" || m.role === "assistant");
    }
    console.log("✓ Test 2 Passed: no assistant message is emitted with content: [].");
  }

  // ── Test 3: a gateway denial reaches the model as is_error:true ───────────
  {
    const out = formatAnthropicMessages([
      { role: "user", content: "delete .git" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "delete_path", arguments: "{}" } }] } as unknown as Message,
      { role: "tool", tool_call_id: "t1", content: "Error: policy refusal", is_error: true } as Message,
    ] as Message[]);
    const toolResult = out.flatMap((m) => m.content as Array<Record<string, unknown>>).find((b) => b.type === "tool_result");
    assert.ok(toolResult, "no tool_result block");
    assert.equal(toolResult!.is_error, true, "a gateway denial reached the model as a success");
    // And a non-error result is not flagged.
    const ok = formatAnthropicMessages([
      { role: "tool", tool_call_id: "t2", content: "file contents…", is_error: false } as Message,
    ] as Message[]);
    const tb = (ok[0].content as Array<Record<string, unknown>>)[0];
    assert.equal(tb.is_error, false, "a successful result was marked as an error");
    console.log("✓ Test 3 Passed: is_error reflects the real ToolResult, not a string heuristic.");
  }

  // ── Test 4: baseURL honoured (proxy / BYOK) ──────────────────────────────
  {
    assert.equal(anthropicMessagesUrl(request({})), "https://api.anthropic.com/v1/messages");
    assert.equal(anthropicMessagesUrl(request({ baseURL: "https://gw.acme.dev/anthropic" })), "https://gw.acme.dev/anthropic/v1/messages");
    assert.equal(anthropicMessagesUrl(request({ baseURL: "https://gw.acme.dev/v1/" })), "https://gw.acme.dev/v1/messages");
    assert.equal(anthropicMessagesUrl(request({ baseURL: "https://gw.acme.dev/v1/messages" })), "https://gw.acme.dev/v1/messages");
    console.log("✓ Test 4 Passed: a proxy baseURL is used; the default is the Anthropic endpoint.");
  }

  // ── Test 5: cache_control survives on the stable head ────────────────────
  {
    const body = buildAnthropicBody(request({ tools: [{ name: "a", parameters: { type: "object", properties: {} } }] as never }));
    assert.equal((body.system as Array<Record<string, any>>)[0].cache_control.type, "ephemeral");
    assert.equal((body.tools as Array<Record<string, any>>)[0].cache_control.type, "ephemeral");
    console.log("✓ Test 5 Passed: Phase 18 cache breakpoints intact through the Phase 34 rewrite.");
  }

  console.log("\n🎉 All Phase 34 Anthropic correctness tests passed.");
}
run().catch((e) => { console.error("Phase 34 failed:", e); process.exit(1); });

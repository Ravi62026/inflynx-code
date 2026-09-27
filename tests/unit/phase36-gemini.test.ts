/**
 * Backlog Phase 36 — Gemini adapter correctness, on a recorded request + stream.
 *
 * The API key used to ride in the query string (`?key=…`, finding B14) — into proxy logs and
 * error text. `reasoningEffort:"none"` set `thinkingLevel:"none"`, not the valid
 * `thinkingBudget:0`. Streamed text came back as one part per delta. All three asserted here
 * with a local fetch spy that captures the URL, headers and body.
 */

import assert from "node:assert/strict";
import { streamGemini, formatGeminiContents } from "../../packages/model-gateway/src/gemini.js";
import type { Message, ModelRequest } from "../../packages/model-gateway/src/types.js";

const KEY = "AIza-test-secret-key-do-not-log";

function captureFetch(sseLines: string[]) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sseLines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  return { seen, restore: () => { (globalThis as any).fetch = original; } };
}

function req(over: Partial<ModelRequest>): ModelRequest {
  return { provider: "google", model: "gemini-2.5-pro", adapter: "gemini", apiKey: KEY, messages: [{ role: "user", content: "hi" }], ...over } as unknown as ModelRequest;
}

async function drain(gen: AsyncIterable<unknown>, sink?: (e: any) => void): Promise<void> {
  for await (const e of gen) { sink?.(e); }
}

async function run() {
  console.log("🧪 Running Phase 36 Gemini correctness tests...\n");

  // ── Test 1: the key is a header, never in the URL (B14) ─────────────────
  {
    const f = captureFetch([JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })]);
    try { await drain(streamGemini(req({}))); } finally { f.restore(); }
    assert.ok(!f.seen[0].url.includes("key="), `the key is still in the query string: ${f.seen[0].url}`);
    assert.ok(!f.seen[0].url.includes(KEY), "the secret key appears in the URL at all");
    assert.equal(f.seen[0].headers["x-goog-api-key"], KEY, "key not sent as the header");
    console.log("✓ Test 1 Passed: x-goog-api-key header; no key in the request URL.");
  }

  // ── Test 2: reasoning none → thinkingBudget 0, not a bad thinkingLevel ──
  {
    const f = captureFetch([JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] })]);
    try { await drain(streamGemini(req({ reasoningEffort: "none" }))); } finally { f.restore(); }
    const gc = f.seen[0].body.generationConfig;
    assert.equal(gc.thinkingConfig.thinkingBudget, 0, "none must set thinkingBudget:0");
    assert.notEqual(gc.thinkingConfig.thinkingLevel, "none", "the invalid thinkingLevel:'none' is still sent");

    const f2 = captureFetch([JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] })]);
    try { await drain(streamGemini(req({ reasoningEffort: "high" }))); } finally { f2.restore(); }
    assert.equal(f2.seen[0].body.generationConfig.thinkingConfig.thinkingLevel, "high", "a real effort should still set thinkingLevel");
    console.log("✓ Test 2 Passed: none → {thinkingBudget:0}; other efforts → {thinkingLevel}.");
  }

  // ── Test 3: streamed text chunks merge into ONE part ────────────────────
  {
    const f = captureFetch([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello, " }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "world." }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: " done" }] } }], finishReason: "STOP" }),
    ]);
    let text = "";
    try { await drain(streamGemini(req({})), (e) => { if (e.type === "text_delta") text += e.text; }); } finally { f.restore(); }
    assert.equal(text, "Hello, world. done", "the deltas did not stream through");
    // The persisted parts must be merged, not three separate fragments.
    const replay = f.seen[0] ? null : null; void replay;
    // Re-derive finalParts via a second run against formatGeminiContents is not possible;
    // instead confirm the store keeps one text part by checking the emitted done metadata:
    let doneMeta: { geminiParts?: unknown[] } | undefined;
    const f2 = captureFetch([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ab" }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "cd" }] } }], finishReason: "STOP" }),
    ]);
    try { await drain(streamGemini(req({})), (e) => { if (e.type === "done") doneMeta = e.providerMetadata; }); } finally { f2.restore(); }
    const texts = (doneMeta?.geminiParts ?? []).filter((p: any) => typeof p.text === "string");
    assert.equal(texts.length, 1, `expected one merged text part, got ${texts.length}`);
    assert.equal((texts[0] as any).text, "abcd", "merged text lost a chunk");
    console.log("✓ Test 3 Passed: multi-chunk text merges to a single part (deltas still stream).");
  }

  // ── Test 4: a functionResponse names the originating call ───────────────
  {
    const out = formatGeminiContents([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_9", type: "function", function: { name: "list_files", arguments: "{}" } }] } as unknown as Message,
      { role: "tool", tool_call_id: "call_9", content: "result" } as Message,
    ] as Message[]);
    const fnResp = out.contents.flatMap((c) => c.parts).find((p: any) => p.functionResponse) as any;
    assert.ok(fnResp, "no functionResponse part");
    assert.equal(fnResp.functionResponse.name, "list_files", "the tool name was not resolved from the call");
    console.log("✓ Test 4 Passed: functionResponse.name resolves to the real tool, not unknown_tool.");
  }

  console.log("\n🎉 All Phase 36 Gemini correctness tests passed.");
}
run().catch((e) => { console.error("Phase 36 failed:", e); process.exit(1); });

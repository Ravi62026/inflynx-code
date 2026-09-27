/**
 * Phase 27 completion — the agent can open image files *itself*.
 *
 * Until now `read_file` decoded every file as UTF-8, so a PNG the agent read on its own
 * initiative came back as mojibake (and a `.zip` came back as mojibake too). Images a
 * *user* attached worked (Phase 27 transport), but agent-initiated reads were blind.
 * These tests pin both halves of the fix: the tool returns structured image parts, and
 * the orchestrator injects them as a follow-up user message the adapters render natively.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CORE_TOOLS,
  ToolRegistry,
  executeTool,
  createToolExecutionContextFromGuard,
} from "../../packages/tool-runtime/src/index.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/path-guard.js";
import { startHarness, toolCallSse, textSse } from "../helpers/agent-harness.js";

// 1×1 transparent PNG — a real image, not a renamed text file.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

async function main() {
  const root = fs.mkdtempSync("inflynx-image-read-");
  process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, "shot.png"), PNG_1PX);
  fs.writeFileSync(path.join(root, "notes.txt"), "hello\n");
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));

  const registry = new ToolRegistry(CORE_TOOLS);
  const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root), { sessionId: "img-test" });

  // 1. An image file returns a structured image part — never base64 in the text channel.
  const img = await executeTool(registry, { id: "t1", name: "read_file", args: JSON.stringify({ path: "shot.png" }) }, ctx);
  assert.equal(img.isError, false, "image read failed");
  assert.ok(img.images?.length === 1, "image read did not carry an images[] part");
  assert.equal(img.images![0].mediaType, "image/png");
  assert.equal(img.images![0].name, "shot.png");
  assert.ok(img.images![0].dataBase64.length > 50, "image part had no payload");
  assert.ok(!img.output.includes("iVBOR"), "base64 leaked into the text channel");

  // 2. A genuinely binary, non-image file gets an honest message, not mojibake.
  const bin = await executeTool(registry, { id: "t2", name: "read_file", args: JSON.stringify({ path: "blob.bin" }) }, ctx);
  assert.ok(!bin.images?.length, "binary file must not be mistaken for an image");
  assert.match(bin.output, /binary file/, "binary file was not reported honestly");

  // 3. Text files behave exactly as before (numbered gutter, no image part).
  const txt = await executeTool(registry, { id: "t3", name: "read_file", args: JSON.stringify({ path: "notes.txt" }) }, ctx);
  assert.ok(!txt.images?.length, "text read grew an images part");
  assert.match(txt.output, /1 │ hello/, "text file read regressed");

  // 4. An oversized image is refused with an actionable message, never partially loaded.
  // (`executeTool` turns tool throws into isError results — refusals are data.)
  const bigDir = path.join(root, "big");
  fs.mkdirSync(bigDir);
  fs.writeFileSync(path.join(bigDir, "huge.png"), Buffer.alloc(4_000_001, 1));
  const tooBig = await executeTool(registry, { id: "t4", name: "read_file", args: JSON.stringify({ path: "big/huge.png" }) }, ctx);
  assert.equal(tooBig.isError, true, "oversized image was not refused");
  assert.match(tooBig.output, /too large/, "refusal did not say why");

  // 5. End-to-end: a turn whose model calls read_file on an image must put a *native*
  // image part on the wire (openai-chat: image_url), not a data-URL inside prose.
  const harness = await startHarness({
    root,
    script: [
      () => toolCallSse("read_file", { path: "shot.png" }, "img-call-1"),
      () => textSse("I can see the screenshot."),
    ],
  });
  try {
    const turn = await harness.orchestrator.runTurn("Look at shot.png and tell me what it shows.");
    assert.equal(turn.isCompleted, true, "turn did not complete");

    // The second model request carries the image as a native part on a user message.
    const second = harness.fetch.requests()[1];
    const lastUser = [...second.messages].reverse().find((m: any) => m.role === "user");
    assert.ok(lastUser, "no user message followed the tool result");
    const imgPart = (Array.isArray(lastUser.content) ? lastUser.content : []).find(
      (p: any) => p.type === "image_url"
    );
    assert.ok(imgPart, "image was not sent to the provider as a native image_url part");
    assert.match(String(imgPart.image_url?.url ?? ""), /^data:image\/png;base64,/, "image_url was not a data URL");
    // And no base64 blob ever rode inside any text channel.
    const textParts = (Array.isArray(lastUser.content) ? lastUser.content : [])
      .filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    assert.ok(!textParts.includes("iVBOR"), "base64 leaked into the user text channel");
    assert.match(textParts, /Images returned by read_file/, "image carrier message missing");
  } finally {
    harness.fetch.restore();
  }

  console.log("✓ image-read: structured image parts, binary honesty, text unchanged, size cap, native provider injection");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

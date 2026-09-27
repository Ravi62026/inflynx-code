/**
 * Backlog Phase 27 — media & attachment content transport.
 *
 * Two properties, both previously false: (1) an attached text file reaches the model as its
 * *content*, not a `[Attached File: name]` placeholder; (2) images become native per-provider
 * image blocks, not a base64 data-URL scraped out of the text by one adapter. Plus the
 * Phase-28 tie-in: an attachment named like a secret (`.env`) is withheld, not routed into
 * the model context through the back door.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { prepareAttachments } from "../../apps/server/src/attachments.js";
import { formatOpenAiCompatibleMessages } from "../../packages/model-gateway/src/openai-chat.js";
import { formatAnthropicMessages } from "../../packages/model-gateway/src/anthropic.js";
import { formatGeminiContents } from "../../packages/model-gateway/src/gemini.js";
import { resolveAtMentionContext } from "../../packages/workspace-runtime/src/index.js";
import { cleanupOnExit } from "../helpers/tmp.js";

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}
function textDataUrl(content: string, mime = "text/plain"): string {
  return `data:${mime};base64,${b64(content)}`;
}
function wsRoot(): string {
  return cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p27-")));
}

async function runPhase27Tests(): Promise<void> {
  console.log("🧪 Running Phase 27 Attachment & Multimodal Transport Tests...\n");

  // ── Test 1: a text attachment ships its CONTENT ──────────────────────────
  {
    const root = wsRoot();
    const r = prepareAttachments(
      [{ name: "config.ts", mimeType: "text/typescript", dataUrl: textDataUrl("export const a = 1;\nexport const b = 2;\n") }],
      { root }
    );
    assert.match(r.contextText, /export const a = 1;/, "the file content was not inlined");
    assert.ok(!r.contextText.includes("[Attached File:"), "the old placeholder is back");
    assert.match(r.contextText, /Attached file: config\.ts/, "no filename header");
    console.log("✓ Test 1 Passed: a .ts attachment reaches the turn as its real content, not a name.");
  }

  // ── Test 2: the fence — .env withheld, .env.example allowed ──────────────
  {
    const root = wsRoot();
    const secret = prepareAttachments([{ name: ".env", dataUrl: textDataUrl("OPENAI_API_KEY=sk-super-secret\n") }], { root });
    assert.match(secret.contextText, /was NOT sent to the model/, "a .env attachment was inlined anyway");
    assert.ok(!secret.contextText.includes("sk-super-secret"), "the secret leaked into the transport text");
    assert.equal(secret.images.length, 0);

    const tmpl = prepareAttachments([{ name: ".env.example", dataUrl: textDataUrl("OPENAI_API_KEY=\n") }], { root });
    assert.match(tmpl.contextText, /OPENAI_API_KEY=/, "the committed template should still ship");
    assert.ok(!/NOT sent/.test(tmpl.contextText), "a template was withheld");
    console.log("✓ Test 2 Passed: an .env attachment is withheld by the fence; .env.example ships.");
  }

  // ── Test 3: images are structured, never a data-URL in the text ──────────
  {
    const root = wsRoot();
    const png = "iVBORw0KGgoAAAANSUhEUg=="; // opaque base64 for a tiny png
    const r = prepareAttachments([{ name: "shot.png", mimeType: "image/png", dataUrl: `data:image/png;base64,${png}` }], { root });
    assert.equal(r.images.length, 1, "image not captured structurally");
    assert.equal(r.images[0].mediaType, "image/png");
    assert.equal(r.images[0].dataBase64, png, "base64 payload changed in transit");
    // The human-readable note mentions the image but does NOT embed the payload.
    assert.match(r.contextText, /included as an image/, r.contextText);
    assert.ok(!r.contextText.includes(png), "raw base64 leaked into the text channel again");
    console.log("✓ Test 3 Passed: an image becomes a structured {mediaType, dataBase64}, not text.");
  }

  // ── Test 4: binary and malformed inputs are honest, not fatal ───────────
  {
    const root = wsRoot();
    const saveDir = path.join(root, ".inflynx", "attachments");
    const pdf = prepareAttachments([{ name: "spec.pdf", mimeType: "application/pdf", dataUrl: `data:application/pdf;base64,${b64("\u0000\u0001binary not text\u0000")}` }], { root, saveDir });
    assert.match(pdf.contextText, /not text/, "a PDF was treated as inlineable text");
    assert.ok(!pdf.contextText.includes("[Attached File:"), "the placeholder is back");
    assert.equal(fs.existsSync(path.join(saveDir)), true, "the binary was not saved for a tool to read");

    const noData = prepareAttachments([{ name: "ghost.txt" }], { root });
    assert.match(noData.contextText, /carried no content/, "a contentless attachment was silent");
    const badB64 = prepareAttachments([{ name: "x.txt", dataUrl: "not-a-data-url-!!" }], { root });
    assert.ok(typeof badB64.contextText === "string", "malformed input threw");
    console.log("✓ Test 4 Passed: pdf saved-and-pointed-to, empty/malformed handled without a crash.");
  }

  // ── Test 5: OpenAI adapter → image_url parts, clean text ────────────────
  {
    const out = formatOpenAiCompatibleMessages([
      { role: "user", content: "what does this show?", images: [{ mediaType: "image/png", dataBase64: "QUJD" }] } as never,
    ]);
    const msg = out[0] as { role: string; content: unknown };
    assert.ok(Array.isArray(msg.content), "user content was not turned into parts");
    const parts = msg.content as Array<Record<string, any>>;
    assert.ok(parts.some((p) => p.type === "image_url" && p.image_url.url === "data:image/png;base64,QUJD"),
      `no native image_url block: ${JSON.stringify(parts)}`);
    assert.ok(parts.some((p) => p.type === "text" && p.text.includes("what does this show")), "text part lost");
    // A text-only message is unchanged (no accidental array-ification).
    const plain = formatOpenAiCompatibleMessages([{ role: "user", content: "hi" } as never]);
    assert.equal((plain[0] as { content: unknown }).content, "hi", "plain text was reshaped");
    console.log("✓ Test 5 Passed: OpenAI-chat builds image_url + text parts; plain text untouched.");
  }

  // ── Test 6: Anthropic adapter → image source block ──────────────────────
  {
    const out = formatAnthropicMessages([
      { role: "user", content: "review", images: [{ mediaType: "image/jpeg", dataBase64: "SUVK" }] } as never,
    ]);
    const blocks = out[0].content as Array<Record<string, any>>;
    const img = blocks.find((b) => b.type === "image");
    assert.ok(img, `anthropic got no image block: ${JSON.stringify(blocks)}`);
    assert.deepEqual(img.source, { type: "base64", media_type: "image/jpeg", data: "SUVK" });
    assert.ok(blocks.some((b) => b.type === "text" && b.text === "review"), "text block lost");
    console.log("✓ Test 6 Passed: Anthropic gets a native base64 image source block (was an unreadable blob).");
  }

  // ── Test 7: Gemini adapter → inlineData part ────────────────────────────
  {
    const { contents } = formatGeminiContents([
      { role: "user", content: "screenshot?", images: [{ mediaType: "image/webp", dataBase64: "V0VC" }] } as never,
    ]);
    const parts = (contents as Array<Record<string, any>>).find((c) => c.role === "user")!.parts as Array<Record<string, any>>;
    const inline = parts.find((p) => p.inlineData);
    assert.ok(inline, `gemini got no inlineData part: ${JSON.stringify(parts)}`);
    assert.equal(inline.inlineData.mimeType, "image/webp");
    console.log("✓ Test 7 Passed: Gemini gets an inlineData part — the adapter that never had image support.");
  }

  // ── Test 8: legacy data-URL text is neutralised, not double-sent ────────
  {
    // A persisted older session still has the markdown blob in content.
    const out = formatOpenAiCompatibleMessages([
      { role: "user", content: "see ![shot](data:image/png;base64,QUJD) please" } as never,
    ]);
    const msg = out[0] as { content: unknown };
    assert.equal(typeof msg.content, "string", "a legacy text-only message became parts");
    assert.ok(!(msg.content as string).includes("base64,QUJD"), "the raw base64 is still going out as text");
    assert.match(msg.content as string, /Attached Screenshot/, "the legacy image was not replaced with a marker");
    console.log("✓ Test 8 Passed: an old data-URL-in-text message is scrubbed rather than sent as a blob.");
  }

  // ── Test 9: `@.env` in the CLI is fenced too (finding B7) ───────────────
  {
    const root = wsRoot();
    fs.writeFileSync(path.join(root, ".env"), "SECRET=leak-me\n", "utf-8");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "real.ts"), "export const ok = 1;\n", "utf-8");

    const envBlock = resolveAtMentionContext([{ filePath: ".env", absolutePath: path.join(root, ".env") }] as never);
    assert.match(envBlock, /Not included: .*sensitive path/, "@.env was inlined into the prompt");
    assert.ok(!envBlock.includes("leak-me"), "the secret leaked via @mention");

    const okBlock = resolveAtMentionContext([{ filePath: "src/real.ts", absolutePath: path.join(root, "src", "real.ts") }] as never);
    assert.match(okBlock, /export const ok = 1;/, "a normal @file was wrongly withheld");
    console.log("✓ Test 9 Passed: @.env is withheld from the CLI prompt (B7); a normal @file still resolves.");
  }

  console.log("\n🎉 All Phase 27 Attachment & Multimodal Transport Tests Passed 100%!");
}

runPhase27Tests().catch((err) => {
  console.error("Phase 27 test failed:", err);
  process.exit(1);
});

/**
 * Attachment content transport (backlog Phase 27).
 *
 * The old server code did two harmful things: it turned a non-image attachment into the
 * literal string `[Attached File: name]` — so the model saw a filename and none of the
 * content — and it pasted image bytes into the message *text* as a markdown data-URL that
 * only the OpenAI adapter knew how to regex back out (Anthropic/Gemini got a base64 blob
 * they could not read).
 *
 * `prepareAttachments` replaces both: it decodes each attachment once, classifies it, and
 * returns the two channels the rest of the pipeline understands — a text block (real file
 * contents, fenced and bounded) and a list of structured {@link MessageImage}s.
 *
 * ## The Phase 28 tie-in, and why it belongs here
 *
 * An attachment named `.env` / `id_rsa` / anything under `.git` is exactly what the sensitive
 * fence protects on disk. Letting the client "attach" it to route its contents into the model
 * context would be a side door around that fence, so the classification reuses
 * `isSensitiveToRead` and *withholds* the bytes with an explicit note rather than silently
 * sending a secret to the provider. A `.env.example` — a committed template — still ships.
 */

import fs from "node:fs";
import path from "node:path";
import { isSensitiveToRead } from "@inflynx/policy-engine";
import type { MessageImage } from "@inflynx/model-gateway";

export interface IncomingAttachment {
  name?: string;
  mimeType?: string;
  /** A `data:<mime>;base64,<payload>` URL from the browser. */
  dataUrl?: string;
}

export interface PreparedAttachments {
  /** Text to append to the user turn: inlined file contents + human notes. */
  contextText: string;
  images: MessageImage[];
  /** Files written under `saveDir` (images, and binaries we cannot inline), for the record. */
  savedPaths: string[];
}

/** Inlined text is capped so one large upload cannot eat the context window. */
const MAX_INLINE_TEXT_BYTES = 200_000;

/** Extensions we treat as text even when the browser reports a generic mime type. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".mdx", ".txt",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".csv", ".tsv", ".log",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".swift", ".sql", ".sh", ".bash", ".zsh", ".ps1", ".html", ".htm", ".css", ".scss", ".xml",
  ".graphql", ".gql", ".proto", ".dockerfile", ".makefile",
]);

function decodeBase64(dataUrl: string): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  const comma = dataUrl.indexOf(",");
  const payload = dataUrl.startsWith("data:") && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  try {
    const buffer = Buffer.from(payload, "base64");
    // Buffer.from is lenient and silently drops invalid characters; re-encoding to a
    // comparable length catches a URL that was never real base64.
    if (buffer.length === 0 && payload.trim().length > 0) return { ok: false, error: "empty after decode" };
    return { ok: true, buffer };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** MIME from the `data:` prefix when present, else the declared mimeType. */
function effectiveMimeType(att: IncomingAttachment, dataUrl: string | undefined): string {
  const fromUrl = dataUrl?.startsWith("data:") ? /^data:([^;,]+)/.exec(dataUrl)?.[1] : undefined;
  return (fromUrl || att.mimeType || "").toLowerCase();
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  // A NUL byte is the reliable "binary" signal; a lone UTF-8 replacement means bad decoding.
  if (sample.includes(0)) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return !decoded.includes("\uFFFD");
  } catch {
    return false;
  }
}

function isTextAttachment(att: IncomingAttachment, mime: string): boolean {
  if (mime.startsWith("image/")) return false;
  if (mime.startsWith("text/")) return true;
  if (/json|xml|javascript|typescript|yaml|x-sh|csv|markdown/.test(mime)) return true;
  const ext = path.extname(att.name || "").toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || (att.name || "").toLowerCase() === "dockerfile" || (att.name || "").toLowerCase() === "makefile";
}

function sanitize(name: string | undefined, fallback: string): string {
  return (name || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || fallback;
}

/**
 * @param root workspace root — only used to phrase the fence reason and compute saved paths.
 * @param saveDir if given, images and non-inlined binaries are written here for the record.
 */
export function prepareAttachments(
  attachments: IncomingAttachment[],
  opts: { root: string; saveDir?: string; stamp?: () => string }
): PreparedAttachments {
  const textParts: string[] = [];
  const images: MessageImage[] = [];
  const savedPaths: string[] = [];
  const stamp = opts.stamp ?? (() => String(Date.now()));

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const name = sanitize(att?.name, `attachment_${i + 1}`);
    if (!att?.dataUrl) {
      textParts.push(`[Attached file "${name}" carried no content — it could not be read.]`);
      continue;
    }
    const decoded = decodeBase64(att.dataUrl);
    if (!decoded.ok) {
      textParts.push(`[Attached file "${name}" could not be decoded (${decoded.error}).]`);
      continue;
    }
    const mime = effectiveMimeType(att, att.dataUrl);

    // 1. Images → structured, plus saved to disk.
    if (mime.startsWith("image/")) {
      images.push({ mediaType: mime, dataBase64: decoded.buffer.toString("base64"), name });
      const saved = maybeSave(opts.saveDir, `${stamp()}_${name}`, decoded.buffer);
      if (saved) savedPaths.push(saved);
      textParts.push(`[Attached image "${name}" (${mime}) is included as an image${saved ? ` and saved at ${saved}` : ""}.]`);
      continue;
    }

    // 2. Sensitive-by-name files → withheld, never inlined. This is the Phase 28 fence on
    //    the read/attach side; without it, attaching `.env` bypasses the write fence's intent.
    const fence = isSensitiveToRead(path.join(opts.root, name), opts.root);
    if (fence.sensitive) {
      textParts.push(
        `[Attached file "${name}" was NOT sent to the model: ${fence.reason}]`
      );
      continue;
    }

    // 3. Text → inline the real content (bounded), which is the whole point of the phase.
    if (isTextAttachment(att, mime) || looksLikeText(decoded.buffer)) {
      let text = decoded.buffer.toString("utf-8");
      const truncated = text.length > MAX_INLINE_TEXT_BYTES;
      if (truncated) text = text.slice(0, MAX_INLINE_TEXT_BYTES);
      textParts.push(
        `=== Attached file: ${name} ===\n${text}${truncated ? `\n\n[… truncated at ${MAX_INLINE_TEXT_BYTES.toLocaleString()} characters — the full file is on disk if you need the rest]` : ""}\n=== end ${name} ===`
      );
      continue;
    }

    // 4. Binary we cannot represent (pdf, archives, …) → save + tell the model where, so a
    //    real file tool can read it. Do not pretend it was transported.
    const saved = maybeSave(opts.saveDir, `${stamp()}_${name}`, decoded.buffer);
    if (saved) savedPaths.push(saved);
    textParts.push(
      `[Attached file "${name}" (${mime || "binary"}) is not text; it was saved${saved ? ` at ${saved}` : ""} and is NOT in this message — read it with a file tool if needed.]`
    );
  }

  return { contextText: textParts.join("\n\n"), images, savedPaths };
}

function maybeSave(saveDir: string | undefined, filename: string, buffer: Buffer): string | null {
  if (!saveDir) return null;
  try {
    fs.mkdirSync(saveDir, { recursive: true });
    const filePath = path.join(saveDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}

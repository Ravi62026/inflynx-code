import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * B11 (Phase 47): the model's answer, thinking, and any fetched/MCP/web content are rendered to HTML
 * and injected via `dangerouslySetInnerHTML`. `marked` does NOT sanitize — a page a `fetch_url`
 * pulled in, or an MCP tool result, can smuggle `<img src=x onerror=…>` into the webview. So every
 * such string is routed through here, which sanitizes *after* rendering and before it reaches the DOM.
 * One helper on purpose: three call sites each calling `marked.parse` inline would drift.
 */
export function renderMarkdown(src: string | undefined | null): string {
  if (!src) return "";
  const html = marked.parse(src, { async: false }) as string;
  // Strip scripts/event-handlers/remote-including tags; keep ordinary markdown markup.
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

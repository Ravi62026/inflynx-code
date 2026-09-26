/**
 * HTTP MCP transport — the real one (backlog I1).
 *
 * What used to be here was not MCP: `connectSseServer` issued one `GET`, and on success
 * registered a single fabricated tool named `mcp__<id>__fetch` that did
 * `GET ?query=<string>`. It never spoke JSON-RPC, never called `initialize`, never
 * listed the server's tools, and never called `tools/call`. A configured MCP server
 * therefore appeared connected, contributed a tool that looked plausible, and returned
 * whatever the endpoint's query-string handler felt like returning.
 *
 * Two wire styles exist in the wild and both are implemented:
 *
 * - **streamable-http** (current): POST JSON-RPC to the endpoint; the answer comes back
 *   either as `application/json` or as an SSE stream for that one request. A server may
 *   issue `Mcp-Session-Id`, which must be echoed.
 * - **sse** (legacy 2024-11-05): `GET` the endpoint to open a long-lived stream, learn a
 *   POST URL from its first `event: endpoint`, then every response arrives on that stream.
 *
 * Every request re-runs `validatePublicUrl` and refuses redirects, so the SSRF posture is
 * per-request rather than configured-once-and-hoped.
 */

import { validatePublicUrl } from "@inflynx/policy-engine";
import type { ResolvedMcpServer } from "@inflynx/config";
import { JsonRpcSession, type JsonRpcMessage, type SessionExitInfo } from "./json-rpc.js";

/** A single SSE frame or JSON body is capped; a server that streams 500 MB is refused. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const PROTOCOL_LATEST = "2025-03-26";
const PROTOCOL_LEGACY = "2024-11-05";

export interface HttpSessionHandlers {
  onExit?: (info: SessionExitInfo) => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  /**
   * URL guard for every request this session makes. Defaults to the real SSRF policy.
   * It is a parameter rather than an env var because a test needs to reach a loopback
   * server while production must not — and an escape hatch compiled into the guard
   * itself would be reachable by anyone who can set an environment variable.
   */
  validateUrl?: (raw: string) => Promise<URL>;
}

interface SseFrame {
  event: string;
  data: string;
}

/** Incremental `text/event-stream` parser: events are separated by a blank line. */
class SseParser {
  private buffer = "";
  private receivedBytes = 0;

  push(chunk: string): SseFrame[] {
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > MAX_RESPONSE_BYTES) {
      throw new Error(`SSE stream exceeded ${MAX_RESPONSE_BYTES} bytes — aborting the server`);
    }
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseEventBlock(rawEvent);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

function parseEventBlock(block: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    // `id:` and `retry:` are meaningful to a reconnecting client; this client does not
    // reconnect mid-session, so ignoring them is correct rather than an omission.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export class HttpMcpSession extends JsonRpcSession {
  private mode: "streamable" | "legacy" = "streamable";
  private sessionId?: string;
  private protocolVersion = PROTOCOL_LATEST;
  private readonly abort = new AbortController();
  private postTarget?: URL;
  private endpointSeen!: Promise<void>;
  private resolveEndpoint!: () => void;
  private rejectEndpoint!: (e: Error) => void;
  private legacyReader?: ReadableStreamDefaultReader<Uint8Array>;

  private constructor(
    private readonly config: ResolvedMcpServer,
    private readonly baseUrl: URL,
    handlers: HttpSessionHandlers,
    private readonly guard: (raw: string) => Promise<URL>
  ) {
    super(`MCP ${config.transport} server "${config.id}"`, handlers.onExit, handlers.onNotification);
    this.endpointSeen = new Promise((res, rej) => {
      this.resolveEndpoint = res;
      this.rejectEndpoint = rej;
    });
  }

  /**
   * Opens the *channel* for one wire style and nothing more — `initialize` is the same
   * code for every transport, so it lives in the client. Which style to try, and whether
   * to fall back to the other, is the caller's decision.
   */
  static async openChannel(
    config: ResolvedMcpServer,
    mode: "streamable" | "legacy",
    handlers: HttpSessionHandlers = {}
  ): Promise<HttpMcpSession> {
    if (!config.url) throw new Error(`MCP server "${config.id}" is a HTTP transport with no url.`);
    const guard = handlers.validateUrl ?? validatePublicUrl;
    const session = new HttpMcpSession(config, await guard(config.url), handlers, guard);
    try {
      if (mode === "legacy") await session.openLegacyStream();
      else session.mode = "streamable"; // the first POST is the handshake; nothing to pre-open
    } catch (err) {
      session.close();
      throw err;
    }
    return session;
  }

  // ── streamable-http ─────────────────────────────────────────────────────────

  /**
   * The protocol version this channel should advertise in `initialize`. A server that
   * only speaks the 2024 SSE style will reject a newer version outright, so guessing
   * "latest" for both channels is how a working legacy server looks broken.
   */
  get clientProtocol(): string {
    return this.mode === "legacy" ? PROTOCOL_LEGACY : this.protocolVersion;
  }

  /** The `Mcp-Session-Id` the server issued, if any — worth showing in `/mcp list`. */
  get issuedSessionId(): string | undefined {
    return this.sessionId;
  }

  // ── legacy HTTP + SSE ───────────────────────────────────────────────────────

  private async openLegacyStream(): Promise<void> {
    this.mode = "legacy";
    const endpoint = await this.guard(this.config.url!);
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "text/event-stream", ...this.config.headers },
      redirect: "manual",
      signal: this.abort.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("redirect refused by SSRF policy");
    }
    if (!res.ok || !res.body) throw new Error(`SSE GET failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    this.legacyReader = reader;
    const decoder = new TextDecoder();
    const parser = new SseParser();

    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.event === "endpoint") {
              // The server tells us where to POST. It may be a path, or absolute.
              this.postTarget = new URL(frame.data.trim(), this.baseUrl);
              this.resolveEndpoint();
              continue;
            }
            this.ingestLine(frame.data);
          }
        }
        // Stream ended without an error: the server is gone, not broken.
        this.handleClose(null, null);
      } catch (err: any) {
        if (this.abort.signal.aborted) return;
        this.rememberStderr(`SSE stream error: ${err?.message || String(err)}`);
        this.rejectEndpoint(new Error(`no endpoint event: ${err?.message || String(err)}`));
        this.handleClose(null, null);
      }
    })();
    void pump;

    await Promise.race([
      this.endpointSeen,
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        "server opened an SSE stream but never sent an `endpoint` event within 10s"
      )), 10_000).unref?.()),
    ]);
  }

  // ── JsonRpcSession implementation ───────────────────────────────────────────

  protected async writeMessage(message: JsonRpcMessage): Promise<void> {
    if (this.mode === "legacy") {
      if (!this.postTarget) await this.endpointSeen;
      const target = await this.guard(this.postTarget!.toString());
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.config.headers },
        body: JSON.stringify(message),
        redirect: "manual",
        signal: this.abort.signal,
      });
      // Legacy servers answer 202 and put the real response on the GET stream.
      if (res.status >= 300 && res.status < 400) throw new Error("redirect refused by SSRF policy");
      if (!res.ok && res.status !== 202 && res.status !== 204) {
        throw new Error(`POST failed: HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
      }
      if (typeof message.id === "number") {
        // If this server answered inline anyway, route it — the session still waits on id.
        const body = await safeText(res);
        if (body.trim()) this.ingestLine(body.trim());
      } else {
        await safeText(res).catch(() => "");
      }
      return;
    }

    const target = await this.guard(this.config.url!);
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": this.protocolVersion,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...this.config.headers,
      },
      body: JSON.stringify(message),
      redirect: "manual",
      signal: this.abort.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const negotiated = res.headers.get("mcp-protocol-version");
    if (negotiated) this.protocolVersion = negotiated;

    if (res.status >= 300 && res.status < 400) throw new Error("redirect refused by SSRF policy");
    if (res.status === 404 && this.sessionId) {
      // A stale session id is a common server restart symptom; say what to do about it.
      throw new Error("HTTP 404 — the server dropped this session id; reconnect");
    }
    if (!res.ok) throw new Error(`POST failed: HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
    if (typeof message.id !== "number") {
      await safeText(res).catch(() => ""); // notification: nothing to route
      return;
    }
    if (!res.body) {
      throw new Error("response carried no body for a request that expects an answer");
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const body = (await safeText(res)).trim();
      if (!body) {
        // An accepted-but-empty answer to a request with an id is how a legacy SSE server
        // responds to a POST. Failing here instead of waiting out the initialize budget is
        // what makes the transport fallback usable: the alternative is 10 dead seconds
        // every time a hand-written config guesses the wrong wire style.
        throw new Error(
          `server accepted the request but returned no answer (HTTP ${res.status}) — ` +
          `this endpoint is probably the legacy HTTP+SSE style, not streamable-http`
        );
      }
      this.ingestLine(body);
      return;
    }

    // Per-request SSE: read frames until ours answers, then stop. Leaving the body
    // unread-but-open is how a long-lived stream would leak.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const wantId = message.id;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (this.alive && !this.stillWaiting(wantId)) break;
          throw new Error(`SSE response ended before answering request ${wantId}`);
        }
        let frames: SseFrame[];
        try {
          frames = parser.push(decoder.decode(value, { stream: true }));
        } catch (err: any) {
          throw new Error(err?.message || String(err));
        }
        for (const frame of frames) {
          const data = frame.data.trim();
          if (!data) continue;
          this.ingestLine(data);
          if (!this.stillWaiting(wantId)) return; // answered: stop reading this stream
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }

  /** Whether a request id is still waiting — used to know when a stream has finished. */
  private stillWaiting(id: number): boolean {
    return this.hasPending(id);
  }

  protected teardown(): void {
    try { this.legacyReader?.cancel().catch(() => {}); } catch { /* ignore */ }
    this.abort.abort();
    if (this.sessionId && this.mode === "streamable") {
      // Best-effort session teardown, per the spec. A failure here is not the user's problem.
      void this.guard(this.config.url!).then((url) =>
        fetch(url, {
          method: "DELETE",
          headers: { "Mcp-Session-Id": this.sessionId!, "MCP-Protocol-Version": this.protocolVersion, ...this.config.headers },
          redirect: "manual",
        }).then((r) => r.body?.cancel(), () => {})
      ).catch(() => {});
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const buf = await res.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096)));
  } catch {
    return "";
  }
}

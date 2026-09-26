/**
 * JSON-RPC session plumbing shared by every MCP transport.
 *
 * Both transports need the same three things that the previous implementation lacked:
 * requests that can be answered out of order, per-method time budgets instead of one
 * 10 s ceiling (backlog I2), and a way to fail *everything* the instant the peer goes
 * away — because a dead server that still reports `status: "connected"` makes the next
 * twenty tool calls each wait out a timeout (I3).
 *
 * Notifications are parsed and routed too, so `notifications/progress` and
 * `notifications/message` stop being invisible. They are not logged here: this layer has
 * no session identity to attribute them to.
 */

/**
 * Distinct budgets, because the three calls are not comparable work.
 * `tools/call` is the only one a server may legitimately take minutes on, and a config
 * can raise it per server (`timeoutMs`) — the other two are handshakes and should be
 * fast or the server is broken.
 */
export const MCP_TIMEOUTS = {
  initialize: 10_000,
  list: 30_000,
  /** Default ceiling for one `tools/call`, absent a per-server override. */
  call: 120_000,
} as const;

/** How much stderr to keep per server: enough to explain a crash, not enough to flood. */
const STDERR_CAP = 8 * 1024;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Progress notifications carrying this token are reported to `onProgress`. */
  onProgress?: (info: { progress?: number; total?: number; message?: string }) => void;
}

export interface SessionExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Trailing stderr, capped. Often the only explanation a user will get. */
  stderr: string;
}

export abstract class JsonRpcSession {
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
    onProgress?: (info: { progress?: number; total?: number; message?: string }) => void;
    token?: string;
  }>();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;
  private closeReported = false;

  constructor(
    protected readonly label: string,
    private readonly onExit?: (info: SessionExitInfo) => void,
    private readonly onNotification?: (method: string, params: Record<string, unknown>) => void
  ) {}

  /** Transport-specific framing of one message. Must not throw for a dead pipe. */
  protected abstract writeMessage(message: JsonRpcMessage): Promise<void> | void;

  /** Transport-specific teardown (kill the process / stop the stream). */
  protected abstract teardown(): void;

  get alive(): boolean {
    return !this.closed;
  }

  /** Feed a raw byte chunk from a newline-delimited transport (stdio, SSE `data:` lines). */
  protected consumeText(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.ingestLine(trimmed);
    }
  }

  /** One complete JSON-RPC frame. */
  protected ingestLine(raw: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Servers print banners, deprecation warnings and logs to stdout all the time.
      // Dropping them silently is right here; keeping the last few is what turns
      // "handshake failed" into an answerable question.
      this.rememberStderr(raw);
      return;
    }
    this.route(parsed);
  }

  /** Whether a request id is still waiting. Transports use this to end a stream cleanly. */
  protected hasPending(id: number): boolean {
    return this.pending.has(id);
  }

  protected rememberStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text + "\n").slice(-STDERR_CAP);
  }

  private route(parsed: JsonRpcMessage): void {
    if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error)) {
      const id = Number(parsed.id);
      const waiting = this.pending.get(id);
      if (!waiting) return; // a response for an already-timed-out request
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      if (parsed.error) {
        waiting.reject(new Error(
          `${this.label}: ${parsed.error.message || "JSON-RPC error"}${
            typeof parsed.error.code === "number" ? ` (code ${parsed.error.code})` : ""}`
        ));
      } else {
        waiting.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method) {
      if (parsed.method === "notifications/progress" || parsed.method === "progress") {
        const token = (parsed.params as any)?.progressToken;
        for (const waiting of this.pending.values()) {
          if (token !== undefined && waiting.token === token) {
            waiting.onProgress?.({
              progress: (parsed.params as any)?.progress,
              total: (parsed.params as any)?.total,
              message: (parsed.params as any)?.message,
            });
            break;
          }
        }
        return;
      }
      this.onNotification?.(parsed.method, (parsed.params || {}) as Record<string, unknown>);
      return;
    }
  }

  /**
   * Send a request and wait for its matching id. The timeout belongs to *this* request,
   * so a slow `tools/call` cannot be killed by a `tools/list` budget or vice versa.
   */
  async request(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<any> {
    if (this.closed) throw new Error(`${this.label}: transport is closed`);
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? MCP_TIMEOUTS.list;

    // A progress token is only useful if it travels in the message the server echoes it
    // back on, per the spec's `_meta` convention.
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    if (options.onProgress) {
      const token = `${id}:${Math.random().toString(36).slice(2, 8)}`;
      payload.params = { ...params, _meta: { ...(params._meta as object || {}), progressToken: token } };
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `${this.label}: "${method}" did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
          `The server is alive but stuck, or needs a longer timeoutMs.`
        ));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        onProgress: options.onProgress,
        token: (payload.params as any)?._meta?.progressToken,
      });

      void Promise.resolve(this.writeMessage(payload)).catch((err: any) => {
        const stuck = this.pending.get(id);
        if (!stuck) return;
        this.pending.delete(id);
        clearTimeout(stuck.timer);
        reject(new Error(`${this.label}: could not send "${method}" — ${err?.message || String(err)}`));
      });
    });
  }

  /** One-way message. A notification cannot be answered, so nothing waits on it. */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) return;
    await this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * The peer is gone. Every in-flight caller learns it now rather than discovering it
   * one timeout at a time, and the exit is reported once with whatever the process said
   * on stderr.
   */
  protected handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    const reason = signal
      ? `terminated by ${signal}`
      : code === 0 ? "exited cleanly" : `exited with code ${code ?? "unknown"}`;
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`${this.label}: ${reason} while "${waiting.method}" was in flight`));
    }
    this.pending.clear();
    if (!this.closeReported) {
      this.closeReported = true;
      this.onExit?.({ code, signal, stderr: this.stderrTail.trim().slice(-2000) });
    }
  }

  /** Close from the caller's side (shutdown, disconnect, replacement). */
  close(): void {
    if (this.closed) return;
    this.teardown();
    this.closed = true;
    this.closeReported = true; // a deliberate shutdown is not a crash worth reporting
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`${this.label}: closed while "${waiting.method}" was in flight`));
    }
    this.pending.clear();
  }
}

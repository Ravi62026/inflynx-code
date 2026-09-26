/**
 * @inflynx/mcp-runtime
 * MCP client: stdio, streamable-HTTP and legacy HTTP+SSE transports, tool discovery,
 * trust-gated connection, and per-turn-safe result capping.
 */

import {
  buildMcpEnvironment,
  computeMcpTrustId,
  isMcpServerTrusted,
  loadMcpConfig,
  saveMcpServerConfig,
  trustMcpServer,
  type McpServerConfig,
  type ResolvedMcpServer,
} from "@inflynx/config";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, type ToolDefinition, type ToolRegistry } from "@inflynx/tool-runtime";
import { HttpMcpSession } from "./http-transport.js";
import { StdioMcpSession } from "./stdio-transport.js";
import { JsonRpcSession, MCP_TIMEOUTS, type SessionExitInfo } from "./json-rpc.js";

export { JsonRpcSession, MCP_TIMEOUTS } from "./json-rpc.js";
export { StdioMcpSession } from "./stdio-transport.js";
export { HttpMcpSession } from "./http-transport.js";

export interface ConnectedMcpServer {
  config: ResolvedMcpServer;
  /**
   * `needs-trust` means the definition came from repository content and nobody has
   * agreed to run it yet. It is not an error and it is not disabled — it is waiting
   * for a human, and the UI must be able to say so accurately.
   */
  status: "connected" | "error" | "disabled" | "needs-trust";
  error?: string;
  tools: ToolDefinition[];
  connectedAt?: number;
  trustId?: string;
  /** What the server said about itself in `initialize`. Displayed by `/mcp list`. */
  serverInfo?: { name: string; version?: string; protocolVersion?: string };
  /** Wire style actually in use, which for a url config is negotiated, not configured. */
  wire?: "stdio" | "streamable-http" | "sse";
  session?: JsonRpcSession;
}

/** Tools this manager has registered, so a dead server's tools can be taken back out. */
interface Registration {
  registry: ToolRegistry;
  names: string[];
}

export interface McpClientManagerOptions {
  /**
   * Override the SSRF guard for url transports. Exists for tests against a loopback
   * server; production callers leave it unset and get `validatePublicUrl`.
   */
  validateUrl?: (raw: string) => Promise<URL>;
}

export class McpClientManager {
  private servers = new Map<string, ConnectedMcpServer>();
  private registrations = new Map<string, Registration>();

  constructor(private readonly options: McpClientManagerOptions = {}) {}

  /**
   * Connect to all configured MCP servers (from ~/.inflynx/mcp.json and project mcp.json).
   *
   * Project-level definitions are repo content, and repo content does not get to decide
   * what runs on the machine: they are skipped until the user trusts the exact command or
   * URL they describe (backlog B6).
   */
  async connectAll(startDir: string = process.cwd()): Promise<ConnectedMcpServer[]> {
    return this.connectConfigs(loadMcpConfig(startDir));
  }

  /**
   * Connect an explicit set of server definitions.
   *
   * The `disabled` and trust gates live **here**, not in `connectAll`, so a caller cannot
   * reach an untrusted repository-defined server by enumerating configs itself — which is
   * exactly what a "just connect this one" entry point would otherwise invite (B6).
   */
  async connectConfigs(configs: ResolvedMcpServer[]): Promise<ConnectedMcpServer[]> {
    const results: ConnectedMcpServer[] = [];

    for (const cfg of configs) {
      if (cfg.disabled) {
        const s: ConnectedMcpServer = { config: cfg, status: "disabled", tools: [] };
        this.servers.set(cfg.id, s);
        results.push(s);
        continue;
      }

      if (!isMcpServerTrusted(cfg)) {
        const untrusted: ConnectedMcpServer = {
          config: cfg,
          status: "needs-trust",
          tools: [],
          trustId: cfg.trustId,
          error:
            `Defined by this repository (${cfg.source} config) and not yet trusted. ` +
            `Run \`/mcp trust ${cfg.id}\` to run it, or remove it from mcp.json.`,
        };
        this.servers.set(cfg.id, untrusted);
        results.push(untrusted);
        continue;
      }

      try {
        const connected = await this.connectServer(cfg);
        this.servers.set(cfg.id, connected);
        results.push(connected);
      } catch (err: any) {
        const failed: ConnectedMcpServer = {
          config: cfg,
          status: "error",
          error: err?.message || String(err),
          tools: [],
        };
        this.servers.set(cfg.id, failed);
        results.push(failed);
      }
    }

    return results;
  }

  /**
   * Register discovered MCP tools into an existing ToolRegistry.
   *
   * Returns the count registered *by this call*, and remembers the mapping so that a
   * server dying later removes exactly its own tools (backlog I3) — a stale tool whose
   * server is gone is worse than no tool, because the model will keep choosing it.
   */
  registerToolsInto(registry: ToolRegistry): number {
    let count = 0;
    for (const [id, server] of this.servers) {
      if (server.status !== "connected" || server.tools.length === 0) continue;
      const names: string[] = [];
      for (const tool of server.tools) {
        registry.register(tool);
        names.push(tool.name);
        count++;
      }
      this.registrations.set(id, { registry, names });
    }
    return count;
  }

  /**
   * Connects a single MCP server over whichever transport its config names, performs the
   * handshake, and discovers its real tool list.
   *
   * For a url server the whole attempt — channel *and* handshake *and* listing — is retried
   * on the other wire style. Negotiating only the channel would be useless, because a
   * streamable endpoint opens successfully and then answers nothing: the mismatch shows up
   * at handshake time, outside the loop. That is the bug the first version of this had.
   */
  private async connectServer(config: ResolvedMcpServer): Promise<ConnectedMcpServer> {
    const serverObj: ConnectedMcpServer = {
      config,
      status: "connected",
      tools: [],
      connectedAt: Date.now(),
      trustId: config.trustId,
    };

    const handleExit = (info: SessionExitInfo) => this.onServerExit(config.id, serverObj, info);

    if (config.transport === "stdio") {
      serverObj.wire = "stdio";
      serverObj.session = StdioMcpSession.start(config, { onExit: handleExit });
      try {
        await this.handshake(serverObj);
        await this.discoverTools(serverObj);
      } catch (err: any) {
        serverObj.session?.close();
        serverObj.session = undefined;
        throw new Error(`MCP stdio server ${config.id} failed to start: ${err?.message || String(err)}`);
      }
      return serverObj;
    }

    const order: Array<"streamable" | "legacy"> =
      config.transport === "sse" ? ["legacy", "streamable"] : ["streamable", "legacy"];
    const failures: string[] = [];

    for (const mode of order) {
      let session: HttpMcpSession | null = null;
      try {
        session = await HttpMcpSession.openChannel(config, mode, {
          onExit: handleExit,
          validateUrl: this.options.validateUrl,
        });
        serverObj.wire = mode === "legacy" ? "sse" : "streamable-http";
        serverObj.session = session;
        serverObj.status = "connected";
        await this.handshake(serverObj);
        await this.discoverTools(serverObj);
        return serverObj;
      } catch (err: any) {
        failures.push(`${mode === "legacy" ? "legacy SSE" : "streamable-http"}: ${err?.message || String(err)}`);
        session?.close();
        serverObj.session = undefined;
        serverObj.tools = [];
        serverObj.serverInfo = undefined;
      }
    }

    throw new Error(
      `MCP HTTP connection failed for ${config.id} — tried ${order.length} wire styles.\n  ` +
      failures.join("\n  ")
    );
  }

  /**
   * `initialize` → `notifications/initialized` → work.
   *
   * The second step is not optional decoration: the MCP spec says a client MUST send it,
   * and servers written to the spec wait for it before answering anything else. Its
   * absence looked like a 10-second timeout on a healthy server (backlog I2).
   */
  private async handshake(server: ConnectedMcpServer): Promise<void> {
    const session = server.session!;
    const clientProtocol = session instanceof HttpMcpSession ? session.clientProtocol : "2025-03-26";
    const init = await session.request("initialize", {
      protocolVersion: clientProtocol,
      capabilities: {},
      clientInfo: { name: "InflynxCode", version: "1.0.0" },
    }, { timeoutMs: MCP_TIMEOUTS.initialize });

    server.serverInfo = {
      name: String(init?.serverInfo?.name || server.config.name || server.config.id),
      version: init?.serverInfo?.version ? String(init.serverInfo.version) : undefined,
      protocolVersion: init?.protocolVersion ? String(init.protocolVersion) : undefined,
    };

    // A server that answers with a version we do not speak is a broken pairing, and
    // saying so beats sending a stream of requests it will interpret differently.
    if (typeof init?.protocolVersion === "string" && !/^20\d\d-\d\d-\d\d$/.test(init.protocolVersion)) {
      throw new Error(`server reported an unrecognised protocolVersion "${init.protocolVersion}"`);
    }

    await session.notify("notifications/initialized", {});
  }

  private async discoverTools(server: ConnectedMcpServer): Promise<void> {
    const session = server.session!;
    const res = await session.request("tools/list", {}, { timeoutMs: MCP_TIMEOUTS.list });
    const mcpTools = Array.isArray(res?.tools) ? res.tools : [];
    server.tools = mcpTools.map((raw: any) => this.mapMcpTool(server, raw));

    // A server that connects and lists nothing is worth saying out loud: "connected,
    // 0 tools" otherwise reads identically to a failure in the UI.
    if (server.tools.length === 0) {
      server.error = "Connected, but the server advertised no tools.";
    }
  }

  /**
   * One discovered MCP tool, as a registry definition.
   *
   * `readOnlyHint` is *not* believed. A remote annotation is the server grading its own
   * homework, and the MCP spec says so explicitly; anything remote is treated as
   * mutating and goes through approval (backlog B9).
   */
  private mapMcpTool(server: ConnectedMcpServer, raw: any): ToolDefinition {
    const serverId = server.config.id;
    const name = String(raw?.name || "");
    const qualifiedName = `mcp__${serverId}__${name}`;
    const callTimeoutMs = server.config.timeoutMs ?? MCP_TIMEOUTS.call;

    return {
      name: qualifiedName,
      description: `[MCP: ${serverId}] ${raw.description || name}`,
      permissionLevel: "readwrite",
      isMutating: true,
      origin: "mcp",
      serverName: serverId,
      parameters: raw.inputSchema || { type: "object", properties: {}, required: [] },
      execute: async (args) => {
        const session = server.session;
        if (!session || !session.alive) {
          return {
            output:
              `Error: MCP server "${serverId}" is not connected anymore, so "${name}" cannot run. ` +
              `Its tools were unregistered when it exited; if this call is still reaching the tool, ` +
              `reconnect the server rather than retrying.`,
            isError: true,
          };
        }
        // An abort signal that outranks the tool's own budget: a cancelled turn should not
        // wait two minutes to find out that nothing is listening anymore.
        const result = await session.request("tools/call", { name, arguments: args }, {
          timeoutMs: callTimeoutMs,
        });

        return { output: renderMcpCallResult(serverId, name, result), isError: Boolean(result?.isError) };
      },
    };
  }

  /**
   * A server process or stream went away. Mark it, say why with whatever it wrote on
   * stderr, and take its tools out of the registry — otherwise every later call hangs
   * until its timeout and the model has no way to learn that the server is dead.
   */
  private onServerExit(id: string, server: ConnectedMcpServer, info: SessionExitInfo): void {
    const isProcess = server.wire === "stdio";
    const why = info.signal
      ? `was terminated by ${info.signal}`
      : info.code === 0 ? (isProcess ? "exited cleanly" : "closed cleanly")
      : isProcess ? `exited with code ${info.code ?? "unknown"}`
      : `connection was closed${info.code != null ? ` (code ${info.code})` : ""}`;
    server.status = "error";
    server.error = `MCP server ${isProcess ? "process" : "stream"} ${why}.` + (info.stderr ? `\nLast output:\n${info.stderr}` : "");
    server.session = undefined;
    server.tools = [];

    const registration = this.registrations.get(id);
    if (registration) {
      for (const toolName of registration.names) registration.registry.unregister(toolName);
      this.registrations.delete(id);
    }
    console.warn(`[mcp] server "${id}" ${why} — ${registration?.names.length ?? 0} tool(s) unregistered`);
  }

  /** Summary list of all servers. */
  listServers(): ConnectedMcpServer[] {
    return Array.from(this.servers.values());
  }

  getServer(id: string): ConnectedMcpServer | undefined {
    return this.servers.get(id);
  }

  /**
   * Reconnect one server by id — after `/mcp trust` grants it, or after it died and the
   * user wants its tools back. Goes through the same gate as everything else, so a
   * revoked grant cannot be resurrected through this path either.
   */
  async reconnect(id: string): Promise<ConnectedMcpServer | null> {
    const existing = this.servers.get(id);
    if (!existing) return null;
    const [reconnected] = await this.connectConfigs([existing.config]);
    return reconnected ?? null;
  }

  /**
   * Saves a new MCP server to .inflynx/mcp.json and connects it.
   *
   * The caller is expected to have built `config` from a string the *user* typed or
   * confirmed — which is why writing the file and granting trust happen here and only
   * here. The model must not be able to reach this method by way of `write_file`, so
   * `/mcp add` keeps the proposal in chat and only calls this after a confirmation
   * (backlog B6). Trust is recorded for the exact command line or URL being saved, so a
   * later edit needs a fresh yes.
   */
  async addServer(config: McpServerConfig, startDir: string = process.cwd()): Promise<ConnectedMcpServer> {
    saveMcpServerConfig(config, startDir);
    const resolved: ResolvedMcpServer = {
      ...config,
      name: config.name || config.id,
      source: "project",
      trustId: computeMcpTrustId(config),
      disabled: config.disabled ?? false,
    };
    trustMcpServer(resolved, `added via /mcp add on ${new Date().toISOString()}`);
    // One enforcement path for every connection, so "I just trusted it" cannot be a way
    // of skipping the check that decides whether it may run.
    const [connected] = await this.connectConfigs([resolved]);
    return connected;
  }

  /** Re-read one server's tool list without reconnecting (a server may support it). */
  async refreshTools(id: string): Promise<number> {
    const server = this.servers.get(id);
    if (!server || server.status !== "connected" || !server.session) return 0;
    await this.discoverTools(server);
    const registration = this.registrations.get(id);
    if (registration) {
      const names = server.tools.map((t) => t.name);
      for (const stale of registration.names.filter((n) => !names.includes(n))) {
        registration.registry.unregister(stale);
      }
      for (const tool of server.tools) registration.registry.register(tool);
      registration.names = names;
    }
    return server.tools.length;
  }

  /** Gracefully terminate every subprocess and close every stream. */
  disconnectAll(): void {
    for (const server of this.servers.values()) {
      server.session?.close();
    }
    this.registrations.clear();
    this.servers.clear();
  }
}

/**
 * Flatten an MCP `tools/call` result into text, capped.
 *
 * Two bugs lived here before: results were injected untruncated (backlog I4), and
 * non-`text` content blocks were `JSON.stringify`'d with no note — so an image or a
 * resource link arrived as raw base64 inside the model's context. The cap is the same
 * budget the other tools use, and exceeding it is *said* rather than silently applied.
 */
export function renderMcpCallResult(serverId: string, toolName: string, result: any): string {
  const cap = DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];

  if (blocks.length === 0) {
    const fallback = typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
    return capText(fallback, cap, "result");
  }

  const parts: string[] = [];
  let dropped = 0;
  let bytes = 0;
  for (const block of blocks) {
    let rendered: string;
    if (block?.type === "text") {
      rendered = String(block.text ?? "");
    } else if (block?.type === "image") {
      // The bytes are for a UI, not for a prompt. Saying what was skipped keeps the model
      // from concluding the tool returned nothing.
      rendered = `[image from ${serverId}/${toolName}: ${block.mimeType || "unknown type"}, not rendered in the text stream]`;
    } else if (block?.type === "resource" || block?.type === "resource_link") {
      const ref = block?.resource?.uri || block?.uri || "(no uri)";
      rendered = `[resource from ${serverId}/${toolName}: ${ref}]`;
    } else {
      rendered = `[${block?.type || "unknown"} content from ${serverId}/${toolName}]`;
    }
    if (bytes + rendered.length > cap) {
      dropped++;
      continue;
    }
    bytes += rendered.length;
    parts.push(rendered);
  }

  let text = parts.join("\n");
  if (dropped > 0) {
    text += `\n\n... ${dropped} further content block(s) omitted: the ${cap.toLocaleString()}-character budget for one tool result was spent. Narrow the request or ask for less data.`;
  }
  if (result?.isError) {
    text = `MCP tool "${toolName}" reported an error:\n${text}`;
  }
  return text || `(empty result from ${serverId}/${toolName})`;
}

function capText(text: string, cap: number, what: string): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n... ${what} truncated at ${cap.toLocaleString()} characters.`;
}

/** Environment builder is re-exported so tests assert against the same function used here. */
export { buildMcpEnvironment };

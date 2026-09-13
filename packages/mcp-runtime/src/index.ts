/**
 * @inflynx/mcp-runtime
 * Stdio and SSE Transport Runtime for Model Context Protocol (MCP) tool discovery & execution.
 */

import { spawn, type ChildProcess } from "child_process";
import { loadMcpConfig, saveMcpServerConfig, type McpServerConfig } from "@inflynx/config";
import { CommandPolicy, validatePublicUrl } from "@inflynx/policy-engine";
import type { ToolDefinition, ToolRegistry } from "@inflynx/tool-runtime";

export interface ConnectedMcpServer {
  config: McpServerConfig;
  status: "connected" | "error" | "disabled";
  error?: string;
  process?: ChildProcess;
  tools: ToolDefinition[];
  connectedAt?: number;
}

export class McpClientManager {
  private servers = new Map<string, ConnectedMcpServer>();
  private reqIdCounter = 1;

  /**
   * Connect to all configured MCP servers (from ~/.inflynx/mcp.json and project mcp.json).
   */
  async connectAll(startDir: string = process.cwd()): Promise<ConnectedMcpServer[]> {
    const configs = loadMcpConfig(startDir);
    const results: ConnectedMcpServer[] = [];

    for (const cfg of configs) {
      if (cfg.disabled) {
        const s: ConnectedMcpServer = { config: cfg, status: "disabled", tools: [] };
        this.servers.set(cfg.id, s);
        results.push(s);
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
   * Register all discovered MCP tools into an existing ToolRegistry.
   */
  registerToolsInto(registry: ToolRegistry): number {
    let count = 0;
    for (const server of this.servers.values()) {
      if (server.status === "connected") {
        for (const tool of server.tools) {
          registry.register(tool);
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Connects a single MCP server over Stdio or SSE transport protocol.
   */
  private async connectServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
    if (config.transport === "stdio") {
      return await this.connectStdioServer(config);
    } else {
      return await this.connectSseServer(config);
    }
  }

  private async connectStdioServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
    if (!config.command) {
      throw new Error(`MCP Stdio server "${config.id}" is missing 'command' setting.`);
    }

    const parsedCommand = CommandPolicy.parseCommandToArgs(config.command);
    const env = { ...process.env, ...(config.env || {}) };
    const proc = spawn(parsedCommand.executable, [...parsedCommand.args, ...(config.args || [])], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const serverObj: ConnectedMcpServer = {
      config,
      status: "connected",
      process: proc,
      tools: [],
      connectedAt: Date.now(),
    };

    // Buffer for JSON-RPC messages over stdin/stdout
    let stdoutBuffer = "";
    const pendingResponses = new Map<number, (res: any) => void>();

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id && pendingResponses.has(parsed.id)) {
            const cb = pendingResponses.get(parsed.id);
            pendingResponses.delete(parsed.id);
            cb?.(parsed);
          }
        } catch {
          // ignore non-JSON stdout outputs from subprocess
        }
      }
    });

    proc.on("error", (err) => {
      serverObj.status = "error";
      serverObj.error = err.message;
    });

    const sendJsonRpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      return new Promise((resolve, reject) => {
        const id = this.reqIdCounter++;
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

        const timeout = setTimeout(() => {
          pendingResponses.delete(id);
          reject(new Error(`MCP JSON-RPC request timeout (${method})`));
        }, 10_000);

        pendingResponses.set(id, (res) => {
          clearTimeout(timeout);
          if (res.error) {
            reject(new Error(res.error.message || `MCP Error ${res.error.code}`));
          } else {
            resolve(res.result);
          }
        });

        if (!proc.stdin?.writable) {
          clearTimeout(timeout);
          pendingResponses.delete(id);
          reject(new Error(`Subprocess stdin is not writable for ${config.id}`));
          return;
        }

        proc.stdin.write(payload);
      });
    };

    // Perform MCP initialization handshake
    try {
      await sendJsonRpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "InflynxCode", version: "1.0.0" },
      });

      // Fetch tools/list
      const toolListRes = await sendJsonRpc("tools/list", {});
      const mcpTools = Array.isArray(toolListRes?.tools) ? toolListRes.tools : [];

      serverObj.tools = mcpTools.map((rawTool: any) =>
        this.mapMcpToolToDefinition(config.id, rawTool, sendJsonRpc)
      );

      return serverObj;
    } catch (err: any) {
      proc.kill("SIGTERM");
      throw new Error(`MCP handshake failed for ${config.id}: ${err?.message || String(err)}`);
    }
  }

  private async connectSseServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
    if (!config.url) {
      throw new Error(`MCP SSE server "${config.id}" is missing 'url' setting.`);
    }

    // Basic SSE endpoint probe for tools
    try {
      const publicUrl = await validatePublicUrl(config.url);
      const res = await fetch(publicUrl, {
        headers: { "Accept": "application/json, text/event-stream" },
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400) {
        throw new Error("Redirects are disabled by SSRF protection; configure the final public endpoint.");
      }
      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      }

      const serverObj: ConnectedMcpServer = {
        config,
        status: "connected",
        tools: [],
        connectedAt: Date.now(),
      };

      // Mock tool definition for SSE probe endpoint
      serverObj.tools = [
        {
          name: `mcp__${config.id}__fetch`,
          description: `Query remote MCP SSE endpoint ${config.url}`,
          permissionLevel: "readonly",
          origin: "mcp",
          serverName: config.id,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query or API method" },
            },
            required: ["query"],
          },
          execute: async (args) => {
            const endpoint = await validatePublicUrl(config.url!);
            endpoint.searchParams.set("query", String(args.query));
            const fetchRes = await fetch(endpoint, { redirect: "manual" });
            if (fetchRes.status >= 300 && fetchRes.status < 400) {
              throw new Error("Redirects are disabled by SSRF protection.");
            }
            return await fetchRes.text();
          },
        },
      ];

      return serverObj;
    } catch (err: any) {
      throw new Error(`MCP SSE connection failed for ${config.id}: ${err?.message || String(err)}`);
    }
  }

  private mapMcpToolToDefinition(
    serverId: string,
    rawTool: any,
    sendJsonRpc: (method: string, params: Record<string, unknown>) => Promise<any>
  ): ToolDefinition {
    const qualifiedName = `mcp__${serverId}__${rawTool.name}`;
    const params = rawTool.inputSchema || {
      type: "object",
      properties: {},
      required: [],
    };

    return {
      name: qualifiedName,
      description: `[MCP: ${serverId}] ${rawTool.description || rawTool.name}`,
      permissionLevel: rawTool.annotations?.readOnlyHint ? "readonly" : "readwrite",
      isMutating: !rawTool.annotations?.readOnlyHint,
      origin: "mcp",
      serverName: serverId,
      parameters: params,
      execute: async (args) => {
        const result = await sendJsonRpc("tools/call", {
          name: rawTool.name,
          arguments: args,
        });

        if (Array.isArray(result?.content)) {
          return result.content
            .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        }

        return typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
      },
    };
  }

  /**
   * Returns summary list of all servers.
   */
  listServers(): ConnectedMcpServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Saves a new MCP server to .inflynx/mcp.json and connects it.
   */
  async addServer(config: McpServerConfig, startDir: string = process.cwd()): Promise<ConnectedMcpServer> {
    saveMcpServerConfig(config, startDir);
    const connected = await this.connectServer(config);
    this.servers.set(config.id, connected);
    return connected;
  }

  /**
   * Gracefully terminate all subprocesses.
   */
  disconnectAll(): void {
    for (const server of this.servers.values()) {
      if (server.process && !server.process.killed) {
        server.process.kill("SIGTERM");
      }
    }
    this.servers.clear();
  }
}

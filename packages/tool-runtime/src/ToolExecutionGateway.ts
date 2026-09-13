import { checkRateLimit } from "@inflynx/cache";
import { CanonicalPathGuard, CommandPolicy, validatePublicUrl } from "@inflynx/policy-engine";
import { ToolRegistry, executeTool, type ToolCall, type ToolResult, type ToolDefinition } from "./index.js";

export interface GatewayExecutionOptions {
  activeMode?: "ask" | "plan" | "agent" | "debug";
  maxTimeoutMs?: number;
  /** Stable caller/session identity used to isolate Redis tool buckets. */
  sessionId?: string;
  toolRateLimit?: {
    limit: number;
    windowSec: number;
  };
}

/**
 * @inflynx/tool-runtime — ToolExecutionGateway
 * 
 * Centralized tool execution gateway that enforces security policy,
 * canonical path boundaries, shell command rules, and mode permissions
 * before tool invocation.
 */
export class ToolExecutionGateway {
  private pathGuard: CanonicalPathGuard;

  constructor(workspaceRoot: string = process.cwd()) {
    this.pathGuard = new CanonicalPathGuard(workspaceRoot);
  }

  /**
   * Returns the canonical path guard associated with this gateway.
   */
  getPathGuard(): CanonicalPathGuard {
    return this.pathGuard;
  }

  /**
   * Executes a tool call through central policy validation gates.
   */
  async executeGuarded(
    registry: ToolRegistry,
    call: ToolCall,
    options: GatewayExecutionOptions = {},
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const startMs = Date.now();
    const mode = options.activeMode || "agent";
    const tool = registry.get(call.name);

    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Security/Runtime Error: Unknown tool "${call.name}"`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // 1. Enforce Mode Permissions
    if (mode === "ask" && (tool.isMutating || tool.permissionLevel === "shell")) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Security Policy Violation: Tool "${call.name}" is blocked in [ask] mode (read-only mode).`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    if (mode === "plan" && tool.permissionLevel === "shell") {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Security Policy Violation: Shell tool "${call.name}" is blocked in [plan] mode.`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // Shell, network, and MCP tools are the highest-risk/highest-cost tool
    // classes. Apply a Redis-backed bucket before any external side effect.
    // The cache package fails open when Redis is unavailable, preserving the
    // local CLI fallback behavior without bypassing the check when Redis
    // is healthy.
    if (
      tool.permissionLevel === "shell" ||
      tool.origin === "mcp" ||
      tool.name === "web_search" ||
      tool.name === "fetch_url"
    ) {
      const rateLimit = options.toolRateLimit || { limit: 30, windowSec: 60 };
      const bucket = await checkRateLimit(
        `tool:${options.sessionId || "anonymous"}:${tool.name}`,
        rateLimit.limit,
        rateLimit.windowSec
      );
      if (!bucket.allowed) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          output:
            `Security Policy Rate Limit: Tool "${call.name}" exceeded ` +
            `${bucket.limit} calls in ${rateLimit.windowSec}s. Retry in ${bucket.resetInSec}s.`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
    }

    // 2. Validate Path Arguments via CanonicalPathGuard
    const args = { ...call.args };
    const pathKeys = ["path", "filePath", "targetFile", "target_file", "cwd", "dirPath"];

    for (const key of pathKeys) {
      if (typeof args[key] === "string" && args[key]) {
        try {
          args[key] = this.pathGuard.validateAndResolve(args[key] as string);
        } catch (err: any) {
          return {
            toolCallId: call.id,
            toolName: call.name,
            output: `Security Policy Violation (${key}): ${err.message}`,
            isError: true,
            durationMs: Date.now() - startMs,
          };
        }
      }
    }

    // Validate explicit network destinations as well. MCP tools and future
    // network-capable tools may expose a `url` argument even when they are not
    // one of the built-in web tools.
    if (typeof args.url === "string" && args.url) {
      try {
        args.url = (await validatePublicUrl(args.url)).toString();
      } catch (err: any) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          output: `Security Policy Violation (url): ${err.message}`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
    }

    // 3. Validate Shell Commands via CommandPolicy
    if (tool.permissionLevel === "shell" || call.name === "execute_shell") {
      const commandStr = String(args.command || args.cmd || "");
      if (commandStr) {
        try {
          CommandPolicy.validateShellCommand(commandStr);
        } catch (err: any) {
          return {
            toolCallId: call.id,
            toolName: call.name,
            output: err.message,
            isError: true,
            durationMs: Date.now() - startMs,
          };
        }
      }
    }

    // 4. Delegate to tool execution with updated guarded args
    return await executeTool(registry, { ...call, args }, signal);
  }
}

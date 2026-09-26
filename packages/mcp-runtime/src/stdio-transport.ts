/**
 * stdio MCP transport.
 *
 * Framing is newline-delimited JSON-RPC over the child's stdin/stdout, so this class is
 * mostly about the *process*: what happens when it cannot be spawned, when it writes
 * garbage to stdout, when it forks children of its own, and when it dies mid-request.
 *
 * The child is spawned `detached` and signalled by process **group**. Without that, an
 * `npx some-mcp-server` leaves the real server running after we kill the wrapper — which
 * is the same orphan bug the shell tool had (backlog Phase 20/21), arriving through a
 * different door.
 */

import { spawn, type ChildProcess } from "child_process";
import { buildMcpEnvironment, type ResolvedMcpServer } from "@inflynx/config";
import { CommandPolicy } from "@inflynx/policy-engine";
import { JsonRpcSession, type JsonRpcMessage, type SessionExitInfo } from "./json-rpc.js";

export interface StdioSessionHandlers {
  onExit?: (info: SessionExitInfo) => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
}

export class StdioMcpSession extends JsonRpcSession {
  private constructor(
    private readonly proc: ChildProcess,
    label: string,
    handlers: StdioSessionHandlers
  ) {
    super(label, handlers.onExit, handlers.onNotification);

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.consumeText(chunk));

    // stderr is where a server explains itself. The previous implementation attached no
    // listener at all, so a crash was silent and "handshake failed" was the whole story.
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => this.rememberStderr(chunk));

    proc.on("exit", (code, signal) => this.handleClose(code, signal));
    proc.on("error", (err: any) => {
      // ENOENT/EACCES arrive here rather than as an exit, and the message is the useful
      // part: "server exited" tells nobody that the command was not found.
      this.rememberStderr(`spawn error: ${err?.message || String(err)}`);
      this.handleClose(null, null);
    });
  }

  /**
   * Spawn and wire the session. Does not perform the handshake — that is the same code
   * for every transport and lives in the client.
   */
  static start(config: ResolvedMcpServer, handlers: StdioSessionHandlers = {}): StdioMcpSession {
    if (!config.command) {
      throw new Error(`MCP server "${config.id}" is a stdio server with no command.`);
    }
    const parsed = CommandPolicy.parseCommandToArgs(config.command);
    // Not `{ ...process.env }` — that handed every credential the CLI holds to a process
    // that may have been defined by a repository someone else wrote (backlog B5).
    const env = buildMcpEnvironment(config);
    const useGroup = process.platform !== "win32";

    let proc: ChildProcess;
    try {
      proc = spawn(parsedCommand(parsed.executable), [...parsed.args, ...(config.args || [])], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: useGroup,
      });
    } catch (err: any) {
      throw new Error(
        `Could not spawn MCP server "${config.id}": ${err?.message || String(err)}`
      );
    }
    const label = `MCP stdio server "${config.id}"`;
    return new StdioMcpSession(proc, label, handlers);
  }

  /** The child's pid, for status output and for group signalling. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  protected writeMessage(message: JsonRpcMessage): void {
    if (!this.proc.stdin?.writable) {
      throw new Error("stdin is closed — the server process has already gone");
    }
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  protected teardown(): void {
    const pid = this.proc.pid;
    try {
      if (pid && process.platform !== "win32") {
        // Negative pid = the whole group, so a wrapper's children go with it.
        process.kill(-pid, "SIGTERM");
      } else if (!this.proc.killed) {
        this.proc.kill("SIGTERM");
      }
    } catch {
      try { if (!this.proc.killed) this.proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
}

/** `npx` on Windows is `npx.cmd`; spawning the bare name fails there. */
function parsedCommand(executable: string): string {
  if (process.platform === "win32" && /^(npx|npm|node)$/.test(executable)) return `${executable}.cmd`;
  return executable;
}

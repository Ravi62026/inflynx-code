import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { InflynxService } from "./InflynxService.js";

export class ServerManager {
  private childProcess: ChildProcess | null = null;
  private outputChannel: vscode.OutputChannel;
  private isStarting = false;

  constructor(
    private readonly service: InflynxService,
    private readonly context: vscode.ExtensionContext
  ) {
    this.outputChannel = vscode.window.createOutputChannel("Inflynx Server");
    context.subscriptions.push(this.outputChannel);
  }

  async ensureServerRunning(): Promise<boolean> {
    const health = await this.service.checkHealth();
    if (health) {
      return true;
    }

    const config = vscode.workspace.getConfiguration("inflynx");
    const autoStart = config.get<boolean>("autoStartServer", true);

    if (!autoStart) {
      vscode.window
        .showWarningMessage(
          `Inflynx backend server is not running at ${this.service.getServerUrl()}.`,
          "Start Server",
          "Open Settings"
        )
        .then((choice) => {
          if (choice === "Start Server") {
            this.startServer();
          } else if (choice === "Open Settings") {
            vscode.commands.executeCommand("workbench.action.openSettings", "inflynx");
          }
        });
      return false;
    }

    return await this.startServer();
  }

  async startServer(): Promise<boolean> {
    if (this.isStarting) return false;
    if (this.childProcess) {
      const health = await this.service.checkHealth();
      if (health) return true;
    }

    this.isStarting = true;
    this.outputChannel.appendLine(`[Inflynx] Attempting to launch backend server...`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    // Look for server entrypoint
    let serverScript: string | null = null;
    const candidates = [
      path.join(workspaceRoot, "apps", "server", "dist", "index.js"),
      path.join(workspaceRoot, "apps", "server", "src", "index.ts"),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        serverScript = c;
        break;
      }
    }

    if (!serverScript) {
      this.outputChannel.appendLine(
        `[Inflynx] Server entry point not found in workspace. Expected at apps/server/dist/index.js`
      );
      this.isStarting = false;
      return false;
    }

    const isTypeScript = serverScript.endsWith(".ts");
    const port = this.resolveServerPort();
    const launch = this.resolveLaunch(workspaceRoot, serverScript, isTypeScript);

    try {
      this.outputChannel.appendLine(
        `[Inflynx] Spawning: ${launch.command} ${launch.args.join(" ")} in ${workspaceRoot} (port ${port})`
      );
      this.childProcess = spawn(launch.command, launch.args, {
        cwd: workspaceRoot,
        // PORT was previously hard-coded to "4000", so pointing `inflynx.serverUrl`
        // at another port made the extension poll one port while the server bound
        // another. HOST is pinned to loopback to match the server's local-first
        // default (backlog Phase 2).
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        // No shell: `shell: true` handed the workspace path to a shell, so a path
        // containing `$`, backticks or quotes could be interpreted, not quoted.
        shell: false,
        // Own process group so stopServer() can reap the tree; killing `pnpm` alone
        // left the `node` grandchild orphaned and still bound to the port (J10).
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.childProcess.stdout?.on("data", (chunk) => {
        this.outputChannel.append(chunk.toString());
      });

      this.childProcess.stderr?.on("data", (chunk) => {
        this.outputChannel.append(chunk.toString());
      });

      this.childProcess.on("exit", (code, signal) => {
        this.outputChannel.appendLine(`[Inflynx] Server process exited with code ${code} (${signal})`);
        this.childProcess = null;
      });

      // Spawn failures (e.g. `pnpm` not on PATH) surface as an async 'error'
      // event, which the surrounding try/catch cannot see — unhandled, it would
      // throw out of the extension host.
      this.childProcess.on("error", (err) => {
        this.outputChannel.appendLine(`[Inflynx] Failed to launch server: ${err.message}`);
        this.childProcess = null;
        this.isStarting = false;
      });

      // Poll health check for up to 10 seconds
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        await new Promise((r) => setTimeout(r, 600));
        const health = await this.service.checkHealth();
        if (health) {
          this.outputChannel.appendLine(`[Inflynx] Server is UP and healthy!`);
          this.isStarting = false;
          vscode.window.showInformationMessage("Inflynx backend server connected successfully.");
          return true;
        }
      }

      this.outputChannel.appendLine(`[Inflynx] Timed out waiting for server to respond on /health.`);
      this.isStarting = false;
      return false;
    } catch (err: any) {
      this.outputChannel.appendLine(`[Inflynx] Failed to launch server: ${err?.message}`);
      this.isStarting = false;
      return false;
    }
  }

  stopServer(): void {
    if (this.childProcess) {
      this.outputChannel.appendLine(`[Inflynx] Terminating server process group...`);
      this.killTree(this.childProcess);
      this.childProcess = null;
      vscode.window.showInformationMessage("Inflynx server stopped.");
    }
  }

  /**
   * Kill the whole process group (`detached: true` gave us a negative pid).
   * Falls back to killing the direct child if the group is already gone.
   */
  private killTree(child: ChildProcess): void {
    if (child.pid === undefined) {
      child.kill("SIGTERM");
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
  }

  /** Port the extension actually talks to — derived from `inflynx.serverUrl`. */
  private resolveServerPort(): number {
    try {
      const parsed = new URL(this.service.getServerUrl());
      if (parsed.port) return Number(parsed.port);
    } catch {
      // fall through
    }
    return 4000;
  }

  /**
   * Resolve a real executable + argument array. Never a shell string, so the
   * workspace path can never be re-interpreted by a shell.
   */
  private resolveLaunch(
    workspaceRoot: string,
    serverScript: string,
    isTypeScript: boolean
  ): { command: string; args: string[] } {
    if (!isTypeScript) {
      // Built `dist/index.js`: run it on the very Node binary the extension host is
      // already using — no PATH lookup, no shell, works identically everywhere.
      return { command: process.execPath, args: [serverScript] };
    }

    // Source-only dev fallback: exec tsx's own JS entry through node, resolved via
    // the .bin symlink. If that isn't resolvable (e.g. the Windows .cmd shim) we
    // fall back to the package manager, which is still an argument array, no shell.
    const binName = process.platform === "win32" ? "tsx.cmd" : "tsx";
    for (const bin of [
      path.join(workspaceRoot, "node_modules", ".bin", binName),
      path.join(workspaceRoot, "apps", "server", "node_modules", ".bin", binName),
    ]) {
      try {
        if (fs.existsSync(bin)) {
          const real = fs.realpathSync(bin);
          if (/\.[cm]?js$/.test(real)) {
            return { command: process.execPath, args: [real, serverScript] };
          }
        }
      } catch {
        // Unresolvable symlink — try the next candidate.
      }
    }

    return {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["--filter", "inflynx-server", "run", "dev"],
    };
  }

  async restartServer(): Promise<void> {
    this.stopServer();
    await new Promise((r) => setTimeout(r, 1000));
    await this.startServer();
  }

  dispose(): void {
    if (this.childProcess) {
      this.killTree(this.childProcess);
      this.childProcess = null;
    }
  }
}

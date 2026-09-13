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
    const cmd = isTypeScript ? "pnpm" : "node";
    const args = isTypeScript ? ["--filter", "inflynx-server", "run", "dev"] : [serverScript];

    try {
      this.outputChannel.appendLine(`[Inflynx] Spawning: ${cmd} ${args.join(" ")} in ${workspaceRoot}`);
      this.childProcess = spawn(cmd, args, {
        cwd: workspaceRoot,
        env: { ...process.env, PORT: "4000" },
        shell: true,
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
      this.outputChannel.appendLine(`[Inflynx] Terminating server process...`);
      this.childProcess.kill("SIGTERM");
      this.childProcess = null;
      vscode.window.showInformationMessage("Inflynx server stopped.");
    }
  }

  async restartServer(): Promise<void> {
    this.stopServer();
    await new Promise((r) => setTimeout(r, 1000));
    await this.startServer();
  }

  dispose(): void {
    if (this.childProcess) {
      this.childProcess.kill("SIGTERM");
      this.childProcess = null;
    }
  }
}

import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import type { InflynxService } from "./InflynxService.js";
import type { ApprovalManager } from "./ApprovalManager.js";
import type { FromWebviewMessage, ToWebviewMessage } from "./types.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "inflynx.chatView";
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: InflynxService,
    private readonly approvalManager: ApprovalManager
  ) {
    this.registerServiceEvents();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: FromWebviewMessage) => {
      this.handleWebviewMessage(message);
    });
  }

  private registerServiceEvents(): void {
    this.service.on("turn.started", (prompt: string) => {
      this.postMessage({ type: "turn.started", payload: { prompt } });
    });

    this.service.on("model.thought_delta", (delta: string) => {
      this.postMessage({ type: "model.thought_delta", payload: { delta } });
    });

    this.service.on("model.text_delta", (delta: string) => {
      this.postMessage({ type: "model.text_delta", payload: { delta } });
    });

    this.service.on("tool.proposed", (payload) => {
      this.postMessage({ type: "tool.proposed", payload });
    });

    this.service.on("tool.approval_required", (payload) => {
      this.postMessage({ type: "tool.approval_required", payload });
    });

    this.service.on("tool.approved", (payload) => {
      this.postMessage({ type: "tool.approved", payload });
    });

    this.service.on("tool.started", (payload) => {
      this.postMessage({ type: "tool.started", payload });
    });

    this.service.on("tool.output", (payload) => {
      this.postMessage({ type: "tool.output", payload });
    });

    this.service.on("turn.completed", (payload) => {
      this.postMessage({ type: "turn.completed", payload });
    });

    this.service.on("turn.failed", (error: string) => {
      this.postMessage({ type: "turn.failed", payload: { error } });
    });

    this.service.on("connected", (health) => {
      this.postMessage({
        type: "server.status",
        payload: { connected: true, url: this.service.getServerUrl(), health },
      });
    });

    this.service.on("disconnected", () => {
      this.postMessage({
        type: "server.status",
        payload: { connected: false, url: this.service.getServerUrl() },
      });
    });
  }

  private async handleWebviewMessage(message: FromWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready": {
        // Send initial state to webview
        const config = vscode.workspace.getConfiguration("inflynx");
        this.postMessage({
          type: "config.updated",
          payload: {
            autoApproveReadonly: config.get<boolean>("autoApproveReadonly", true),
            autoApproveAll: config.get<boolean>("autoApproveAll", false),
            showThinking: config.get<boolean>("showThinking", true),
            theme: config.get<string>("theme", "auto"),
          },
        });

        this.postMessage({
          type: "server.status",
          payload: {
            connected: this.service.getIsConnected(),
            url: this.service.getServerUrl(),
          },
        });

        // If there's an active session, hydrate it
        const currentSessionId = this.service.getCurrentSessionId();
        if (currentSessionId) {
          try {
            const hydration = await this.service.getSessionHydration(currentSessionId);
            this.postMessage({ type: "session.loaded", payload: hydration });
          } catch {
            // ignore
          }
        }
        break;
      }

      case "send.prompt": {
        try {
          await this.service.sendPrompt(message.payload.prompt);
        } catch (err: any) {
          console.error("[Inflynx ChatView] Error sending prompt:", err);
          this.postMessage({
            type: "turn.failed",
            payload: { error: err?.message || String(err) },
          });
        }
        break;
      }

      case "abort.turn": {
        await this.service.abortTurn();
        this.postMessage({ type: "turn.cancelled" });
        break;
      }

      case "create.session": {
        try {
          const session = await this.service.createSession(message.payload);
          this.postMessage({
            type: "session.loaded",
            payload: { session, messages: [] },
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to create session: ${err?.message}`);
        }
        break;
      }

      case "resume.session": {
        try {
          const hydration = await this.service.getSessionHydration(message.payload.sessionId);
          this.postMessage({ type: "session.loaded", payload: hydration });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to resume session: ${err?.message}`);
        }
        break;
      }

      case "approve.tool": {
        await this.approvalManager.resolveApprovalFromWebview(
          message.payload.toolCallId,
          message.payload.approved
        );
        break;
      }

      case "set.mode": {
        this.service.setCurrentMode(message.payload.mode);
        this.postMessage({ type: "mode.changed", payload: { mode: message.payload.mode } });
        break;
      }

      case "set.model": {
        this.service.setCurrentModel(message.payload.model, message.payload.provider);
        this.postMessage({
          type: "model.changed",
          payload: { model: message.payload.model, provider: message.payload.provider || "openrouter" },
        });
        break;
      }

      case "set.budget": {
        this.service.setCurrentBudget(message.payload.budget);
        break;
      }

      case "open.file": {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const fullPath = path.isAbsolute(message.payload.filePath)
          ? message.payload.filePath
          : path.join(workspaceRoot, message.payload.filePath);

        if (fs.existsSync(fullPath)) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
          const line = Math.max(0, (message.payload.line || 1) - 1);
          await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(line, 0, line, 0),
          });
        }
        break;
      }

      case "copy.clipboard": {
        await vscode.env.clipboard.writeText(message.payload.text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        break;
      }

      case "request.models": {
        try {
          const catalog = await this.service.getModels();
          this.postMessage({ type: "models.loaded", payload: catalog });
        } catch {
          // ignore
        }
        break;
      }

      case "request.sessions": {
        try {
          const sessions = await this.service.listSessions();
          this.postMessage({ type: "session.list", payload: sessions });
        } catch {
          // ignore
        }
        break;
      }
    }
  }

  sendPromptFromExtension(prompt: string): void {
    this.postMessage({ type: "turn.started", payload: { prompt } });
    this.service.sendPrompt(prompt).catch((err) => {
      console.error("[Inflynx ChatView] Error running prompt from extension:", err);
    });
  }

  reload(): void {
    if (this._view) {
      this._view.webview.html = this.getHtmlForWebview(this._view.webview);
    }
  }

  postMessage(message: ToWebviewMessage): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.css")
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>Inflynx Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

import * as vscode from "vscode";
import { InflynxService } from "./InflynxService.js";
import { ApprovalManager } from "./ApprovalManager.js";
import { ServerManager } from "./ServerManager.js";
import { StatusBarManager } from "./StatusBarManager.js";
import { ChatViewProvider } from "./ChatViewProvider.js";
import { SessionTreeProvider } from "./trees/SessionTreeProvider.js";
import { PlanTreeProvider } from "./trees/PlanTreeProvider.js";
import { ToolsTreeProvider } from "./trees/ToolsTreeProvider.js";
import { DiffDecorationProvider } from "./DiffDecorationProvider.js";
import { DiagnosticsProvider } from "./DiagnosticsProvider.js";
import { InflynxCodeActionProvider } from "./CodeActionProvider.js";
import { InflynxInlineCompletionProvider } from "./InlineCompletionProvider.js";
import { registerCommands } from "./commands/index.js";
import type { AgentBudgetLevel, AgentMode } from "./types.js";

let serviceInstance: InflynxService | null = null;
let serverManagerInstance: ServerManager | null = null;
let statusBarInstance: StatusBarManager | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<{ service: InflynxService }> {
  console.log("⚡ [Inflynx Code] Activating extension...");

  const config = vscode.workspace.getConfiguration("inflynx");
  const serverUrl = config.get<string>("serverUrl", "http://localhost:4000");
  const defaultMode = config.get<AgentMode>("defaultMode", "agent");
  const defaultBudget = config.get<AgentBudgetLevel>("defaultBudget", "medium");
  const defaultModel = config.get<string>("defaultModel", "");
  const defaultProvider = config.get<string>("defaultProvider", "");

  // 1. Core Service
  const service = new InflynxService(serverUrl);
  const savedMode = context.workspaceState.get<AgentMode>("inflynx.mode") || defaultMode;
  service.setCurrentMode(savedMode);
  service.setCurrentBudget(defaultBudget);
  const savedModel = context.workspaceState.get<string>("inflynx.model") || defaultModel;
  const savedProvider = context.workspaceState.get<string>("inflynx.provider") || defaultProvider;
  if (savedModel) {
    service.setCurrentModel(savedModel, savedProvider || "openrouter");
  }
  const defaultEffort = config.get<ReasoningEffort>("reasoningEffort", "high");
  const savedEffort = context.workspaceState.get<ReasoningEffort>("inflynx.reasoningEffort") || defaultEffort;
  service.setCurrentEffort(savedEffort);
  serviceInstance = service;

  // 2. Tool Approval Manager
  const approvalManager = new ApprovalManager(service, context);

  // 3. Server Lifecycle Manager
  const serverManager = new ServerManager(service, context);
  serverManagerInstance = serverManager;

  // 4. Status Bar Manager
  const statusBar = new StatusBarManager(service, context);
  statusBarInstance = statusBar;

  // 5. Chat Webview Provider
  const chatProvider = new ChatViewProvider(context.extensionUri, service, approvalManager, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 6. Tree Data Providers
  const sessionTree = new SessionTreeProvider(service);
  const planTree = new PlanTreeProvider(service);
  const toolsTree = new ToolsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("inflynx.sessionsView", sessionTree),
    vscode.window.registerTreeDataProvider("inflynx.planView", planTree),
    vscode.window.registerTreeDataProvider("inflynx.toolsView", toolsTree)
  );

  // 7. Editor Providers
  const diffDecorations = new DiffDecorationProvider(context);
  const diagnostics = new DiagnosticsProvider(context);

  const codeActionProvider = new InflynxCodeActionProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", codeActionProvider, {
      providedCodeActionKinds: InflynxCodeActionProvider.providedCodeActionKinds,
    })
  );

  const inlineProvider = new InflynxInlineCompletionProvider(service);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, inlineProvider)
  );

  // 8. Register Commands
  registerCommands(context, service, serverManager, chatProvider, sessionTree, planTree);

  // 9. Start background server check & health polling
  service.startHealthPolling(4000);
  serverManager.ensureServerRunning().catch((err) => {
    console.warn("[Inflynx Code] Background server launch error:", err);
  });

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("inflynx.serverUrl")) {
        const newUrl = vscode.workspace.getConfiguration("inflynx").get<string>("serverUrl", "http://localhost:4000");
        service.setServerUrl(newUrl);
        service.checkHealth();
      }
    })
  );

  console.log("✅ [Inflynx Code] Extension activated successfully.");
  return { service };
}

export function deactivate(): void {
  console.log("⚡ [Inflynx Code] Deactivating extension...");
  if (serviceInstance) {
    serviceInstance.dispose();
    serviceInstance = null;
  }
  if (serverManagerInstance) {
    serverManagerInstance.dispose();
    serverManagerInstance = null;
  }
  if (statusBarInstance) {
    statusBarInstance.dispose();
    statusBarInstance = null;
  }
}

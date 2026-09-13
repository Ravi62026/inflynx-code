import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import type { InflynxService } from "../InflynxService.js";
import type { ServerManager } from "../ServerManager.js";
import type { ChatViewProvider } from "../ChatViewProvider.js";
import type { SessionTreeProvider } from "../trees/SessionTreeProvider.js";
import type { PlanTreeProvider } from "../trees/PlanTreeProvider.js";
import type { AgentBudgetLevel, AgentMode, ReasoningEffort } from "../types.js";

export function registerCommands(
  context: vscode.ExtensionContext,
  service: InflynxService,
  serverManager: ServerManager,
  chatProvider: ChatViewProvider,
  sessionTree: SessionTreeProvider,
  planTree: PlanTreeProvider
): void {
  // 1. New Chat Session
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.newChat", async () => {
      try {
        const session = await service.createSession();
        chatProvider.postMessage({
          type: "session.loaded",
          payload: {
            session,
            messages: [],
          },
        });
        await vscode.commands.executeCommand("inflynx.chatView.focus");
        vscode.window.showInformationMessage(`Started new Inflynx session (${session.activeMode} mode)`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to start new chat: ${err?.message}`);
      }
    })
  );

  // 2. Switch Agent Mode
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.switchMode", async () => {
      const modes: Array<{ label: string; description: string; mode: AgentMode }> = [
        { label: "⚡ agent", description: "Full autonomous execution (read, patch, write, shell)", mode: "agent" },
        { label: "📖 ask", description: "Read-only Q&A, explanations, and codebase analysis", mode: "ask" },
        { label: "📋 plan", description: "Multi-step architectural task breakdown and DAG planning", mode: "plan" },
        { label: "🐞 debug", description: "Evidence-first diagnosis, reproduction, and repair", mode: "debug" },
      ];

      const selected = await vscode.window.showQuickPick(modes, {
        placeHolder: "Select Inflynx Agent Mode",
      });

      if (selected) {
        service.setCurrentMode(selected.mode);
        chatProvider.postMessage({
          type: "mode.changed",
          payload: { mode: selected.mode },
        });
        vscode.window.showInformationMessage(`Agent mode switched to [${selected.mode}]`);
      }
    })
  );

  // 3. Switch Model
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.switchModel", async () => {
      try {
        const modelsData = await service.getModels();
        const items = modelsData.catalog.map((m) => ({
          label: m.name || m.id,
          description: `${m.provider} • ${Math.round(m.contextWindow / 1000)}k ctx`,
          detail: m.description,
          modelId: m.id,
          provider: m.provider,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select Language Model",
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected) {
          service.setCurrentModel(selected.modelId, selected.provider);
          chatProvider.postMessage({
            type: "model.changed",
            payload: { model: selected.modelId, provider: selected.provider },
          });
          vscode.window.showInformationMessage(`Model switched to ${selected.label}`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to load models catalog: ${err?.message}`);
      }
    })
  );

  // 4. Switch Budget Level
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.switchBudget", async () => {
      const budgets: Array<{ label: string; description: string; budget: AgentBudgetLevel }> = [
        { label: "🟢 low", description: "9 turns • 15 tool calls • 90k tokens", budget: "low" },
        { label: "🟡 medium", description: "24 turns • 45 tool calls • 225k tokens (Default)", budget: "medium" },
        { label: "🟠 high", description: "45 turns • 90 tool calls • 450k tokens", budget: "high" },
        { label: "🔴 max", description: "90 turns • 180 tool calls • 900k tokens", budget: "max" },
      ];

      const selected = await vscode.window.showQuickPick(budgets, {
        placeHolder: "Select Execution Budget Level",
      });

      if (selected) {
        service.setCurrentBudget(selected.budget);
        vscode.window.showInformationMessage(`Execution budget set to [${selected.budget}]`);
      }
    })
  );

  // 5. Set Reasoning Effort
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.setEffort", async () => {
      const efforts: Array<{ label: string; effort: ReasoningEffort }> = [
        { label: "none (default)", effort: "none" },
        { label: "low", effort: "low" },
        { label: "medium", effort: "medium" },
        { label: "high", effort: "high" },
        { label: "max", effort: "max" },
      ];

      const selected = await vscode.window.showQuickPick(efforts, {
        placeHolder: "Select Reasoning Effort Level",
      });

      if (selected) {
        vscode.window.showInformationMessage(`Reasoning effort set to ${selected.effort}`);
      }
    })
  );

  // 6. Abort Current Turn
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.abort", async () => {
      const ok = await service.abortTurn();
      if (ok) {
        chatProvider.postMessage({ type: "turn.cancelled" });
        vscode.window.showInformationMessage("Inflynx turn aborted.");
      }
    })
  );

  // 7. Explain Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Please select code to explain.");
        return;
      }

      const selectionText = editor.document.getText(editor.selection);
      const fileName = path.basename(editor.document.fileName);
      const prompt = `Please explain the following code from \`${fileName}\` in detail:\n\n\`\`\`${editor.document.languageId}\n${selectionText}\n\`\`\``;

      service.setCurrentMode("ask");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension(prompt);
    })
  );

  // 8. Fix Error at Cursor
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.fixError", async (diagnosticsArg?: vscode.Diagnostic[]) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      let diags = diagnosticsArg;
      if (!diags || diags.length === 0) {
        diags = vscode.languages.getDiagnostics(editor.document.uri);
      }

      if (!diags || diags.length === 0) {
        vscode.window.showInformationMessage("No diagnostics or errors detected at cursor.");
        return;
      }

      const fileName = path.basename(editor.document.fileName);
      const diagDescriptions = diags.slice(0, 5).map((d) => `- Line ${d.range.start.line + 1}: ${d.message}`).join("\n");
      const prompt = `Please diagnose and fix the following compiler/linter errors in \`${fileName}\`:\n\n${diagDescriptions}\n\nCurrent file contents around the error:\n\`\`\`${editor.document.languageId}\n${editor.document.getText()}\n\`\`\``;

      service.setCurrentMode("debug");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension(prompt);
    })
  );

  // 9. Refactor Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.refactorSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Please select code to refactor.");
        return;
      }

      const selectionText = editor.document.getText(editor.selection);
      const fileName = path.basename(editor.document.fileName);
      const prompt = `Please refactor the following code from \`${fileName}\` to improve performance, readability, and modern idioms while preserving full behavior:\n\n\`\`\`${editor.document.languageId}\n${selectionText}\n\`\`\``;

      service.setCurrentMode("agent");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension(prompt);
    })
  );

  // 10. Generate Tests for Selection
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.addTestForFunction", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("Please select a function or module to test.");
        return;
      }

      const selectionText = editor.document.getText(editor.selection);
      const fileName = path.basename(editor.document.fileName);
      const prompt = `Generate a comprehensive suite of unit tests with edge cases and happy paths for this code from \`${fileName}\`:\n\n\`\`\`${editor.document.languageId}\n${selectionText}\n\`\`\``;

      service.setCurrentMode("agent");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension(prompt);
    })
  );

  // 11. Show Active Plan
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.showPlan", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return;

      const planPath = path.join(workspaceRoot, ".inflynx", "PLAN.md");
      if (fs.existsSync(planPath)) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(planPath));
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } else {
        vscode.window.showInformationMessage("No active plan found at .inflynx/PLAN.md");
      }
    })
  );

  // 12. Execute Plan
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.executePlan", async () => {
      service.setCurrentMode("agent");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension("Please execute the next pending step of the active plan in `.inflynx/PLAN.md`.");
    })
  );

  // 13. Run Debug Analysis
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.runDebug", async () => {
      service.setCurrentMode("debug");
      await vscode.commands.executeCommand("inflynx.chatView.focus");
      chatProvider.sendPromptFromExtension("Analyze the workspace for any runtime bugs, typecheck errors, or security vulnerabilities.");
    })
  );

  // 14. Show Tokens & Budget
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.showTokens", () => {
      const budget = service.getCurrentBudget();
      vscode.window.showInformationMessage(
        `Inflynx Budget Constraints [${budget}]:\n- Mode: ${service.getCurrentMode()}\n- Model: ${service.getCurrentModel()}\n- Server: ${service.getServerUrl()}`
      );
    })
  );

  // 15. Resume Session
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.resumeSession", async (sessionIdArg?: string) => {
      let sessionId = sessionIdArg;
      if (!sessionId) {
        const sessions = await service.listSessions();
        const pick = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.sessionId,
            description: `[${s.activeMode}] ${s.model}`,
          })),
          { placeHolder: "Select session to resume" }
        );
        if (pick) sessionId = pick.label;
      }

      if (sessionId) {
        try {
          const hydration = await service.getSessionHydration(sessionId);
          chatProvider.postMessage({
            type: "session.loaded",
            payload: hydration,
          });
          await vscode.commands.executeCommand("inflynx.chatView.focus");
          vscode.window.showInformationMessage(`Resumed session ${sessionId}`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to resume session: ${err?.message}`);
        }
      }
    })
  );

  // 16. Refresh Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.refreshSessions", () => {
      sessionTree.refresh();
    })
  );

  // 17. Server Management
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.startServer", () => serverManager.startServer()),
    vscode.commands.registerCommand("inflynx.stopServer", () => serverManager.stopServer()),
    vscode.commands.registerCommand("inflynx.restartServer", () => serverManager.restartServer()),
    vscode.commands.registerCommand("inflynx.reloadChat", () => {
      chatProvider.reload();
      vscode.window.showInformationMessage("Inflynx Code Chat view reloaded.");
    })
  );

  // 18. Open Settings
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "inflynx");
    })
  );

  // 19. Toggle Inline Completions
  context.subscriptions.push(
    vscode.commands.registerCommand("inflynx.toggleInline", async () => {
      const config = vscode.workspace.getConfiguration("inflynx");
      const current = config.get<boolean>("inlineCompletions.enabled", false);
      await config.update("inlineCompletions.enabled", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Inflynx inline completions ${!current ? "enabled" : "disabled"}.`);
    })
  );
}

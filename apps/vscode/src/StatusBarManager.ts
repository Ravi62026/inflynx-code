import * as vscode from "vscode";
import type { InflynxService } from "./InflynxService.js";
import type { AgentBudgetLevel, AgentMode, BudgetStatePayload } from "./types.js";

export class StatusBarManager {
  private modeItem: vscode.StatusBarItem;
  private modelItem: vscode.StatusBarItem;
  private budgetItem: vscode.StatusBarItem;
  private serverItem: vscode.StatusBarItem;
  private isRunning = false;

  constructor(
    private readonly service: InflynxService,
    private readonly context: vscode.ExtensionContext
  ) {
    // Mode Item (priority 100)
    this.modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.modeItem.command = "inflynx.switchMode";
    this.modeItem.tooltip = "Click to switch Inflynx agent mode";

    // Model Item (priority 99)
    this.modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.modelItem.command = "inflynx.switchModel";
    this.modelItem.tooltip = "Click to switch Inflynx model";

    // Budget Item (priority 98)
    this.budgetItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.budgetItem.command = "inflynx.switchBudget";
    this.budgetItem.tooltip = "Click to change Inflynx budget constraints";

    // Server Item (priority 97)
    this.serverItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    this.serverItem.command = "inflynx.startServer";
    this.serverItem.tooltip = "Inflynx backend server status (click to restart/connect)";

    context.subscriptions.push(this.modeItem, this.modelItem, this.budgetItem, this.serverItem);

    this.registerEventListeners();
    this.updateAll();
  }

  private registerEventListeners(): void {
    this.service.on("connected", () => {
      this.updateServerStatus(true);
    });

    this.service.on("disconnected", () => {
      this.updateServerStatus(false);
    });

    this.service.on("turn.started", () => {
      this.isRunning = true;
      this.updateMode();
    });

    this.service.on("turn.completed", () => {
      this.isRunning = false;
      this.updateMode();
    });

    this.service.on("turn.failed", () => {
      this.isRunning = false;
      this.updateMode();
    });

    this.service.on("budget.updated", (budgetState: BudgetStatePayload) => {
      this.updateBudget(budgetState);
    });
  }

  updateAll(): void {
    this.updateMode();
    this.updateModel();
    this.updateBudget();
    this.updateServerStatus(this.service.getIsConnected());
  }

  updateMode(mode?: AgentMode): void {
    const activeMode = mode || this.service.getCurrentMode();
    const icon = this.isRunning ? "$(sync~spin)" : "$(zap)";

    let color: string | undefined;
    switch (activeMode) {
      case "ask":
        color = "#38bdf8"; // sky blue
        break;
      case "plan":
        color = "#facc15"; // yellow
        break;
      case "agent":
        color = "#22d3ee"; // cyan
        break;
      case "debug":
        color = "#f87171"; // red
        break;
    }

    this.modeItem.text = `${icon} [${activeMode}]`;
    this.modeItem.color = color;
    this.modeItem.show();
  }

  updateModel(modelName?: string): void {
    const activeModel = modelName || this.service.getCurrentModel();
    // Shorten model name if long (e.g. openai/gpt-5.6-luna -> gpt-5.6-luna)
    const shortName = activeModel.includes("/") ? activeModel.split("/")[1] : activeModel;
    this.modelItem.text = `$(circuit-board) ${shortName}`;
    this.modelItem.show();
  }

  updateBudget(budgetState?: BudgetStatePayload): void {
    if (budgetState) {
      const turns = `${budgetState.turnsUsed}/${budgetState.maxTurns}T`;
      this.budgetItem.text = `$(flame) ${turns} [${budgetState.level}]`;
      if (budgetState.exhausted) {
        this.budgetItem.color = "#ef4444";
      } else {
        this.budgetItem.color = undefined;
      }
    } else {
      const level = this.service.getCurrentBudget();
      this.budgetItem.text = `$(flame) [${level}]`;
    }
    this.budgetItem.show();
  }

  updateServerStatus(connected: boolean): void {
    if (connected) {
      this.serverItem.text = "$(pass-filled) Inflynx";
      this.serverItem.color = "#4ade80"; // green
      this.serverItem.tooltip = `Connected to ${this.service.getServerUrl()}`;
    } else {
      this.serverItem.text = "$(circle-slash) Inflynx (Offline)";
      this.serverItem.color = "#fbbf24"; // amber
      this.serverItem.tooltip = `Disconnected from ${this.service.getServerUrl()} (click to start server)`;
    }
    this.serverItem.show();
  }

  dispose(): void {
    this.modeItem.dispose();
    this.modelItem.dispose();
    this.budgetItem.dispose();
    this.serverItem.dispose();
  }
}

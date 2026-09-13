import * as vscode from "vscode";
import type { InflynxService } from "../InflynxService.js";
import type { SessionRecord } from "../types.js";

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionRecord,
    public readonly isActive: boolean
  ) {
    super(
      session.sessionId.length > 28 ? `${session.sessionId.slice(0, 24)}...` : session.sessionId,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = `[${session.activeMode}] ${session.model}`;
    this.tooltip = `Session: ${session.sessionId}\nMode: ${session.activeMode}\nModel: ${session.model}\nBudget: ${session.budgetLevel}`;

    if (isActive) {
      this.iconPath = new vscode.ThemeIcon("arrow-right", new vscode.ThemeColor("charts.blue"));
    } else {
      this.iconPath = new vscode.ThemeIcon("comment-discussion");
    }

    this.command = {
      command: "inflynx.resumeSession",
      title: "Resume Session",
      arguments: [session.sessionId],
    };

    this.contextValue = "inflynxSessionItem";
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SessionTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SessionTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private sessions: SessionRecord[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly service: InflynxService) {
    this.service.on("session.started", () => this.refresh());
    this.service.on("turn.completed", () => this.refresh());
    this.service.on("connected", () => this.refresh());
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.fetchSessions().then(() => {
        this._onDidChangeTreeData.fire();
      });
    }, 200);
  }

  async fetchSessions(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration("inflynx");
      const limit = config.get<number>("maxSessionsInSidebar", 20);
      this.sessions = await this.service.listSessions(limit);
    } catch {
      this.sessions = [];
    }
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (element) return [];

    if (this.sessions.length === 0) {
      await this.fetchSessions();
    }

    const currentId = this.service.getCurrentSessionId();
    return this.sessions.map((s) => new SessionTreeItem(s, s.sessionId === currentId));
  }
}

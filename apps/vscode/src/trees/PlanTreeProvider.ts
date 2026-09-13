import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { InflynxService } from "../InflynxService.js";

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  targetFile?: string;
  lineNumber?: number;
}

export class PlanTreeItem extends vscode.TreeItem {
  constructor(public readonly step: PlanStep) {
    super(step.title, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `Status: ${step.status}\n${step.title}`;
    if (step.targetFile) {
      this.description = path.basename(step.targetFile);
    }

    switch (step.status) {
      case "completed":
        this.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
        break;
      case "in_progress":
        this.iconPath = new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"));
        break;
      case "failed":
        this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
        break;
      default:
        this.iconPath = new vscode.ThemeIcon("circle-outline");
        break;
    }

    if (step.targetFile) {
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [
          vscode.Uri.file(step.targetFile),
          { selection: step.lineNumber ? new vscode.Range(step.lineNumber - 1, 0, step.lineNumber - 1, 0) : undefined },
        ],
      };
    }
  }
}

export class PlanTreeProvider implements vscode.TreeDataProvider<PlanTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PlanTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private steps: PlanStep[] = [];
  private planWatcher: vscode.FileSystemWatcher | null = null;

  constructor(private readonly service: InflynxService) {
    this.setupPlanFileWatcher();
    this.refresh();
  }

  refresh(): void {
    this.loadPlan();
    this._onDidChangeTreeData.fire();
  }

  private setupPlanFileWatcher(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const pattern = new vscode.RelativePattern(workspaceRoot, ".inflynx/PLAN.md");
    this.planWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.planWatcher.onDidChange(() => this.refresh());
    this.planWatcher.onDidCreate(() => this.refresh());
    this.planWatcher.onDidDelete(() => this.refresh());
  }

  private loadPlan(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.steps = [];
      return;
    }

    const planPath = path.join(workspaceRoot, ".inflynx", "PLAN.md");
    if (!fs.existsSync(planPath)) {
      this.steps = [];
      return;
    }

    try {
      const content = fs.readFileSync(planPath, "utf8");
      this.steps = this.parsePlanContent(content, workspaceRoot);
    } catch {
      this.steps = [];
    }
  }

  private parsePlanContent(content: string, workspaceRoot: string): PlanStep[] {
    const lines = content.split("\n");
    const steps: PlanStep[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match markdown checkboxes: - [ ] Step description or 1. [x] Step description
      const checkMatch = line.match(/^[-*0-9.]+\s*\[([ xX~-])\]\s*(.+)/);
      if (checkMatch) {
        const check = checkMatch[1].toLowerCase();
        const text = checkMatch[2];

        let status: PlanStep["status"] = "pending";
        if (check === "x") {
          status = "completed";
        } else if (check === "~" || check === "-") {
          status = "in_progress";
        }

        // Try extracting target file path from text: e.g. `path/to/file.ts` or [file.ts](...)
        let targetFile: string | undefined;
        const fileMatch = text.match(/`([^`]+\.[a-zA-Z0-9]+)`/) || text.match(/\[([^\]]+\.[a-zA-Z0-9]+)\]\(([^)]+)\)/);
        if (fileMatch) {
          const raw = fileMatch[2] || fileMatch[1];
          const fullPath = path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw);
          if (fs.existsSync(fullPath)) {
            targetFile = fullPath;
          }
        }

        steps.push({
          id: `step_${i}`,
          title: text.replace(/`([^`]+)`/g, "$1"),
          status,
          targetFile,
        });
      }
    }

    return steps;
  }

  getTreeItem(element: PlanTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlanTreeItem): Promise<PlanTreeItem[]> {
    if (element) return Promise.resolve([]);
    if (this.steps.length === 0) {
      this.loadPlan();
    }
    return Promise.resolve(this.steps.map((s) => new PlanTreeItem(s)));
  }

  dispose(): void {
    if (this.planWatcher) {
      this.planWatcher.dispose();
      this.planWatcher = null;
    }
  }
}

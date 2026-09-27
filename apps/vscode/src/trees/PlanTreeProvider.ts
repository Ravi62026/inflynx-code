import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { parsePlanMarkdown, deserializePlan, PLAN_SIDECAR_RELATIVE_PATH } from "@inflynx/protocol";
import type { InflynxService } from "../InflynxService.js";

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
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
      case "skipped":
        // Skipped used to have no state here at all, because the tree's own parser read
        // the `-` glyph as *in progress* — a step nobody will do looked like live work.
        this.iconPath = new vscode.ThemeIcon("dash", new vscode.ThemeColor("disabledForeground"));
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
    const sidecarPath = path.join(workspaceRoot, PLAN_SIDECAR_RELATIVE_PATH);

    try {
      // K8 (Phase 47): prefer the machine-readable JSON sidecar; fall back to the human markdown.
      // Either way the STRUCTURE is produced by the single shared parser, so the sidebar and the
      // CLI can never disagree about which glyph means "in progress" again.
      let plan = fs.existsSync(sidecarPath)
        ? deserializePlan(fs.readFileSync(sidecarPath, "utf8"))
        : null;
      if (!plan && fs.existsSync(planPath)) {
        plan = parsePlanMarkdown(fs.readFileSync(planPath, "utf8")).plan;
      }
      if (!plan) {
        this.steps = [];
        return;
      }
      this.steps = (plan?.steps ?? []).map((s) => ({
        id: `step_${s.id}`,
        title: `${s.title || s.description}`,
        status: s.status,
        targetFile: s.targetFiles.length
          ? path.join(workspaceRoot, s.targetFiles[0])
          : undefined,
      }));
    } catch {
      this.steps = [];
    }
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

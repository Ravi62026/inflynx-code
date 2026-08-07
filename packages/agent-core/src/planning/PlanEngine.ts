import fs from "fs";
import path from "path";

export type PlanStatus =
  | "PENDING_APPROVAL"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "ABORTED";

export interface PlanStep {
  id: number;
  description: string;
  targetFile?: string;
  verifyCmd?: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

export interface ActivePlan {
  goal: string;
  generatedAt: string;
  status: PlanStatus;
  complexity: "LOW" | "MEDIUM" | "HIGH";
  steps: PlanStep[];
  rawMarkdown: string;
  planPath: string;
}

export class PlanEngine {
  private planPath: string;
  private archiveDir: string;

  constructor(workspaceRoot: string) {
    this.planPath = path.join(workspaceRoot, ".inflynx", "PLAN.md");
    this.archiveDir = path.join(workspaceRoot, ".inflynx", "plans");
  }

  /** Load and parse the current PLAN.md if it exists */
  loadActivePlan(): ActivePlan | null {
    if (!fs.existsSync(this.planPath)) return null;

    const raw = fs.readFileSync(this.planPath, "utf-8");
    return this.parsePlanMarkdown(raw);
  }

  /** Archive old plan and write a new one */
  writePlan(markdown: string): string {
    // Archive existing plan if any
    if (fs.existsSync(this.planPath)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = path.join(this.archiveDir, `PLAN-${ts}.md`);
      fs.copyFileSync(this.planPath, archivePath);
    }

    fs.mkdirSync(path.dirname(this.planPath), { recursive: true });
    fs.writeFileSync(this.planPath, markdown, "utf-8");
    return this.planPath;
  }

  /** Update a step's status in the active plan file */
  markStep(stepId: number, status: PlanStep["status"]): void {
    if (!fs.existsSync(this.planPath)) return;

    let content = fs.readFileSync(this.planPath, "utf-8");
    const statusEmoji = {
      completed: "x",
      in_progress: "/",
      failed: "!",
      skipped: "-",
      pending: " ",
    }[status];

    // Replace the specific step checkbox
    const stepRegex = new RegExp(
      `(- \\[)[\\sx!/](\\].*?\\*\\*Step ${stepId}\\*\\*)`,
      "g"
    );
    content = content.replace(stepRegex, `$1${statusEmoji}$2`);
    fs.writeFileSync(this.planPath, content, "utf-8");
  }

  /** Mark the overall plan status */
  updatePlanStatus(status: PlanStatus): void {
    if (!fs.existsSync(this.planPath)) return;
    let content = fs.readFileSync(this.planPath, "utf-8");
    content = content.replace(
      /> Status: \w+/,
      `> Status: ${status}`
    );
    fs.writeFileSync(this.planPath, content, "utf-8");
  }

  /** List all archived plans */
  listHistory(): Array<{ filename: string; path: string; mtime: Date }> {
    if (!fs.existsSync(this.archiveDir)) return [];
    return fs
      .readdirSync(this.archiveDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        filename: f,
        path: path.join(this.archiveDir, f),
        mtime: fs.statSync(path.join(this.archiveDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  /** Restore a plan from history by filename */
  restorePlan(filename: string): boolean {
    const srcPath = path.join(this.archiveDir, filename);
    if (!fs.existsSync(srcPath)) return false;
    // Archive current before restoring
    if (fs.existsSync(this.planPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(this.planPath, path.join(this.archiveDir, `PLAN-${ts}.md`));
    }
    fs.copyFileSync(srcPath, this.planPath);
    return true;
  }

  private parsePlanMarkdown(raw: string): ActivePlan {
    const goalMatch = raw.match(/# 📋 Plan: (.+)/);
    const statusMatch = raw.match(/> Status: (\w+)/);
    const complexityMatch = raw.match(/> Complexity: (\w+)/);
    const generatedMatch = raw.match(/> Generated: (.+)/);

    const steps: PlanStep[] = [];
    const stepRegex = /- \[([ x\/!-])\] \*\*Step (\d+)\*\*: (.+)\n(?:.*?Target: `(.+?)`\n)?(?:.*?Verify: `(.+?)`\n)?(?:.*?Risk: (LOW|MEDIUM|HIGH))?/gm;
    let match;
    while ((match = stepRegex.exec(raw)) !== null) {
      const checkChar = match[1];
      const statusMap: Record<string, PlanStep["status"]> = {
        " ": "pending", "x": "completed", "/": "in_progress", "!": "failed", "-": "skipped",
      };
      steps.push({
        id: parseInt(match[2]),
        description: match[3].trim(),
        targetFile: match[4],
        verifyCmd: match[5],
        risk: (match[6] as PlanStep["risk"]) || "LOW",
        status: statusMap[checkChar] || "pending",
      });
    }

    return {
      goal: goalMatch?.[1] || "Unknown Goal",
      generatedAt: generatedMatch?.[1] || new Date().toISOString(),
      status: (statusMatch?.[1] as PlanStatus) || "PENDING_APPROVAL",
      complexity: (complexityMatch?.[1] as ActivePlan["complexity"]) || "MEDIUM",
      steps,
      rawMarkdown: raw,
      planPath: this.planPath,
    };
  }
}

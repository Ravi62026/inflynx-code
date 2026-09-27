import fs from "fs";
import path from "path";
import {
  derivePlanStatus,
  parsePlanMarkdown,
  renderPlanMarkdown,
  deserializePlan,
  PLAN_SIDECAR_RELATIVE_PATH,
  type PlanStep,
  type PlanStatus,
} from "@inflynx/protocol";

// Re-exported rather than re-declared. Two `PlanStatus` unions in two packages is how
// `plan.updated`'s payload and this engine's output stopped agreeing without any error.
export type { PlanStatus, PlanStep } from "@inflynx/protocol";

export interface ActivePlan {
  goal: string;
  generatedAt: string;
  status: PlanStatus;
  complexity: "LOW" | "MEDIUM" | "HIGH";
  steps: PlanStep[];
  rawMarkdown: string;
  planPath: string;
  /** Why a readable file was reported as having no plan — never silently empty. */
  warnings: string[];
}

export class PlanEngine {
  private planPath: string;
  private sidecarPath: string;
  private archiveDir: string;

  constructor(workspaceRoot: string) {
    this.planPath = path.join(workspaceRoot, ".inflynx", "PLAN.md");
    this.sidecarPath = path.join(workspaceRoot, PLAN_SIDECAR_RELATIVE_PATH);
    this.archiveDir = path.join(workspaceRoot, ".inflynx", "plans");
  }

  /**
   * Load the active plan, preferring the machine-readable `.inflynx/plan.json` sidecar (K8) and
   * falling back to parsing `PLAN.md`. Both paths yield the SAME `PlanSpec` from the shared parser,
   * so the CLI prompt and the sidebar can never disagree about step state again.
   */
  loadActivePlan(): ActivePlan | null {
    if (fs.existsSync(this.sidecarPath)) {
      try {
        const spec = deserializePlan(fs.readFileSync(this.sidecarPath, "utf-8"));
        if (spec) {
          const raw = fs.existsSync(this.planPath) ? fs.readFileSync(this.planPath, "utf-8") : renderPlanMarkdown(spec);
          return {
            goal: spec.goal, generatedAt: spec.generatedAt, status: spec.status,
            complexity: spec.complexity, steps: spec.steps, rawMarkdown: raw,
            planPath: this.planPath, warnings: [],
          };
        }
      } catch { /* corrupt sidecar → fall through to markdown */ }
    }
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

  /**
   * Update a step's status in the active plan file.
   *
   * Used to be a regex replace of one checkbox, which had two consequences worth
   * naming: the `> Status:` line was left saying `COMPLETED` next to unticked boxes (and
   * the CLI's prompt injection keys off that line, so it stopped reminding the model of
   * remaining work), and `skipped` was written as `-` while the extension's reader
   * treated `-` as *in progress*. This parses, changes one step, and re-renders through
   * the single writer.
   */
  markStep(stepId: number, status: PlanStep["status"]): boolean {
    const plan = this.loadActivePlan();
    if (!plan) return false;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = status;
    return this.writeSpec({
      goal: plan.goal,
      complexity: plan.complexity,
      generatedAt: plan.generatedAt,
      status: plan.status,
      steps: plan.steps,
    });
  }

  /**
   * Set the overall plan status. `ABORTED` is the only value honoured verbatim —
   * otherwise the status is *derived* from the steps, because a model (or a stale file)
   * declaring `COMPLETED` while boxes are unticked is the failure this engine had.
   */
  updatePlanStatus(status: PlanStatus): boolean {
    const plan = this.loadActivePlan();
    if (!plan) return false;
    return this.writeSpec({
      goal: plan.goal,
      complexity: plan.complexity,
      generatedAt: plan.generatedAt,
      status,
      steps: plan.steps,
    });
  }

  /** Renders through the shared writer; the status is derived, never trusted. */
  private writeSpec(spec: Parameters<typeof renderPlanMarkdown>[0]): boolean {
    // `derivePlanStatus` returns ABORTED from a declared ABORTED but only reaches
    // COMPLETED through the steps, so a declared COMPLETED with unticked boxes must be
    // filtered here too — otherwise this method would upgrade it, which is the exact bug
    // the `> Status:` line used to carry.
    const derived = spec.status === "ABORTED" || spec.status === "COMPLETED"
      ? spec.status
      : derivePlanStatus(spec);
    fs.mkdirSync(path.dirname(this.planPath), { recursive: true });
    fs.writeFileSync(this.planPath, renderPlanMarkdown({ ...spec, status: derived }), "utf-8");
    return true;
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

  /**
   * Reads through the shared parser. It used to have its own regex here, which is what
   * made four readers disagree about the checkbox glyphs; the field names it exposes
   * (`targetFiles`, `verificationCommand`) are the canonical ones now, so the CLI and the
   * extension cannot quietly keep a private shape that only matches one of the writers.
   */
  private parsePlanMarkdown(raw: string): ActivePlan {
    const { plan, warnings } = parsePlanMarkdown(raw);
    return {
      goal: plan?.goal ?? "Unknown Goal",
      generatedAt: plan?.generatedAt ?? new Date(0).toISOString(),
      status: plan?.status ?? "PENDING_APPROVAL",
      complexity: plan?.complexity ?? "MEDIUM",
      steps: plan?.steps ?? [],
      rawMarkdown: raw,
      planPath: this.planPath,
      warnings,
    };
  }
}

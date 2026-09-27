import fs from "fs";
import path from "path";
import {
  getActionableSteps,
  planProgress,
  renderPlanMarkdown,
  type PlanSpec,
  type PlanStep,
} from "@inflynx/protocol";

// These names were the second definition of the same idea: `PlanStep`/`PlanSpec` in
// protocol, and a near-identical pair here, with `targetFiles` already agreed but the
// renderer and the other engine's parser disagreeing on the checkbox glyphs. They are
// aliases now, so a field rename cannot half-land again. Kept exported under the old
// names because the e2e and planning tests import them.
export type StructuredStepSpec = PlanStep;
export type StructuredPlanSpec = PlanSpec;

/**
 * @inflynx/agent-core — StructuredPlanEngine
 *
 * In-memory side of a dependency-aware plan. The *format* is not defined here any more:
 * rendering and parsing are `@inflynx/protocol`'s, so what this engine writes is what the
 * CLI, the extension and `update_plan` read.
 */
export class StructuredPlanEngine {
  private planPath: string;
  private currentPlan: StructuredPlanSpec | null = null;

  constructor(workspaceRoot: string) {
    this.planPath = path.join(workspaceRoot, ".inflynx", "PLAN.md");
  }

  get plan(): StructuredPlanSpec | null {
    return this.currentPlan;
  }

  /**
   * Initializes a new structured plan with step dependencies.
   */
  createPlan(
    goal: string,
    complexity: "LOW" | "MEDIUM" | "HIGH",
    steps: Array<Omit<StructuredStepSpec, "status">>
  ): StructuredPlanSpec {
    const fullSteps: StructuredStepSpec[] = steps.map((s) => ({
      ...s,
      status: "pending",
    }));

    this.currentPlan = {
      goal,
      complexity,
      generatedAt: new Date().toISOString(),
      status: "PENDING_APPROVAL",
      steps: fullSteps,
    };

    this.writePlanMarkdown();
    return this.currentPlan;
  }

  /**
   * Returns executable steps whose prerequisite dependencies are all completed.
   * Delegated to the shared helper — this one had no callers while `plan.txt` promised
   * the model it would follow dependencies, so the DAG was decoration rather than a rule.
   */
  getExecutableNextSteps(): StructuredStepSpec[] {
    if (!this.currentPlan) return [];
    return getActionableSteps(this.currentPlan);
  }

  /**
   * Updates step status and syncs `.inflynx/PLAN.md`.
   */
  updateStepStatus(stepId: number, status: StructuredStepSpec["status"]): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = status;
      const p = planProgress(this.currentPlan);
      if (p.settled === p.total) this.currentPlan.status = "COMPLETED";
      else if (p.completed + p.inProgress > 0) this.currentPlan.status = "IN_PROGRESS";
      this.writePlanMarkdown();
    }
  }

  /**
   * Renders and persists `.inflynx/PLAN.md` markdown document projection.
   */
  writePlanMarkdown(): string {
    if (!this.currentPlan) return "";
    const markdown = renderPlanMarkdown(this.currentPlan);
    fs.mkdirSync(path.dirname(this.planPath), { recursive: true });
    fs.writeFileSync(this.planPath, markdown, "utf-8");
    return markdown;
  }
}

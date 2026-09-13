import fs from "fs";
import path from "path";

export interface StructuredStepSpec {
  id: number;
  title: string;
  description: string;
  targetFiles: string[];
  verificationCommand?: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  dependencies: number[]; // Step IDs that must complete first
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

export interface StructuredPlanSpec {
  goal: string;
  complexity: "LOW" | "MEDIUM" | "HIGH";
  generatedAt: string;
  status: "PENDING_APPROVAL" | "IN_PROGRESS" | "COMPLETED" | "ABORTED";
  steps: StructuredStepSpec[];
}

/**
 * @inflynx/agent-core — StructuredPlanEngine
 * 
 * Dependency-aware plan engine. Supports structured DAG step dependencies,
 * target files, risk assessments, and `.inflynx/PLAN.md` markdown projection.
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
   */
  getExecutableNextSteps(): StructuredStepSpec[] {
    if (!this.currentPlan) return [];

    const completedIds = new Set(
      this.currentPlan.steps
        .filter((s) => s.status === "completed")
        .map((s) => s.id)
    );

    return this.currentPlan.steps.filter((step) => {
      if (step.status !== "pending") return false;
      return step.dependencies.every((depId) => completedIds.has(depId));
    });
  }

  /**
   * Updates step status and syncs `.inflynx/PLAN.md`.
   */
  updateStepStatus(stepId: number, status: StructuredStepSpec["status"]): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = status;
      this.writePlanMarkdown();
    }
  }

  /**
   * Renders and persists `.inflynx/PLAN.md` markdown document projection.
   */
  writePlanMarkdown(): string {
    if (!this.currentPlan) return "";

    const lines: string[] = [
      `# 📋 Plan: ${this.currentPlan.goal}`,
      `> Status: ${this.currentPlan.status}`,
      `> Complexity: ${this.currentPlan.complexity}`,
      `> Generated: ${this.currentPlan.generatedAt}`,
      ``,
      `---`,
      ``,
      `## 🎯 Target Steps & Dependency DAG`,
      ``,
    ];

    for (const step of this.currentPlan.steps) {
      const icon = step.status === "completed" ? "x" : step.status === "in_progress" ? "/" : step.status === "failed" ? "!" : " ";
      const depsStr = step.dependencies.length > 0 ? ` (depends on: [${step.dependencies.join(", ")}])` : "";
      const targetStr = step.targetFiles.length > 0 ? `\n   - Target: \`${step.targetFiles.join("`, `")}\`` : "";
      const verifyStr = step.verificationCommand ? `\n   - Verify: \`${step.verificationCommand}\`` : "";

      lines.push(
        `- [${icon}] **Step ${step.id}**: ${step.description}${depsStr}${targetStr}${verifyStr}\n   - Risk: ${step.risk}`
      );
    }

    const markdown = lines.join("\n");
    fs.mkdirSync(path.dirname(this.planPath), { recursive: true });
    fs.writeFileSync(this.planPath, markdown, "utf-8");

    return markdown;
  }
}

/**
 * The canonical structured plan (backlog Phase 26), and the single format Phase 36
 * standardises on and Phase 47 reuses.
 *
 * ## Why this lives in a dependency-free package
 *
 * Four places used to read `.inflynx/PLAN.md`, each with its own regex, and **they
 * disagreed about the checkbox characters**:
 *
 * - `PlanEngine.markStep` writes `x` / `/` / `!` / `-` / ` `
 * - `StructuredPlanEngine` writes `x` for completed and `/` for in progress, and
 *   **never writes `-`** — it maps `skipped` to `-`, then its own parser only accepts
 *   `[ x/- ]`
 * - the VS Code tree reads `[ xX~- ]` and treats `-` as **in progress**, not skipped,
 *   and silently drops `/` (in-progress steps render as pending)
 * - the CLI's prompt injection filters `status === "pending"`, so a step the model is
 *   actively working on disappears from the list it is told to execute
 *
 * That is not a cosmetic split: the one thing a plan exists to communicate is *which
 * step is being worked on*, and three of the four readers got it wrong. So the format is
 * defined once here — `renderPlanMarkdown` / `parsePlanMarkdown` are the only writer and
 * the only reader, and everyone else imports them.
 *
 * `protocol` has no dependencies, which is what lets `tool-runtime` (the tool that
 * publishes plans) and `agent-core` (the engine that advances them) share one definition
 * without either depending on the other.
 */

export type PlanStepState = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type PlanRisk = "LOW" | "MEDIUM" | "HIGH";

export type PlanStatus = "PENDING_APPROVAL" | "IN_PROGRESS" | "COMPLETED" | "ABORTED";

/** The five states, in the order both renderers and tests should walk them. */
export const PLAN_STEP_STATES: PlanStepState[] = ["pending", "in_progress", "completed", "failed", "skipped"];

/**
 * The checkbox glyph per state. Chosen so every state has a **distinct** glyph that all
 * four legacy readers at least partially understood, and asserted round-trip below — a
 * state that renders as a glyph the parser cannot read back is how this file's predecessors
 * broke.
 */
export const PLAN_STEP_GLYPHS: Record<PlanStepState, string> = {
  pending: " ",
  in_progress: "/",
  completed: "x",
  failed: "!",
  skipped: "-",
};

const GLYPH_TO_STATE: Record<string, PlanStepState> = Object.fromEntries(
  Object.entries(PLAN_STEP_GLYPHS).map(([state, glyph]) => [glyph, state as PlanStepState])
);

export interface PlanStep {
  /** Stable, model-chosen. `update_plan` addresses steps by this, never by index. */
  id: number;
  /** Short imperative label — what a human reads in a sidebar. */
  title: string;
  /** What the step actually involves, including its acceptance condition. */
  description: string;
  /** Workspace-relative paths only; the tool refuses absolute and traversal. */
  targetFiles: string[];
  verificationCommand?: string;
  risk: PlanRisk;
  /** Ids of steps that must be `completed` before this one is actionable. */
  dependencies: number[];
  status: PlanStepState;
}

export interface PlanSpec {
  goal: string;
  complexity: PlanRisk;
  /** ISO timestamp. Set when the plan is published, not when it is rendered. */
  generatedAt: string;
  status: PlanStatus;
  steps: PlanStep[];
}

/** Progress as numbers rather than a percentage, so a UI can show "why" not just "how much". */
export interface PlanProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  failed: number;
  skipped: number;
  /** Completed + skipped: the steps that will not be revisited. */
  settled: number;
}

export function planProgress(plan: PlanSpec): PlanProgress {
  const count = (s: PlanStepState) => plan.steps.filter((x) => x.status === s).length;
  const completed = count("completed");
  const skipped = count("skipped");
  return {
    total: plan.steps.length,
    completed,
    inProgress: count("in_progress"),
    pending: count("pending"),
    failed: count("failed"),
    skipped,
    settled: completed + skipped,
  };
}

/**
 * Steps the model may legitimately start now: `pending`, with every dependency completed,
 * and no failed dependency in front of it. The dependency rule lived in
 * `StructuredPlanEngine.getExecutableNextSteps()` where **nothing called it** — the DAG was
 * decoration in the markdown rather than a constraint on anything.
 */
export function getActionableSteps(plan: PlanSpec): PlanStep[] {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  /**
   * "Satisfied" means the dependency is *out of the way*. Completed and skipped obviously
   * are; an `in_progress` one is too, because the model may legitimately have started a
   * prerequisite without its own prerequisites all being ticked yet — refusing that would
   * make the tool fight the human instead of ordering work. `pending` and `failed` are not
   * satisfied, and a failed dependency never unblocks anything implicitly: silently
   * treating a broken prerequisite as done is how a plan claims progress on work its own
   * dependencies rejected. `seen` terminates a dependency cycle, which `update_plan`
   * refuses but a hand-edited or older file can still contain.
   */
  const satisfied = (parent: PlanStep, seen: Set<number>): boolean => {
    if (parent.status === "completed" || parent.status === "skipped") return true;
    if (parent.status !== "in_progress" || seen.has(parent.id)) return false;
    seen.add(parent.id);
    return parent.dependencies.every((d) => {
      const g = byId.get(d);
      return !!g && satisfied(g, seen);
    });
  };

  const blocked = (step: PlanStep, seen = new Set<number>()): boolean =>
    step.dependencies.some((dep) => {
      const parent = byId.get(dep);
      if (!parent) return true; // a dependency that does not exist is not satisfied
      if (seen.has(dep)) return true; // cycle — treat as blocked rather than spinning
      seen.add(dep);
      return !satisfied(parent, seen);
    });
  return plan.steps.filter((s) => s.status === "pending" && !blocked(s));
}

/**
 * The machine-readable form, written as an HTML comment under the human-readable header.
 *
 * It is here because a plan that only exists as prose cannot be advanced, validated or
 * diffed — and because `PlanEngine.parsePlanMarkdown`'s step regex silently drops any step
 * whose line does not match its exact shape, so a model that formats one line
 * differently loses that step from the "next steps" block it is being driven by. The
 * comment is a lossless channel; the markdown below it stays for humans.
 */
const JSON_MARKER = "inflynx:plan";

export function renderPlanMarkdown(plan: PlanSpec): string {
  const lines: string[] = [
    `# 📋 Plan: ${plan.goal}`,
    `> Status: ${plan.status}`,
    `> Complexity: ${plan.complexity}`,
    `> Generated: ${plan.generatedAt}`,
    ``,
    `<!-- ${JSON_MARKER}:${JSON.stringify(plan)} -->`,
    ``,
    `---`,
    ``,
    `## 🎯 Target Steps & Dependency DAG`,
    ``,
  ];

  const done = planProgress(plan);
  lines.push(`_${done.settled} of ${done.total} settled — ${done.completed} done, ${done.inProgress} in progress, ${done.pending} pending${done.failed ? `, ${done.failed} failed` : ""}${done.skipped ? `, ${done.skipped} skipped` : ""}._`, ``);

  for (const step of plan.steps) {
    const deps = step.dependencies.length > 0 ? ` (depends on: [${step.dependencies.join(", ")}])` : "";
    lines.push(`- [${PLAN_STEP_GLYPHS[step.status] ?? " "}] **Step ${step.id}**: ${step.description}${deps}`);
    if (step.title && step.title !== step.description.split(/\s+/).slice(0, 8).join(" ")) {
      lines.push(`   - Title: ${step.title}`);
    }
    if (step.targetFiles.length > 0) lines.push(`   - Target: ${step.targetFiles.map((f) => `\`${f}\``).join(", ")}`);
    if (step.verificationCommand) lines.push(`   - Verify: \`${step.verificationCommand}\``);
    lines.push(`   - Risk: ${step.risk}`);
  }

  return lines.join("\n");
}

export interface PlanParseResult {
  plan: PlanSpec | null;
  /**
   * Non-fatal problems with what was on disk. Reported rather than swallowed: the
   * previous parsers returned an empty step list for a malformed plan, and the CLI
   * then told the model "no active plan" — the plan was still there, unreadable.
   */
  warnings: string[];
}

/**
 * Reads what `renderPlanMarkdown` wrote, and degrades to the legacy markdown shape
 * rather than returning nothing — real PLAN.md files on real machines predate this
 * parser, and "no plan" is the wrong answer for a plan in an older format.
 */
export function parsePlanMarkdown(raw: string): PlanParseResult {
  const warnings: string[] = [];
  if (!raw.trim()) return { plan: null, warnings: ["file is empty"] };

  const embedded = new RegExp(`<!--\\s*${JSON_MARKER}:(\\{[\\s\\S]*?\\})\\s*-->`).exec(raw);
  if (embedded) {
    try {
      const parsed = JSON.parse(embedded[1]) as PlanSpec;
      if (!parsed || !Array.isArray(parsed.steps)) throw new Error("no steps array");
      return { plan: normalise(parsed), warnings };
    } catch (err: any) {
      // The comment is the lossless channel; falling back to the markdown below it is
      // deliberate, but the corruption must still be visible.
      warnings.push(`embedded JSON plan block was unreadable (${err?.message || err}); fell back to markdown parsing`);
    }
  } else {
    warnings.push("no embedded JSON block — parsed as legacy markdown");
  }

  return { plan: parseLegacyMarkdown(raw, warnings), warnings };
}

/**
 * The markdown-only path, for files this writer never produced. Deliberately
 * line-oriented rather than one big regex: `PlanEngine.parsePlanMarkdown`'s single
 * regex satisfied its own shape for exactly one of the four layouts
 * `StructuredPlanEngine.writePlanMarkdown` emitted (the `- Target:` / `- Verify:` /
 * `- Risk:` ordering is fixed there), and a step that missed it vanished without a word.
 */
function parseLegacyMarkdown(raw: string, warnings: string[]): PlanSpec | null {
  const goal = /#\s*(?:📋\s*)?Plan:\s*(.+)/.exec(raw)?.[1]?.trim();
  if (!goal) return null;

  const steps: PlanStep[] = [];
  const lines = raw.split("\n");
  let current: PlanStep | null = null;

  const flush = () => {
    if (!current) return;
    if (!current.title) current.title = current.description;
    steps.push(current);
    current = null;
  };

  for (const line of lines) {
    const stepMatch = /^\s*[-*]\s*\[(.)\]\s*\*\*Step\s+(\d+)\*\*:\s*(.+)/.exec(line);
    if (stepMatch) {
      flush();
      const [, glyph, id, rest] = stepMatch;
      const description = rest.replace(/\s*\(depends on:\s*\[[^\]]*\]\)\s*$/, "").trim();
      const deps = /\(depends on:\s*\[([^\]]*)\]\)/.exec(rest);
      current = {
        id: Number(id),
        title: description,
        description,
        targetFiles: [],
        risk: "LOW",
        dependencies: deps ? deps[1].split(",").map((d) => Number(d.trim())).filter((n) => Number.isFinite(n)) : [],
        status: GLYPH_TO_STATE[glyph] ?? (() => { warnings.push(`step ${id} had unrecognised state "[${glyph}]" — treated as pending`); return "pending"; })(),
      };
      continue;
    }
    if (!current) continue;

    // Any checkbox line that is not a `**Step N**:` line: the file was written by
    // something else, so say so instead of quietly reporting zero steps.
    if (/^\s*[-*]\s*\[.\]/.test(line) && !stepMatch) {
      warnings.push("found checkboxes that are not `**Step N**:` items — they were ignored");
      continue;
    }
    const target = /^\s*-\s*Target:\s*(.+)$/.exec(line);
    if (target) {
      current.targetFiles = [...target[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
      continue;
    }
    const verify = /^\s*-\s*Verify:\s*(.+)$/.exec(line);
    if (verify) {
      current.verificationCommand = /`([^`]+)`/.exec(verify[1])?.[1] ?? verify[1].trim();
      continue;
    }
    const risk = /^\s*-\s*Risk:\s*(LOW|MEDIUM|HIGH)/.exec(line);
    if (risk) current.risk = risk[1] as PlanRisk;
    const title = /^\s*-\s*Title:\s*(.+)$/.exec(line);
    if (title) current.title = title[1].trim();
  }
  flush();

  if (steps.length === 0) warnings.push("plan header found but no steps matched the `**Step N**:` shape");

  return normalise({
    goal,
    complexity: (/(>\s*Complexity:\s*(LOW|MEDIUM|HIGH))/.exec(raw)?.[2] as PlanRisk) || "MEDIUM",
    generatedAt: /(>\s*Generated:\s*)(.+)/.exec(raw)?.[2]?.trim() || new Date(0).toISOString(),
    status: (/(>\s*Status:\s*(\w+))/.exec(raw)?.[2] as PlanStatus) || "IN_PROGRESS",
    steps,
  });
}

/** Repairs what came off disk (or out of a model call) into a complete, renderable spec. */
function normalise(plan: PlanSpec): PlanSpec {
  return {
    goal: String(plan.goal ?? "").trim() || "Untitled plan",
    complexity: plan.complexity === "LOW" || plan.complexity === "HIGH" ? plan.complexity : "MEDIUM",
    generatedAt: plan.generatedAt || new Date(0).toISOString(),
    status: plan.status === "PENDING_APPROVAL" || plan.status === "COMPLETED" || plan.status === "ABORTED"
      ? plan.status : "IN_PROGRESS",
    steps: (plan.steps || []).map((s) => ({
      id: Number(s.id),
      title: String(s.title ?? s.description ?? "").trim(),
      description: String(s.description ?? s.title ?? "").trim(),
      targetFiles: Array.isArray(s.targetFiles) ? s.targetFiles.map(String) : [],
      verificationCommand: s.verificationCommand ? String(s.verificationCommand) : undefined,
      risk: s.risk === "LOW" || s.risk === "HIGH" ? s.risk : "MEDIUM",
      dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(Number).filter(Number.isFinite) : [],
      status: PLAN_STEP_STATES.includes(s.status) ? s.status : "pending",
    })),
  };
}

/**
 * The plan-level status implied by the steps. A model is not trusted to declare the plan
 * finished: the previous flow let `> Status: COMPLETED` sit next to unchecked boxes, and
 * the CLI's injection keys off that line, so it stopped reminding the model of work that
 * was still there.
 */
export function derivePlanStatus(plan: PlanSpec): PlanStatus {
  if (plan.status === "ABORTED") return "ABORTED";
  const p = planProgress(plan);
  if (p.total === 0) return "PENDING_APPROVAL";
  // A failed step is not "still in progress": the plan cannot finish by waiting. Reading
  // it as IN_PROGRESS is what lets an agent keep ticking the later boxes around a step
  // that its own verification rejected.
  if (p.failed > 0) return "ABORTED";
  if (p.settled === p.total) return "COMPLETED";
  return p.settled === 0 && p.inProgress === 0 ? "PENDING_APPROVAL" : "IN_PROGRESS";
}

/**
 * The `update_plan` tool (backlog Phase 26).
 *
 * Until now the plan was a *prose promise*. `plan.txt` told the model to write
 * `.inflynx/PLAN.md` and `agent.txt` told it to tick boxes afterwards, which meant every
 * plan update was a file edit: an approval prompt, a diff preview of markdown nobody
 * reviews, a checkpoint entry, and four different readers disagreeing about what the
 * checkbox glyphs meant (see `@inflynx/protocol/plan.ts`). Meanwhile `plan.updated` was
 * declared in the event protocol and **emitted by nothing** — the sidebar and the CLI
 * progress line were wired to a signal that never fired.
 *
 * This is the one channel for publishing and advancing steps. It is deliberately *not*
 * a general file write: it takes structured steps, validates them, refuses nonsense, and
 * writes exactly one path — `.inflynx/PLAN.md` — through the shared renderer.
 */

import fs from "fs";
import path from "path";
import {
  derivePlanStatus,
  getActionableSteps,
  parsePlanMarkdown,
  planProgress,
  renderPlanMarkdown,
  PLAN_STEP_STATES,
  type PlanSpec,
  type PlanStep,
  type PlanStepState,
} from "@inflynx/protocol";
import type { ToolDefinition } from "./index.js";

/** Where a plan lives. Absolute or traversal targets are refused, whatever the caller says. */
export const PLAN_RELATIVE_PATH = ".inflynx/PLAN.md";

const MAX_STEPS = 25;

export interface PlanStepInput {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  target_files?: unknown;
  verification_command?: unknown;
  risk?: unknown;
  dependencies?: unknown;
  state?: unknown;
}

export interface UpdatePlanInput {
  goal?: unknown;
  complexity?: unknown;
  steps?: unknown;
}

/**
 * Validates a model-supplied step list and folds it into whatever is already on disk.
 *
 * The merge matters: a step's `verification_command` is what Phase 31's gate runs, and the
 * model is not going to re-emit five fields on every progress tick. So identity and state
 * come from this call, and anything the call omits is carried over from the existing plan.
 * Silently *dropping* a step is refused instead — see the errors below.
 */
export function buildPlanFromInput(
  input: UpdatePlanInput,
  existing: PlanSpec | null,
  now: string
): { ok: true; plan: PlanSpec; carriedOver: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) errors.push("'goal' is required — one line describing what this plan achieves.");

  const rawSteps = Array.isArray(input.steps) ? (input.steps as PlanStepInput[]) : null;
  if (!rawSteps) {
    errors.push("'steps' must be an array of step objects, e.g. [{\"id\":1,\"title\":\"...\",\"state\":\"pending\"}].");
    return { ok: false, errors };
  }
  if (rawSteps.length === 0) errors.push("'steps' is empty. A plan with no steps tells the human nothing; pass at least one.");
  if (rawSteps.length > MAX_STEPS) {
    errors.push(`'steps' has ${rawSteps.length} entries. At most ${MAX_STEPS}: a plan nobody can read is a list, not a plan. Break the work down and publish the current phase of it.`);
  }

  const existingById = new Map((existing?.steps ?? []).map((s) => [s.id, s]));
  const steps: PlanStep[] = [];
  const seen = new Set<number>();

  rawSteps.forEach((raw, i) => {
    const where = `step[${i}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${where} is not an object.`);
      return;
    }
    // No coercion of `id`: `Number("1")` is an integer, so a quoted id would be accepted
    // against the schema's own declaration and written back as a number. The step is then
    // addressed differently than the model asked for, and its dependencies — which *are*
    // compared numerically — stop matching it.
    const rawId = raw.id;
    const id = typeof rawId === "number" ? rawId : Number.NaN;
    if (!rawId || typeof rawId === "object" || typeof rawId === "string") {
      errors.push(`${where}.id must be a JSON number (got ${typeof rawId === "string" ? `the string "${rawId}"` : typeof rawId}) — steps are addressed by id, never by position.`);
      return;
    }
    if (!Number.isInteger(id) || id <= 0) {
      errors.push(`${where}.id must be a positive integer — steps are addressed by id, never by position.`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}.id ${id} is used twice. Ids must be stable and unique; the previous step with this id cannot be both kept and replaced.`);
      return;
    }
    seen.add(id);

    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!title && !description) {
      errors.push(`${where} (${id}) has neither 'title' nor 'description'.`);
      return;
    }

    const state = raw.state === undefined || raw.state === null ? "pending" : String(raw.state);
    if (!PLAN_STEP_STATES.includes(state as PlanStepState)) {
      errors.push(`${where}.state "${state}" is not one of ${PLAN_STEP_STATES.join(", ")}.`);
      return;
    }

    const targetFiles: string[] = [];
    if (raw.target_files !== undefined) {
      if (!Array.isArray(raw.target_files)) {
        errors.push(`${where}.target_files must be an array of workspace-relative paths.`);
        return;
      }
      for (const f of raw.target_files.map(String)) {
        const clean = f.trim().replace(/\\/g, "/");
        // The plan is written into the workspace and read by every UI, so a target that
        // names a path outside it is a lie about scope, not a sandbox escape — but it
        // still must not be recorded, because the sidebar offers to open these files.
        if (!clean) continue;
        if (path.isAbsolute(clean) || clean.startsWith("~/") || clean.split("/").includes("..")) {
          errors.push(`${where}.target_files entry "${f}" is not workspace-relative. The plan can only point inside this workspace.`);
          return;
        }
        targetFiles.push(clean);
      }
    }

    const deps = raw.dependencies === undefined
      ? []
      : Array.isArray(raw.dependencies) ? raw.dependencies.map((d) => (typeof d === "number" ? d : Number.NaN)) : null;
    if (!deps) {
      errors.push(`${where}.dependencies must be an array of step ids.`);
      return;
    }
    if (deps.includes(id)) {
      errors.push(`${where} depends on itself (${id}).`);
      return;
    }
    for (const d of deps) if (!Number.isInteger(d) || d <= 0) errors.push(`${where}.dependencies contains "${d}" — must be positive integer step ids.`);

    const previous = existingById.get(id);
    const risk = raw.risk === undefined
      ? (previous?.risk ?? "MEDIUM")
      : (["LOW", "MEDIUM", "HIGH"].includes(String(raw.risk)) ? String(raw.risk) as PlanStep["risk"] : null);
    if (risk === null) {
      errors.push(`${where}.risk must be LOW, MEDIUM or HIGH.`);
      return;
    }

    steps.push({
      id,
      title: title || description,
      description: description || title,
      targetFiles: targetFiles.length > 0 ? targetFiles : (previous?.targetFiles ?? []),
      verificationCommand: raw.verification_command === undefined
        ? previous?.verificationCommand
        : String(raw.verification_command).trim() || undefined,
      risk,
      dependencies: deps,
      status: state as PlanStepState,
    });
  });

  // A step that existed and was *not* re-sent is a silent deletion — and it is not only
  // the open ones that matter. Letting a completed step be omitted would drop its
  // `verification_command` and `target_files` too, which are what Phase 31's gate and the
  // sidebar read, so the check covers every id rather than just unfinished work.
  if (errors.length === 0 && existing) {
    const dropped = existing.steps.filter((s) => !seen.has(s.id));
    if (dropped.length > 0) {
      errors.push(
        `this call would drop ${dropped.length} existing step(s): ` +
        dropped.map((s) => `#${s.id} (${s.status})`).join(", ") +
        `. update_plan replaces the whole plan, and dropping a step loses its targets and `
        + `verification command — re-send those steps too, changing only the state you mean to.`
      );
    }
  }

  if (errors.length === 0) {
    const ids = new Set(steps.map((s) => s.id));
    for (const s of steps) {
      for (const d of s.dependencies) {
        if (!ids.has(d)) errors.push(`step ${s.id} depends on step ${d}, which is not in this plan.`);
      }
    }
    const inProgress = steps.filter((s) => s.status === "in_progress");
    if (inProgress.length > 1) {
      errors.push(
        `${inProgress.length} steps are in_progress (${inProgress.map((s) => `#${s.id}`).join(", ")}). ` +
        `Publish one step at a time — that is the point of the plan view. Mark the others completed or pending first.`
      );
    }
    // Cycle check: a dependency loop makes the DAG unsatisfiable, and the actionable-step
    // helper would report "nothing to do" forever.
    if (errors.length === 0) {
      const byId = new Map(steps.map((s) => [s.id, s]));
      const visiting = new Set<number>();
      const done = new Set<number>();
      const walk = (id: number, chain: number[]): string | null => {
        if (done.has(id)) return null;
        if (visiting.has(id)) return [...chain, id].join(" → ");
        visiting.add(id);
        for (const dep of byId.get(id)?.dependencies ?? []) {
          const cycle = walk(dep, [...chain, id]);
          if (cycle) return cycle;
        }
        visiting.delete(id);
        done.add(id);
        return null;
      };
      for (const s of steps) {
        const cycle = walk(s.id, []);
        if (cycle) { errors.push(`dependency cycle: ${cycle}`); break; }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const carriedOver = steps.filter((s) => existingById.has(s.id)).length;
  const plan: PlanSpec = {
    goal,
    complexity: input.complexity === "LOW" || input.complexity === "HIGH" ? input.complexity : (existing?.complexity ?? "MEDIUM"),
    generatedAt: existing?.generatedAt ?? now,
    // Derived, not declared. The model is not trusted to say it is finished while boxes
    // are unticked — the CLI's prompt injection keys off this line.
    status: derivePlanStatus({
      goal,
      complexity: "MEDIUM",
      generatedAt: now,
      status: "IN_PROGRESS",
      steps,
    }),
    steps,
  };
  return { ok: true, plan, carriedOver };
}

export const UPDATE_PLAN_TOOL: ToolDefinition = {
  name: "update_plan",
  description:
    "Publish or advance the structured plan the human watches. Pass the FULL step list " +
    "every time (it replaces the plan, so re-send every step — omitting one, even a " +
    "completed one, is refused rather than silently dropped, because its targets and " +
    "verification command would be lost) and mark the step you are working on " +
    "`in_progress`, then `completed` when its verification passes. Writes .inflynx/PLAN.md and " +
    "emits plan.updated. This is the only sanctioned way to update the plan: do not edit " +
    "PLAN.md with write_file/edit_file. Steps with unmet dependencies cannot be started, one " +
    "step at a time may be in_progress, and the overall status is derived from the steps rather " +
    "than declared.",
  permissionLevel: "readwrite",
  // It writes a file, so [ask] must not offer it and the caches must not treat it as pure.
  // It is not checkpointed: PLAN.md is the agent's note about the work, not the work, and
  // /undo restoring a plan a human may have edited is not what the journal is for.
  isMutating: true,
  cacheable: false,
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "One line: what the plan achieves" },
      complexity: {
        type: "string",
        description: "Overall effort/risk of the plan",
        enum: ["LOW", "MEDIUM", "HIGH"],
      },
      steps: {
        type: "array",
        description: "The complete step list, in execution order",
        items: {
          type: "object",
          properties: {
            id: { type: "number", description: "Stable positive integer; steps are addressed by id" },
            title: { type: "string", description: "Short imperative label for the sidebar" },
            description: { type: "string", description: "What the step involves, including its acceptance condition" },
            target_files: {
              type: "array",
              description: "Workspace-relative paths this step touches",
              items: { type: "string" },
            },
            verification_command: {
              type: "string",
              description: "Command that proves the step worked; the verification gate runs it",
            },
            risk: { type: "string", description: "Risk of this step", enum: ["LOW", "MEDIUM", "HIGH"] },
            dependencies: {
              type: "array",
              description: "Ids of steps that must be completed first",
              items: { type: "number" },
            },
            state: {
              type: "string",
              description: "pending | in_progress | completed | failed | skipped. Omit for pending.",
              enum: [...PLAN_STEP_STATES],
            },
          },
          required: ["id", "title"],
        },
      },
    },
    required: ["goal", "steps"],
  },
  execute: async (args, ctx) => {
    const planPath = path.join(ctx.workspaceRoot, ".inflynx", "PLAN.md");
    let existing: PlanSpec | null = null;
    const readWarnings: string[] = [];
    try {
      if (fs.existsSync(planPath)) {
        const parsed = parsePlanMarkdown(fs.readFileSync(planPath, "utf-8"));
        existing = parsed.plan;
        readWarnings.push(...parsed.warnings);
      }
    } catch (err: any) {
      readWarnings.push(`existing PLAN.md could not be read (${err?.message || err}); this call replaces it`);
    }

    const built = buildPlanFromInput(args as UpdatePlanInput, existing, new Date().toISOString());
    if (!built.ok) {
      return {
        output:
          `Error: update_plan rejected — nothing was written.\n\n` +
          built.errors.map((e) => `• ${e}`).join("\n") +
          `\n\nFix the step list and call again. The current plan on disk is unchanged.`,
        isError: true,
      };
    }

    const markdown = renderPlanMarkdown(built.plan);
    try {
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, markdown, "utf-8");
    } catch (err: any) {
      return {
        output: `Error: the plan validated but could not be written to ${PLAN_RELATIVE_PATH}: ${err?.message || err}`,
        isError: true,
      };
    }

    const p = planProgress(built.plan);
    const current = built.plan.steps.find((s) => s.status === "in_progress");
    // Re-read what was just written. Not a sanity ritual: the renderer and the parser are
    // the only two opinions about the format, and every previous reader of PLAN.md had its
    // own regex. If this call cannot read its own output, the UIs downstream cannot either,
    // and the failure belongs in the tool result rather than in a silent sidebar.
    const roundTrip = parsePlanMarkdown(markdown);
    const nextUp = roundTrip.plan ? getActionableSteps(roundTrip.plan).slice(0, 3) : [];
    const lostInRoundTrip = !roundTrip.plan || roundTrip.plan.steps.length !== built.plan.steps.length;

    return {
      output:
        `✓ Plan "${built.plan.goal}" — ${p.settled}/${p.total} settled ` +
        `(${p.completed} done, ${p.inProgress} in progress, ${p.pending} pending${p.failed ? `, ${p.failed} failed` : ""}${p.skipped ? `, ${p.skipped} skipped` : ""}).\n` +
        (current ? `  Now: step ${current.id} — ${current.title}\n` : "") +
        (nextUp.length ? `  Up next: ${nextUp.map((s) => `#${s.id} ${s.title}`).join("; ")}\n` : "") +
        `  Written to ${PLAN_RELATIVE_PATH} (status: ${built.plan.status}${built.carriedOver ? `, ${built.carriedOver} step(s) merged with the previous plan` : ""}).` +
        (lostInRoundTrip
          ? `\n  ⚠ the plan could not be read back from its own markdown (${roundTrip.warnings.join("; ") || "step count mismatch"}) — ` +
            `the file is on disk, but the sidebar may not show it. Report this rather than working around it.`
          : ``) +
        (readWarnings.length ? `\n  Note: ${readWarnings.join("; ")}` : ``) +
        (p.inProgress === 0 && p.settled < p.total
          ? `\n  No step is marked in_progress — mark the one you are starting, so the human can follow along.`
          : ``),
      isError: false,
      plan: built.plan,
    };
  },
};

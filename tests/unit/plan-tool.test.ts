/**
 * Backlog Phase 26 — `update_plan` / the todo tool.
 *
 * The properties worth testing here are all about *agreement*: four readers used to parse
 * `.inflynx/PLAN.md` with four regexes and disagree about what the checkbox glyphs meant,
 * `plan.updated` was declared and never emitted, and the model was told to tick boxes by
 * editing a file. So the tests below pin the single format, the refusal of nonsense, and
 * the event actually arriving through a real turn.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ToolRegistry,
  CORE_TOOLS,
  ToolExecutionGateway,
  createToolExecutionContextFromGuard,
  buildPlanFromInput,
  UPDATE_PLAN_TOOL,
} from "../../packages/tool-runtime/src/index.js";
import {
  parsePlanMarkdown,
  renderPlanMarkdown,
  derivePlanStatus,
  getActionableSteps,
  planProgress,
  PLAN_STEP_GLYPHS,
  PLAN_STEP_STATES,
  type PlanSpec,
  type PlanStep,
  type PlanStepState,
} from "../../packages/protocol/src/index.js";
import {
  PlanEngine,
  StructuredPlanEngine,
  filterToolsForMode,
} from "../../packages/agent-core/src/index.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { AgentEventBus, type PublicAgentEvent } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { cleanupOnExit } from "../helpers/tmp.js";

function tmpRoot(prefix = "inflynx-plan26-"): string {
  // Registered for exit-cleanup as well as removed in each block's `finally`: the outer
  // catch calls `process.exit(1)`, which skips a pending `finally` and would leak the dir.
  return cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PLAN_FILE = (root: string) => path.join(root, ".inflynx", "PLAN.md");

function step(id: number, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id, title: `step ${id}`, description: `do step ${id}`, targetFiles: [],
    risk: "MEDIUM", dependencies: [], status: "pending", ...over,
  };
}

function spec(steps: PlanStep[], over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    goal: "Ship it", complexity: "MEDIUM",
    generatedAt: "2026-01-01T00:00:00.000Z", status: "IN_PROGRESS", steps, ...over,
  };
}

/** The exact argument shape a model would send. */
function toolArgs(steps: Array<Record<string, unknown>>, goal = "Ship it"): Record<string, unknown> {
  return { goal, complexity: "MEDIUM", steps };
}

async function runPhase26Tests(): Promise<void> {
  console.log("🧪 Running Phase 26 update_plan Tests...\n");

  // ── Test 1: one format, five states, each distinguishable ─────────────────
  {
    const states: PlanStepState[] = [...PLAN_STEP_STATES];
    assert.equal(new Set(states.map((s) => PLAN_STEP_GLYPHS[s])).size, states.length,
      "two states share a glyph — the UIs cannot tell them apart");

    const original = spec(states.map((s, i) => step(i + 1, { status: s, title: `t${s}` })));
    const md = renderPlanMarkdown(original);
    const back = parsePlanMarkdown(md);

    assert.ok(back.plan, "rendered plan could not be read back");
    assert.deepEqual(back.warnings, [], `clean render produced warnings: ${back.warnings}`);
    assert.deepEqual(back.plan!.steps.map((s) => s.status), states,
      "a state did not survive the round-trip");
    assert.deepEqual(back.plan!.steps.map((s) => s.id), original.steps.map((s) => s.id));
    // The bug this replaces: the extension read `-` as in_progress while the writer used
    // it for skipped, and dropped `/` entirely. `skipped` must never arrive as in_progress.
    assert.equal(back.plan!.steps.find((s) => s.status === "skipped")?.id, 5, "skipped was lost");
    assert.equal(back.plan!.steps.filter((s) => s.status === "in_progress").length, 1);
    console.log("✓ Test 1 Passed: render→parse round-trips all five states distinctly.");
  }

  // ── Test 2: legacy files degrade with a warning, never a silent zero ──────
  {
    // Exactly what `StructuredPlanEngine` used to emit: no JSON block, `- Target:` lines.
    const legacy = [
      `# 📋 Plan: Migrate to Shared Orchestrator`,
      `> Status: PENDING_APPROVAL`,
      `> Complexity: HIGH`,
      `> Generated: 2026-09-26T11:10:41.254Z`,
      ``,
      `- [x] **Step 1**: Build state machine`,
      `   - Target: \`src/StateMachine.ts\``,
      `   - Risk: LOW`,
      `- [/] **Step 2**: Build orchestrator (depends on: [1])`,
      `   - Target: \`src/AgentOrchestrator.ts\`, \`src/index.ts\``,
      `   - Verify: \`pnpm build\``,
      `   - Risk: MEDIUM`,
      `- [ ] **Step 3**: Connect CLI (depends on: [2])`,
      `   - Risk: HIGH`,
    ].join("\n");

    const parsed = parsePlanMarkdown(legacy);
    assert.ok(parsed.plan, "a readable legacy plan was reported as no plan");
    assert.equal(parsed.plan!.steps.length, 3, "a step was silently dropped");
    assert.deepEqual(parsed.plan!.steps[1].targetFiles, ["src/AgentOrchestrator.ts", "src/index.ts"],
      "multiple targets lost");
    assert.equal(parsed.plan!.steps[1].verificationCommand, "pnpm build");
    assert.equal(parsed.plan!.steps[0].status, "completed");
    assert.equal(parsed.plan!.steps[1].status, "in_progress", "`/` must mean in progress");
    assert.deepEqual(parsed.plan!.steps[2].dependencies, [2]);
    assert.ok(parsed.warnings.some((w) => /legacy markdown/i.test(w)),
      `a legacy file must say so: ${parsed.warnings}`);

    // The old single-regex parser's real failure mode: a step whose line shape differed
    // vanished and the caller was told "no active plan".
    const unknownGlyph = `- [~] **Step 1**: odd glyph\n`;
    const odd = parsePlanMarkdown(`# 📋 Plan: odd\n${unknownGlyph}`);
    assert.equal(odd.plan!.steps[0].status, "pending");
    assert.ok(odd.warnings.some((w) => /unrecognised state/i.test(w)),
      `an unknown glyph must be reported: ${odd.warnings}`);

    assert.equal(parsePlanMarkdown("").plan, null);
    const prose = parsePlanMarkdown("just prose");
    assert.equal(prose.plan, null, "prose was reported as a plan");
    assert.ok(prose.warnings.some((w) => /legacy markdown/i.test(w)),
      "saying 'this is not our format' is information, not a failure");
    console.log("✓ Test 2 Passed: legacy PLAN.md parses, and every loss is a warning not a zero.");
  }

  // ── Test 3: nonsense is refused, nothing half-written ────────────────────
  {
    const root = tmpRoot();
    try {
      const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "p26" });
      const call = async (args: Record<string, unknown>) => {
        const r = await UPDATE_PLAN_TOOL.execute(args as never, ctx as never);
        return typeof r === "string" ? { output: r, isError: false } : r;
      };

      const bad: Array<[string, Record<string, unknown>, RegExp]> = [
        ["no goal", { steps: [{ id: 1, title: "a" }] }, /'goal' is required/],
        ["steps not an array", { goal: "g", steps: "1. do it" }, /must be an array/],
        ["empty steps", { goal: "g", steps: [] }, /empty/],
        ["string id", { goal: "g", steps: [{ id: "1", title: "a" }] }, /must be a JSON number/],
        ["string dependency id", { goal: "g", steps: [{ id: 1, title: "a" }, { id: 2, title: "b", dependencies: ["1"] }] }, /positive integer step ids/],
        ["duplicate id", toolArgs([{ id: 1, title: "a" }, { id: 1, title: "b" }]), /used twice/],
        ["no text", toolArgs([{ id: 1 }]), /neither 'title' nor 'description'/],
        ["bad state", toolArgs([{ id: 1, title: "a", state: "almost_done" }]), /is not one of/],
        ["absolute target", toolArgs([{ id: 1, title: "a", target_files: ["/etc/hosts"] }]), /workspace-relative/],
        ["traversal target", toolArgs([{ id: 1, title: "a", target_files: ["../../outside.ts"] }]), /workspace-relative/],
        ["self dependency", toolArgs([{ id: 1, title: "a", dependencies: [1] }]), /depends on itself/],
        ["unknown dependency", toolArgs([{ id: 2, title: "a", dependencies: [99] }]), /not in this plan/],
        ["dependency cycle", toolArgs([{ id: 1, title: "a", dependencies: [2] }, { id: 2, title: "b", dependencies: [1] }]), /dependency cycle/],
        ["two in progress", toolArgs([{ id: 1, title: "a", state: "in_progress" }, { id: 2, title: "b", state: "in_progress" }]), /2 steps are in_progress/],
        ["bad risk", toolArgs([{ id: 1, title: "a", risk: "SCARY" }]), /LOW, MEDIUM or HIGH/],
      ];

      for (const [label, args, expect] of bad) {
        const res = await call(args);
        assert.equal(res.isError, true, `"${label}" was accepted`);
        assert.match(res.output, expect, `"${label}" refused for the wrong reason:\n${res.output}`);
      }
      assert.equal(bad.length, 15, "the refusal table drifted — count it, do not recite it");
      assert.ok(!fs.existsSync(PLAN_FILE(root)), "a rejected call still wrote the plan");

      // A typo'd state is refused rather than coerced to pending: coercing would quietly
      // move a completed step back into the queue.
      const ok = await call(toolArgs([{ id: 1, title: "a" }, { id: 2, title: "b", state: "in_progress", target_files: ["src/x.ts"] }]));
      assert.equal(ok.isError, false, ok.output);
      // "settled" is completed + skipped only — started-but-not-done is not progress.
      assert.match(ok.output, /0\/2 settled \(0 done, 1 in progress, 1 pending\)/, ok.output);
      assert.match(ok.output, /Now: step 2 — b/, ok.output);
      assert.match(ok.output, /Up next: /, "actionable steps should be surfaced to the model");
      console.log(`✓ Test 3 Passed: ${bad.length} nonsense shapes refused, nothing written on any of them.`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 4: status is derived — progress cannot be claimed, only shown ────
  {
    const root = tmpRoot();
    try {
      const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "p26b" });
      const call = (args: Record<string, unknown>) => UPDATE_PLAN_TOOL.execute(args as never, ctx as never);

      // The model says it is finished. It is not: two boxes are unticked.
      const declared = spec([step(1, { status: "pending" }), step(2, { status: "pending" }), step(3, { status: "completed" })],
        { status: "COMPLETED" });
      assert.equal(derivePlanStatus(declared), "IN_PROGRESS", "a declared COMPLETED with open steps was honoured");
      assert.equal(derivePlanStatus(spec([step(1, { status: "completed" }), step(2, { status: "skipped" })])), "COMPLETED");
      assert.equal(derivePlanStatus(spec([step(1, { status: "failed" }), step(2, { status: "completed" })])), "ABORTED",
        "a failed step must not read as success");

      const first = await call(toolArgs([{ id: 1, title: "a", verification_command: "pnpm build" }, { id: 2, title: "b", dependencies: [1] }]));
      const firstSpec = (first as any).plan as PlanSpec;
      assert.equal(firstSpec.status, "PENDING_APPROVAL", "a brand-new plan with no work done is not IN_PROGRESS");
      assert.equal(firstSpec.steps[0].verificationCommand, "pnpm build");

      // Second call: the model advances step 1 and *omits* the fields it never mentions.
      const second = await call(toolArgs([
        { id: 1, title: "a", state: "completed" },
        { id: 2, title: "b", state: "in_progress", dependencies: [1] },
      ])) as any;
      assert.equal(second.isError, false, second.output);
      assert.equal(second.plan.steps[0].verificationCommand, "pnpm build",
        "verification_command was dropped by a call that did not mention it — the gate would lose it");
      assert.equal(second.plan.status, "IN_PROGRESS");
      assert.match(second.output, /merged with the previous plan/);

      // Dropping any step is a deletion, and deletions are not silent — including a
      // completed one, whose verification command the gate still needs.
      const dropped = await call(toolArgs([{ id: 2, title: "b", state: "in_progress" }])) as any;
      assert.equal(dropped.isError, true, "an omitted step disappeared without complaint");
      assert.match(dropped.output, /would drop 1 existing step\(s\): #1 \(completed\)/,
        `wrong drop message:\n${dropped.output}`);
      assert.match(dropped.output, /verification command/,
        `the drop error must say why an already-done step still matters:\n${dropped.output}`);
      const onDisk = parsePlanMarkdown(fs.readFileSync(PLAN_FILE(root), "utf-8")).plan!;
      assert.deepEqual(onDisk.steps.map((s) => [s.id, s.status]), [[1, "completed"], [2, "in_progress"]],
        "the rejected call changed the plan on disk");
      console.log("✓ Test 4 Passed: status derived from steps; fields carried over; open-step drops refused.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: the DAG is a rule now, not decoration ────────────────────────
  {
    const plan = spec([
      step(1), step(2, { dependencies: [1] }), step(3, { dependencies: [2] }),
      step(4, { dependencies: [99] }), // dangling
    ]);
    assert.deepEqual(getActionableSteps(plan).map((s) => s.id), [1],
      "everything was actionable — the dependency list was ignored");
    const advanced = spec([step(1, { status: "completed" }), step(2, { dependencies: [1] }), step(3, { dependencies: [2] }), step(4, { dependencies: [99] })]);
    assert.deepEqual(getActionableSteps(advanced).map((s) => s.id), [2]);
    const failedDep = spec([step(1, { status: "failed" }), step(2, { dependencies: [1] })]);
    assert.deepEqual(getActionableSteps(failedDep).map((s) => s.id), [],
      "a failed prerequisite unblocked its dependant");
    const skippedDep = spec([step(1, { status: "skipped" }), step(2, { dependencies: [1] })]);
    assert.deepEqual(getActionableSteps(skippedDep).map((s) => s.id), [2],
      "a deliberately skipped step must not block the work after it forever");
    const cyclic = spec([step(1, { dependencies: [2] }), step(2, { dependencies: [1] })]);
    assert.deepEqual(getActionableSteps(cyclic), [], "a cycle must not hang or unlock");

    // `StructuredPlanEngine.getExecutableNextSteps()` had this logic and *no callers*.
    const engineRoot = tmpRoot();
    try {
      const engine = new StructuredPlanEngine(engineRoot);
      engine.createPlan("g", "HIGH", [
        { id: 1, title: "a", description: "a", targetFiles: [], risk: "LOW", dependencies: [] },
        { id: 2, title: "b", description: "b", targetFiles: [], risk: "LOW", dependencies: [1] },
      ] as never);
      assert.deepEqual(engine.getExecutableNextSteps().map((s) => s.id), [1]);
      engine.updateStepStatus(1, "completed");
      assert.deepEqual(engine.getExecutableNextSteps().map((s) => s.id), [2]);
      const p = planProgress(engine.plan!);
      assert.equal(p.settled, 1);
      // The engine writes PLAN.md; a test that does not clean up its root leaves residue in
      // the system temp directory on every run, which is how suites get blamed for disk noise.
      assert.ok(fs.existsSync(path.join(engineRoot, ".inflynx", "PLAN.md")), "the engine wrote nothing");
    } finally {
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
    console.log("✓ Test 5 Passed: dependencies gate what may start, including skipped/cyclic/dangling.");
  }

  // ── Test 6: gateway policy — .inflynx only, [plan] yes, [ask] no, no cache ─
  {
    const root = tmpRoot();
    try {
      const registry = new ToolRegistry(CORE_TOOLS);
      const gateway = new ToolExecutionGateway(root);
      const call = (mode: string, args: Record<string, unknown> = {}) =>
        gateway.executeGuarded(registry, { id: `c${Math.random()}`, name: "update_plan", args: {
          ...toolArgs([{ id: 1, title: "a" }, { id: 2, title: "b", state: "in_progress" }]), ...args,
        } } as never, { activeMode: mode as never, sessionId: "s" } as never);

      const planned = await call("plan");
      assert.ok(!planned.isError, `[plan] blocked the plan tool: ${planned.output}`);
      assert.ok(planned.plan, "structured plan did not survive the gateway");
      assert.equal(planned.touchedSourceFile, undefined,
        "a plan write must not count as a source edit (it would trigger the verify gate)");

      const asked = await call("ask");
      assert.equal(asked.isError, true, "[ask] mode executed a write");
      assert.match(asked.output, /\[ask\] mode/);

      // An argument cannot retarget the write. The gateway canonicalises `path` and refuses
      // it before the tool is reached; either way the tool's own path is computed from the
      // workspace root and is not a knob the model can turn.
      const escape = await call("agent", { path: "../../outside/PLAN.md" } as never);
      assert.equal(escape.isError, true, "a `path` arg was accepted by the plan tool");
      assert.match(escape.output, /Security Policy Violation|outside/i, escape.output);
      assert.ok(!fs.existsSync(path.join(path.dirname(root), "outside")), "a `path` arg escaped the workspace");
      const inWork = await call("agent", { path: ".inflynx/PLAN.md" } as never);
      assert.equal(inWork.isError, false, `a benign path still blocked the call: ${inWork.output}`);
      assert.ok(fs.existsSync(PLAN_FILE(root)), "the write did not land in the workspace");

      // Identical calls in the same turn must not be answered from cache — the whole point
      // is that the second one reports different progress.
      const a = await call("agent");
      const b = await call("agent");
      assert.ok(!a.cached && !b.cached, "update_plan was deduplicated");
      console.log("✓ Test 6 Passed: [plan] yes, [ask] no, path arg ignored, never cached.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 7: through a real turn — plan.updated actually fires ────────────
  {
    const root = tmpRoot();
    const originalFetch = (globalThis as any).fetch;
    try {
      const sse = (lines: string[]) => new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); } }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const toolCall = (args: Record<string, unknown>) => sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "update_plan", arguments: JSON.stringify(args) } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]",
      ]);
      const textReply = (t: string) => sse([
        JSON.stringify({ choices: [{ delta: { content: t } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]",
      ]);

      const events: PublicAgentEvent[] = [];
      const bus = new AgentEventBus();
      bus.on("*", (e) => { events.push(e); return undefined; });

      let req = 0;
      (globalThis as any).fetch = async () => {
        req++;
        if (req === 1) return toolCall(toolArgs([
          { id: 1, title: "Add the tool", state: "completed", verification_command: "pnpm build" },
          { id: 2, title: "Wire the UI", state: "in_progress", dependencies: [1], target_files: ["apps/cli/src/index.ts"] },
        ], "Ship update_plan"));
        return textReply("plan published");
      };

      let approvals = 0;
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never, bus as never,
        async () => { approvals++; return true; }, "low", new LocalJsonSessionStore(root) as never
      );
      const turn = await orchestrator.runTurn("publish the plan");

      assert.equal(turn.toolResults[0]?.isError, false, `tool call failed: ${turn.toolResults[0]?.output}`);
      assert.ok(turn.toolResults[0]?.plan, "the turn's ToolResult lost the structured plan");

      const emitted = events.filter((e) => e.type === "plan.updated");
      assert.equal(emitted.length, 1, `plan.updated fired ${emitted.length} times — it had zero emitters before this phase`);
      const payload = emitted[0].payload as { plan: PlanSpec; goal: string; completed: number; total: number };
      assert.equal(payload.goal, "Ship update_plan");
      assert.equal(payload.total, 2);
      assert.equal(payload.completed, 1);
      assert.equal(payload.plan.steps[1].status, "in_progress", "the event lost the current step");
      assert.equal(payload.plan.steps[0].verificationCommand, "pnpm build",
        "the gate's command is missing from the published plan");

      // The file the human opens, and the one the sidebar watches.
      const onDisk = parsePlanMarkdown(fs.readFileSync(PLAN_FILE(root), "utf-8"));
      assert.equal(onDisk.plan?.steps.length, 2);
      assert.deepEqual(onDisk.warnings, []);

      // And no file-write happened on the way: the plan arrived with exactly one tool call.
      assert.equal(turn.toolResults.length, 1, `expected only the plan tool: ${turn.toolResults.map((t) => t.toolName)}`);
      assert.equal(approvals, 1, "publishing a plan should ask exactly once (it is a write)");
      console.log("✓ Test 7 Passed: a real turn publishes the plan and emits plan.updated with the structure.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 8: the read side — PlanEngine and the mode filter agree ──────────
  {
    const root = tmpRoot();
    try {
      const engine = new PlanEngine(root);
      const structured = new StructuredPlanEngine(root);
      structured.createPlan("Legacy check", "MEDIUM", [
        { id: 1, title: "a", description: "alpha", targetFiles: ["src/a.ts"], risk: "LOW", dependencies: [] },
        { id: 2, title: "b", description: "beta", targetFiles: [], risk: "MEDIUM", dependencies: [1] },
      ] as never);

      // Written by one engine, read by the other — previously two private formats.
      const loaded = engine.loadActivePlan();
      assert.ok(loaded, "PlanEngine could not read what StructuredPlanEngine wrote");
      assert.equal(loaded!.steps.length, 2);
      assert.deepEqual(loaded!.steps[0].targetFiles, ["src/a.ts"]);
      assert.equal(loaded!.steps[1].dependencies[0], 1);

      // Ticking a step must keep the header honest — the old markStep replaced one checkbox
      // and left `> Status:` alone, so COMPLETED sat next to unticked boxes.
      engine.markStep(1, "completed");
      const after = engine.loadActivePlan()!;
      assert.equal(after.status, "IN_PROGRESS", "one of two steps done must not read as COMPLETED");
      assert.equal(after.steps[0].status, "completed");
      assert.equal(after.steps[1].status, "pending", "markStep lost the other step");
      engine.markStep(2, "completed");
      assert.equal(engine.loadActivePlan()!.status, "COMPLETED");

      // `skipped` and `in_progress` are different things through the whole path.
      engine.markStep(2, "skipped");
      assert.equal(engine.loadActivePlan()!.steps[1].status, "skipped",
        "skipped was read back as in progress — the extension's exact bug");
      assert.ok(!fs.existsSync(path.join(root, "src")), "the plan engine wrote outside .inflynx");

      // The plan tool is offered where the model is told to use it.
      const names = (mode: string) => filterToolsForMode(CORE_TOOLS as never, mode as never).map((t) => t.name);
      assert.ok(names("plan").includes("update_plan"), "[plan] hid the tool plan.txt mandates");
      assert.ok(names("agent").includes("update_plan"));
      assert.ok(!names("ask").includes("update_plan"), "[ask] must not offer a writer");
      // git stays graded at the gateway; [plan] may at least be given the tool.
      assert.ok(names("plan").includes("git"), "[plan] hid git entirely, so its fence had nothing to grade");
      assert.ok(!names("ask").includes("patch_file") && !names("ask").includes("execute_shell"));
      console.log("✓ Test 8 Passed: engines share one format; markStep keeps status honest; modes offer the tool.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 9: the registry contract the UIs read ───────────────────────────
  {
    const tools = new ToolRegistry(CORE_TOOLS).list();
    const planTool = tools.find((t) => t.name === "update_plan");
    assert.ok(planTool, "update_plan missing from CORE_TOOLS");
    assert.equal(planTool!.isMutating, true, "it writes a file and must not be treated as pure");
    assert.equal(planTool!.cacheable, false);
    assert.equal(planTool!.permissionLevel, "readwrite");
    assert.deepEqual(planTool!.parameters.required, ["goal", "steps"]);
    assert.ok(planTool!.parameters.properties.steps.items?.properties?.state, "nested step schema was lost");
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "delete_path", "edit_file", "execute_shell", "fetch_url", "find_definition", "git", "glob_files",
        "list_diagnostics", "list_directory", "list_symbols", "move_path", "patch_file", "read_file",
        "search_files", "shell_list", "shell_output", "shell_stop", "update_plan", "web_search", "write_file",
      ].sort(),
      `tool set drifted (${tools.length}) — update §2 baseline and docs together`);
    console.log(`✓ Test 9 Passed: ${tools.length} tools, update_plan mutating/non-cacheable with a nested schema.`);
  }

  // ── Test 10: buildPlanFromInput is pure — no touch, no write ─────────────
  {
    const built = buildPlanFromInput(
      { goal: "g", steps: [{ id: 1, title: "a", state: "completed" }, { id: 2, title: "b" }] },
      null, "2026-01-01T00:00:00.000Z");
    assert.equal(built.ok, true, JSON.stringify((built as { errors: string[] }).errors));
    if (built.ok) {
      assert.equal(built.plan.generatedAt, "2026-01-01T00:00:00.000Z", "the classifier invented a clock");
      assert.equal(built.plan.steps[1].status, "pending", "omitted state must mean pending");
      assert.equal(built.carriedOver, 0);
    }
    // "Pass the FULL step list" now has a teeth: even a completed step cannot be omitted.
    const narrowed = buildPlanFromInput(
      { goal: "g", steps: [{ id: 2, title: "b" }] },
      spec([step(1, { status: "completed", verificationCommand: "pnpm build" }), step(2)]), "2026-01-01T00:00:00.000Z");
    assert.equal(narrowed.ok, false, "a completed step was silently dropped from the plan");
    if (!narrowed.ok) assert.match(narrowed.errors.join(" "), /#1 \(completed\)/);

    // Same input, twice → identical output. Anything reading the filesystem or a clock
    // here would make the tool's validation non-deterministic.
    const again = buildPlanFromInput(
      { goal: "g", steps: [{ id: 1, title: "a", state: "completed" }, { id: 2, title: "b" }] },
      null, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(again.ok && again.plan, built.ok && built.plan, "validation is not pure");
    console.log("✓ Test 10 Passed: the validator is a pure function of its inputs.");
  }

  console.log("\n🎉 All Phase 26 update_plan Tests Passed 100%!");
}

runPhase26Tests().catch((err) => {
  console.error("Phase 26 test failed:", err);
  process.exit(1);
});

/**
 * Backlog Phase 31 — the verification gate wired into the agent loop.
 *
 * The engines already existed and were simply never called: `VerificationEngine` was
 * imported by exactly one place (the CLI's `/verify`, which listed checks and ran
 * none), and `runTurn` requested the `verifying` state and then went straight to
 * `completed`. That gap is C13/L3: "done" meant "the model stopped talking".
 *
 * These tests run real scripts in a temp workspace, because the properties under test
 * are "did the gate actually decide the turn's outcome", not "was a function called".
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { DEFAULT_EFFORT_PROFILES } from "../../packages/agent-core/src/orchestrator/BudgetManager.js";
import {
  VerificationEngine,
  resolvePackageManager,
} from "../../packages/agent-core/src/verification/VerificationEngine.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { AgentEventBus, type PublicAgentEvent } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

function sse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  return sse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] } }],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ]);
}

function textResponse(text: string): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

/** A workspace whose `typecheck` script prints a report line and fails, or passes. */
function makeProject(root: string, typecheckScript: string): void {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "gate-fixture", packageManager: "npm@10.0.0", scripts: { typecheck: typecheckScript } }, null, 2),
    "utf-8"
  );
  fs.writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n", "utf-8");
}

async function runVerificationGateTests(): Promise<void> {
  console.log("🧪 Running Phase 31 Verification Gate Tests...\n");

  // ── Test 1: the runner is detected, not assumed ─────────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-pm-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.12.3" }), "utf-8");
      fs.writeFileSync(path.join(root, "yarn.lock"), "", "utf-8");
      let res = resolvePackageManager(root);
      assert.equal(res.manager, "pnpm", "the packageManager field must outrank lockfile sniffing");
      assert.ok(/packageManager/.test(res.reason), "the reason does not say where it came from");

      fs.rmSync(path.join(root, "package.json"));
      assert.equal(resolvePackageManager(root).manager, "yarn", "lockfile detection failed");
      fs.rmSync(path.join(root, "yarn.lock"));
      fs.writeFileSync(path.join(root, "bun.lockb"), "", "utf-8");
      assert.equal(resolvePackageManager(root).manager, "bun", "bun lockfile not detected");
      fs.rmSync(path.join(root, "bun.lockb"));

      const bare = resolvePackageManager(root);
      assert.equal(bare.manager, "npm", "no-lockfile default is not npm");
      assert.ok(/no packageManager field/.test(bare.reason), "the fallback is not explained");

      assert.equal(resolvePackageManager(root, "yarn").manager, "yarn", "explicit override ignored");
      console.log("✓ Test 1 Passed: packageManager field → lockfiles → npm, each with a stated reason.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 2: depth and the repo's own script names drive discovery ───────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-disc-"));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          packageManager: "npm",
          scripts: { typecheck: "tsc", build: "node b.js", test: "node t.js", "test:unit": "node u.js", lint: "node l.js" },
        }),
        "utf-8"
      );

      const ids = (depth: "basic" | "standard" | "deep", full = true) =>
        new VerificationEngine("s", undefined, { depth, runFullRegressionSuite: full })
          .discoverWorkspaceChecks(root)
          .map((c) => c.id);

      assert.deepEqual(ids("basic"), ["typecheck"], "basic depth ran more than a typecheck");
      assert.deepEqual(ids("standard"), ["typecheck", "build"], "standard depth is not typecheck+build");
      assert.deepEqual(ids("deep"), ["typecheck", "build", "test", "lint"], "deep depth is missing checks");
      assert.deepEqual(
        ids("deep", false), ["typecheck", "build", "test:unit", "lint"],
        "runFullRegressionSuite:false did not prefer the declared fast subset"
      );

      const types = new VerificationEngine("s", undefined, { depth: "deep" })
        .discoverWorkspaceChecks(root);
      assert.equal(types.find((c) => c.id === "lint")!.isGate, false, "lint must not be a gate");
      assert.equal(types.find((c) => c.id === "typecheck")!.isGate, true, "typecheck must be a gate");
      assert.ok(
        types.every((c) => c.command === "npm"),
        "discovered checks still hard-code a runner other than the resolved one"
      );
      assert.ok(
        types.find((c) => c.id === "test")!.timeoutMs > types.find((c) => c.id === "lint")!.timeoutMs,
        "the test suite is given less time than the linter"
      );
      console.log("✓ Test 2 Passed: depth tiers, fast-subset preference, gate vs advisory, sane timeouts.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 3: nothing configured must never read as a pass ────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-nogate-"));
    try {
      const engine = new VerificationEngine("s", undefined, { depth: "deep" });
      assert.deepEqual(engine.discoverWorkspaceChecks(root), [], "a bare directory should discover nothing");

      const summary = await engine.runAllChecks(root);
      assert.equal(summary.noChecksDiscovered, true, "the empty case is not labelled");
      assert.equal(summary.passed, false, "an empty workspace reported a green gate — the false-pass this guards");
      assert.ok(
        /nothing was verified|not a pass/i.test(summary.summaryMessage),
        `the message hides that nothing ran: ${summary.summaryMessage}`
      );
      console.log("✓ Test 3 Passed: zero checks means 'nothing was verified', never 'passed'.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 4: a failing check keeps its own report ────────────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-stdout-"));
    try {
      const engine = new VerificationEngine("s");
      const result = await engine.runCheck(
        {
          id: "typecheck", name: "Failing Check", type: "typecheck",
          command: "sh", args: ["-c", "echo 'app.ts(3,1): error TS2345: the actual report'; exit 1"],
          timeoutMs: 20_000, isGate: true,
        },
        root
      );
      assert.equal(result.passed, false);
      assert.equal(result.exitCode, 1, "the exit code was not reported");
      assert.ok(
        result.stdout.includes("the actual report"),
        `stdout was thrown away on failure — the repair loop would have had nothing to read: ${JSON.stringify(result)}`
      );
      assert.equal(result.timedOut, false, "a genuine failure was labelled a timeout");
      assert.ok(
        result.parsedErrors.some((e) => e.filePath === "app.ts" && e.line === 3 && e.code === "TS2345"),
        `the parser did not extract the location: ${JSON.stringify(result.parsedErrors)}`
      );
      console.log("✓ Test 4 Passed: failure keeps stdout, exit code, and parsed file:line locations.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: a timeout is not reported as a broken build ─────────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-timeout-"));
    try {
      const result = await new VerificationEngine("s").runCheck(
        {
          id: "build", name: "Slow Build", type: "build",
          command: "sh", args: ["-c", "sleep 5"], timeoutMs: 700, isGate: true,
        },
        root
      );
      assert.equal(result.passed, false);
      assert.equal(result.timedOut, true, "a timed-out check is not distinguishable from a failed one");
      assert.ok(
        /not a code failure/i.test(result.stderr),
        `the report does not tell the agent to stop \"fixing\" it: ${result.stderr}`
      );
      console.log("✓ Test 5 Passed: a cut-off check says 'not a code failure', so the repair loop chases nothing.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 6: the loop — edit → gate fails → repair → gate → report ──────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-gate-loop-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      makeProject(root, "echo 'THE GATE SAID NO'; exit 1");

      const states: string[] = [];
      const events: string[] = [];
      const bus = new AgentEventBus();
      bus.on("state.changed", (evt: PublicAgentEvent) => {
        states.push(String((evt.payload as any).currentState));
      });
      for (const type of ["verification.started", "verification.finished", "repair.attempted"] as const) {
        bus.on(type, (evt: PublicAgentEvent) => { events.push(evt.type); });
      }

      let request = 0;
      (globalThis as any).fetch = async () => {
        request++;
        // 1: write a source file. 2: gate fails, model claims it is done.
        // 3: gate fails again, model tries an edit. 4+: gate fails, budget spent.
        if (request === 1) return toolCall("write_file", { path: "app.ts", content: "export const x = 2;\n" });
        return textResponse("all good");
      };

      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never,
        bus as never,
        async () => true,
        "low",
        new LocalJsonSessionStore(root) as never
      );

      const turn = await orchestrator.runTurn("change app.ts");

      assert.ok(states.includes("verifying"), `the gate never ran; states were [${states.join(" → ")}]`);
      assert.ok(states.includes("repairing"), `no repair attempt was made; states were [${states.join(" → ")}]`);
      const verifyCount = states.filter((s) => s === "verifying").length;
      assert.ok(
        states.indexOf("repairing") > states.indexOf("verifying"),
        `the trace is out of order: [${states.join(" → ")}]`
      );
      // One initial gate plus one re-check per repair — the state machine must run the
      // gate on every repair round, not just the first.
      assert.equal(
        verifyCount,
        DEFAULT_EFFORT_PROFILES.low.maxVerificationRuns + 1,
        `the gate ran a different number of times than the profile budget allows`
      );
      console.log(`✓ Test 6 Passed: the turn traced implementing → verifying → repairing → verifying (${verifyCount} gate runs).`);

      // ── Test 7 (same fixture): the outcome and the corrective message ───────
      assert.ok(turn.verification, "the turn reported no gate result for a source edit");
      assert.equal(turn.verification!.outcome, "failed", `wrong outcome: ${turn.verification!.outcome}`);
      assert.ok(turn.verification!.failedChecks.length > 0, "the failed gate is not named");
      assert.deepEqual(turn.verification!.sourceFilesChanged, ["app.ts"], "the changed file is not reported");
      assert.equal(turn.verification!.packageManager, "npm", "the resolved runner is not in the report");
      assert.ok(turn.verification!.repairAttempts >= 1, "the repair count is not reported");
      assert.ok(/THE GATE SAID NO/.test(turn.verification!.summaryMessage) === false, "raw output leaked into the summary");

      // The gate must actually cap how many repairs it attempts, or a repo that simply
      // does not build traps the agent until the wall-clock budget runs out. Derived
      // from the profile rather than recited: this suite runs the "low" effort level.
      const profileBudget = DEFAULT_EFFORT_PROFILES.low.maxVerificationRuns;
      assert.ok(
        turn.verification!.repairAttempts <= profileBudget,
        `repair budget ignored: ${turn.verification!.repairAttempts} attempts (cap ${profileBudget})`
      );
      // Equal, not just under: the only thing that should stop a permanently-failing
      // gate is the budget running out. An early exit would mean silent give-up.
      assert.equal(
        turn.verification!.repairAttempts,
        profileBudget,
        `the gate gave up after ${turn.verification!.repairAttempts} repair(s) of ${profileBudget} allowed`
      );
      assert.ok(request <= 1 + profileBudget + 2, `the loop ran away: ${request} provider requests`);

      assert.ok(events.includes("verification.started"), "verification.started was never emitted");
      assert.ok(events.includes("verification.finished"), "verification.finished was never emitted");
      assert.ok(events.includes("repair.attempted"), "repair.attempted was never emitted");
      console.log(
        `✓ Test 7 Passed: outcome=failed after ${turn.verification!.repairAttempts} repair attempt(s), ` +
        `${events.length} UI-visible events, ${request} provider calls.`
      );

      // The failure text the model was shown must contain the real report — that is
      // the difference between a repair loop and a retry loop.
      const shownToModel = (orchestrator as any).context.history.filter((m: any) => m.role === "user");
      const repairMessages = shownToModel.filter((m: any) => /verification gate ran after your edits/i.test(m.content));
      assert.ok(repairMessages.length >= 1, "no corrective message was sent back to the model");
      assert.ok(
        repairMessages[0].content.includes("THE GATE SAID NO"),
        `the repair prompt omits the actual failure: ${repairMessages[0].content.slice(0, 200)}`
      );
      assert.ok(
        /do not suppress|fake fix/i.test(repairMessages[0].content),
        "the repair prompt does not forbid the fake-fix escape hatches"
      );
      console.log("✓ Test 8 Passed: the model was shown the real failing output, not just 'it failed'.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 9: a green gate lets the turn complete, honestly ───────────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-gate-pass-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      makeProject(root, "echo 'typecheck ok'");
      let request = 0;
      (globalThis as any).fetch = async () => {
        request++;
        if (request === 1) return toolCall("write_file", { path: "app.ts", content: "export const x = 3;\n" });
        return textResponse("done and verified");
      };

      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,
        "low",
        new LocalJsonSessionStore(root) as never
      );
      const turn = await orchestrator.runTurn("edit app.ts");

      assert.equal(turn.verification?.outcome, "passed", `gate outcome: ${JSON.stringify(turn.verification)}`);
      assert.equal(turn.verification!.failedChecks.length, 0);
      assert.equal(turn.state, "completed");
      assert.equal(turn.isCompleted, true);
      console.log("✓ Test 9 Passed: a passing gate completes the turn with outcome=passed.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 10: the gate must not tax read-only or plan-mode work ──────────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-gate-skip-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      makeProject(root, "echo 'never runs'; exit 1");
      const run = async (mode: "ask" | "plan" | "agent", toolName: string, args: Record<string, unknown>) => {
        let request = 0;
        (globalThis as any).fetch = async () => {
          request++;
          if (request === 1) return toolCall(toolName, args);
          return textResponse("ok");
        };
        const states: string[] = [];
        const gateEvents: string[] = [];
        const verifyReasons: string[] = [];
        const bus = new AgentEventBus();
        bus.on("state.changed", (evt: PublicAgentEvent) => {
          states.push(String((evt.payload as any).currentState));
          if ((evt.payload as any).currentState === "verifying") {
            verifyReasons.push(String((evt.payload as any).reason));
          }
        });
        for (const type of ["verification.started", "verification.finished", "repair.attempted"] as const) {
          bus.on(type, (evt: PublicAgentEvent) => { gateEvents.push(evt.type); });
        }
        const orchestrator = await AgentOrchestrator.start(
          { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: mode, modelAdapter: "openai-chat" },
          new ToolRegistry(CORE_TOOLS) as never,
          bus as never,
          async () => true,
          "low",
          new LocalJsonSessionStore(root) as never
        );
        const turn = await orchestrator.runTurn("do it");
        return { turn, states, gateEvents, verifyReasons, requests: request };
      };

      // A turn that only reads must not pay for the gate. The `verifying` label alone is
      // not the tell — `implementing → verifying` is the only legal way out of
      // `implementing`, and *any* tool call (a read included) lands there. The gate's
      // own evidence is checks, events and a report; and this fixture's typecheck exits
      // 1, so a gate that ran could not hide — it would report failure or repair rounds.
      const read = await run("agent", "read_file", { path: "app.ts" });
      assert.equal(read.turn.verification, undefined, "a read-only turn reported a gate result");
      assert.equal(read.gateEvents.length, 0, `a read-only turn ran the gate: [${read.gateEvents.join(", ")}]`);
      assert.ok(!read.states.includes("repairing"), "a read-only turn attempted a repair");
      assert.equal(read.requests, 2, `a read-only turn burned extra model turns: ${read.requests}`);
      // The lifecycle transit is allowed; it must not *claim* that checks ran.
      assert.ok(read.verifyReasons.length >= 1, "no `verifying` state at all — this assertion is vacuous");
      assert.ok(
        read.verifyReasons.every((r) => /not applicable/i.test(r)),
        `the verifying state claims checks ran for a read-only turn: ${JSON.stringify(read.verifyReasons)}`
      );

      // A plan-mode write to .inflynx/PLAN.md is the mode's purpose, not a source edit.
      const plan = await run("plan", "write_file", { path: ".inflynx/PLAN.md", content: "# Plan\n" });
      assert.equal(plan.turn.verification, undefined, "a PLAN.md write triggered the source gate");
      assert.equal(plan.gateEvents.length, 0, `a PLAN.md write ran the gate: [${plan.gateEvents.join(", ")}]`);
      assert.ok(fs.existsSync(path.join(root, ".inflynx", "PLAN.md")), "the plan write itself failed");

      console.log(
        `✓ Test 10 Passed: read-only turns and .inflynx/ writes run zero checks and emit ` +
        `zero gate events (${read.gateEvents.length + plan.gateEvents.length}).`
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("\n🎉 All Phase 31 Verification Gate Tests Passed 100%!");
}

runVerificationGateTests().catch((err) => {
  console.error("Verification gate test failed:", err);
  process.exit(1);
});

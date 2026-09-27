/**
 * Integration Test for Phase 6 — TaskClassifier, context relief & StructuredPlanEngine
 *
 * The context half of this suite used to exercise `ContextManager`, a class nothing in
 * the agent ever fed. It was retired (backlog Phase 15) and these assertions now run
 * against the machinery that actually protects the window: `ExecutionContext`.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { TaskClassifier } from "../../packages/agent-core/src/planning/TaskClassifier.js";
import { ExecutionContext } from "../../packages/agent-core/src/orchestrator/ExecutionContext.js";
import { StructuredPlanEngine } from "../../packages/agent-core/src/planning/StructuredPlan.js";
import { cleanupOnExit } from "../helpers/tmp.js";

async function runPhase6Tests() {
  console.log("🧪 Running Phase 6 Task Classifier, Context Manager & Structured Planning Tests...\n");

  // Test 1: TaskClassifier — Intent Detection
  const secAudit = TaskClassifier.classify("Run a security audit for path traversal and shell injection");
  if (secAudit.category === "security_audit" && secAudit.recommendedMode === "debug" && secAudit.recommendedEffort === "high") {
    console.log("✓ Test 1 Passed: Security audit task classified correctly ->", secAudit.category, secAudit.recommendedMode);
  } else {
    console.error("❌ Test 1 Failed: Task classification invalid:", secAudit);
    process.exit(1);
  }

  const questionTask = TaskClassifier.classify("Explain how CanonicalPathGuard works");
  if (questionTask.category === "question" && questionTask.recommendedMode === "ask") {
    console.log("✓ Test 2 Passed: Read-only advisory question classified correctly ->", questionTask.recommendedMode);
  } else {
    console.error("❌ Test 2 Failed: Question task classification invalid:", questionTask);
    process.exit(1);
  }

  // Test 3: context relief — stale tool output goes, pinned content stays
  {
    const context = new ExecutionContext({
      workspaceRoot: os.tmpdir(),
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "mock_key",
    });
    context.addMessage({ role: "system", content: "System Prompt" });
    context.addMessage({ role: "user", content: "High Priority Active Error Log" });
    for (let i = 0; i < 4; i++) {
      context.addMessage({
        role: "assistant",
        content: `looking into step ${i}`,
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "search_files", arguments: "{}" } }],
      });
      context.addMessage({ role: "tool", content: "Low Priority Search Snippet ".repeat(40), tool_call_id: `c${i}` });
    }

    const beforeChars = context.history.reduce((n, m) => n + m.content.length, 0);
    const relief = context.evictStaleToolResults({ protectRecentMessages: 2 });
    const afterChars = context.history.reduce((n, m) => n + m.content.length, 0);

    if (
      relief.dropped === 3 &&
      afterChars < beforeChars &&
      context.history[0].content === "System Prompt" &&
      context.history[1].content === "High Priority Active Error Log" &&
      context.history.every((m) => m.role !== "tool" || m.tool_call_id)
    ) {
      console.log(
        `✓ Test 3 Passed: eviction freed ${(beforeChars - afterChars).toLocaleString()} chars, ` +
        `kept the pinned system prompt and the user's request, and every tool_call_id still has a response.`
      );
    } else {
      console.error("❌ Test 3 Failed: context relief dropped the wrong things!", relief, beforeChars, afterChars);
      process.exit(1);
    }

    // A compaction plan must never cut through a tool round, or providers reject the
    // next request outright.
    const plan = context.compactionPlan({ keepRecentMessages: 2 });
    if (plan && context.history[plan.end - 1]?.role === "tool") {
      console.error("❌ Test 3 Failed: compaction plan ended on a tool result — split round.");
      process.exit(1);
    }
  }

  // Test 4: summarization compaction — history shrinks, integrity survives
  {
    const context = new ExecutionContext({
      workspaceRoot: os.tmpdir(),
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "mock_key",
    });
    context.addMessage({ role: "system", content: "You are Inflynx Agent." });
    context.addMessage({ role: "user", content: "ORIGINAL TASK: fix the path guard" });
    for (let i = 0; i < 8; i++) {
      context.addMessage({
        role: "assistant",
        content: `reading round ${i}`,
        tool_calls: [{ id: `r${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      context.addMessage({ role: "tool", content: `output ${i} `.repeat(300), tool_call_id: `r${i}` });
    }

    const plan = context.compactionPlan({ keepRecentMessages: 4 });
    const beforeLength = context.history.length;
    if (!plan) {
      console.error("❌ Test 4 Failed: no compaction plan for a heavy prefix.");
      process.exit(1);
    }

    const applied = context.applyCompaction(plan, "Round 0-3 read the guard and found nothing wrong.");
    const stillConsistent = context.ensureHistoryIntegrity();

    if (
      applied.dropped === plan.messages.length &&
      applied.charsFreed > 0 &&
      context.history.length === beforeLength - applied.dropped + 1 &&
      stillConsistent.length === 0 &&
      context.history[0].role === "system" &&
      context.history.some((m) => m.content.startsWith("ORIGINAL TASK")) &&
      context.history.some((m) => m.content.startsWith("[Earlier conversation summarized")) &&
      context.history.at(-1)!.content.startsWith("output 7")
    ) {
      console.log(
        `✓ Test 4 Passed: folded ${applied.dropped} messages into one summary ` +
        `(${applied.charsFreed.toLocaleString()} chars freed), task statement and recent rounds intact, ` +
        `and the rewritten history needed no integrity repair.`
      );
    } else {
      console.error("❌ Test 4 Failed: compaction broke the history.", applied, context.history.map((m) => m.role));
      process.exit(1);
    }
  }

  // Tests 5 & 6: StructuredPlanEngine — DAG Step Dependency Resolution
  // Scoped to a temp dir: `process.cwd()` here used to overwrite the developer's real
  // `.inflynx/PLAN.md` with a fictional plan on every `pnpm test:unit` (backlog M10).
  // Moving out of the repo is only half of M10 — the dir must also go away, or the fix
  // just relocates the litter. `finally` cannot cover this file because the failure paths
  // call `process.exit(1)`, which skips it; the `exit` hook does cover those.
  const planRoot = cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-plan-")));
  const planEngine = new StructuredPlanEngine(planRoot);
  planEngine.createPlan("Migrate to Shared Orchestrator", "HIGH", [
    { id: 1, title: "Create StateMachine", description: "Build state machine", targetFiles: ["src/StateMachine.ts"], risk: "LOW", dependencies: [] },
    { id: 2, title: "Build AgentOrchestrator", description: "Build orchestrator", targetFiles: ["src/AgentOrchestrator.ts"], risk: "MEDIUM", dependencies: [1] },
    { id: 3, title: "Refactor apps/cli", description: "Connect CLI", targetFiles: ["apps/cli/src/index.ts"], risk: "HIGH", dependencies: [2] },
  ]);

  const executable1 = planEngine.getExecutableNextSteps();
  if (executable1.length === 1 && executable1[0].id === 1) {
    console.log("✓ Test 6 Passed: DAG step dependencies enforced (Only Step 1 executable initially).");
  } else {
    console.error("❌ Test 6 Failed: Unexpected initial executable steps:", executable1);
    process.exit(1);
  }

  // Complete Step 1 -> Step 2 becomes executable
  planEngine.updateStepStatus(1, "completed");
  const executable2 = planEngine.getExecutableNextSteps();
  if (executable2.length === 1 && executable2[0].id === 2) {
    console.log("✓ Test 7 Passed: DAG dependency unlocking succeeded (Step 2 unlocked after Step 1 completed).");
  } else {
    console.error("❌ Test 7 Failed: Dependency unlocking failed:", executable2);
    process.exit(1);
  }

  console.log("\n🎉 All Phase 6 Planning & Context Tests Passed Successfully!");
}

runPhase6Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

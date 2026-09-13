/**
 * Integration Test for Phase 6 — TaskClassifier, ContextManager & StructuredPlanEngine
 */

import { TaskClassifier } from "../../packages/agent-core/src/planning/TaskClassifier.js";
import { ContextManager } from "../../packages/agent-core/src/context/ContextManager.js";
import { StructuredPlanEngine } from "../../packages/agent-core/src/planning/StructuredPlan.js";

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

  // Test 2: ContextManager — Token Budget Compaction & Deduplication
  const contextManager = new ContextManager(100); // Strict 100 token limit
  contextManager.addItem({ content: "System Prompt", priority: "pinned", category: "system" });
  contextManager.addItem({ content: "High Priority Active Error Log", priority: "high", category: "error" });
  contextManager.addItem({ content: "Low Priority Search Snippet ".repeat(20), priority: "low", category: "tool_result" });

  const compacted = contextManager.compactContext();
  const totalTokens = contextManager.getTotalTokens();

  if (totalTokens <= 100 && compacted.some((item) => item.priority === "pinned")) {
    console.log(`✓ Test 3 Passed: ContextManager compacted content cleanly (${totalTokens} <= 100 tokens).`);
  } else {
    console.error("❌ Test 3 Failed: Context compaction failed!", totalTokens, compacted);
    process.exit(1);
  }

  // Test 3: StructuredPlanEngine — DAG Step Dependency Resolution
  const planEngine = new StructuredPlanEngine(process.cwd());
  planEngine.createPlan("Migrate to Shared Orchestrator", "HIGH", [
    { id: 1, title: "Create StateMachine", description: "Build state machine", targetFiles: ["src/StateMachine.ts"], risk: "LOW", dependencies: [] },
    { id: 2, title: "Build AgentOrchestrator", description: "Build orchestrator", targetFiles: ["src/AgentOrchestrator.ts"], risk: "MEDIUM", dependencies: [1] },
    { id: 3, title: "Refactor apps/cli", description: "Connect CLI", targetFiles: ["apps/cli/src/index.ts"], risk: "HIGH", dependencies: [2] },
  ]);

  const executable1 = planEngine.getExecutableNextSteps();
  if (executable1.length === 1 && executable1[0].id === 1) {
    console.log("✓ Test 4 Passed: DAG step dependencies enforced (Only Step 1 executable initially).");
  } else {
    console.error("❌ Test 4 Failed: Unexpected initial executable steps:", executable1);
    process.exit(1);
  }

  // Complete Step 1 -> Step 2 becomes executable
  planEngine.updateStepStatus(1, "completed");
  const executable2 = planEngine.getExecutableNextSteps();
  if (executable2.length === 1 && executable2[0].id === 2) {
    console.log("✓ Test 5 Passed: DAG dependency unlocking succeeded (Step 2 unlocked after Step 1 completed).");
  } else {
    console.error("❌ Test 5 Failed: Dependency unlocking failed:", executable2);
    process.exit(1);
  }

  console.log("\n🎉 All Phase 6 Planning & Context Manager Tests Passed Successfully!");
}

runPhase6Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

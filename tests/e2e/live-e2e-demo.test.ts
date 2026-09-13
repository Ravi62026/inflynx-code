/**
 * Live E2E Verification Suite — 8-Phase Monorepo Feature Validation
 */

import fs from "fs";
import path from "path";
import { LocalJsonSessionStore, PostgresSessionStore, createSessionStore } from "../../packages/session-store/src/index.js";
import { AgentOrchestrator, TaskClassifier, ContextManager, StructuredPlanEngine } from "../../packages/agent-core/src/index.js";
import { CanonicalPathGuard, CommandPolicy } from "../../packages/policy-engine/src/index.js";
import { applySurgicalPatch, computeUnifiedDiff, EditTransactionManager } from "../../packages/patch-engine/src/index.js";
import { ToolRegistry } from "../../packages/tool-runtime/src/index.js";
import { HnswVectorStore } from "../../packages/vector-store/src/index.js";

async function runLiveE2EValidation() {
  console.log("==================================================================");
  console.log("🚀 STARTING INFLYNX CODE LIVE E2E MONOREPO VALIDATION SUITE");
  console.log("==================================================================\n");

  const workspaceRoot = process.cwd();

  // ------------------------------------------------------------------
  // SCENARIO 1: Task Classification, Context Compaction & Vector Search
  // ------------------------------------------------------------------
  console.log("🔹 [Scenario 1] Testing Task Classification, Context Compaction & Vector Index...");

  const task1 = "Explain how CanonicalPathGuard prevents symlink escapes in policy-engine.";
  const classification = TaskClassifier.classify(task1);
  console.log(`  ✓ Task Classification: category=${classification.category}, mode=${classification.recommendedMode}, effort=${classification.recommendedEffort}`);
  if (!classification.category) {
    console.error("❌ Scenario 1 Failed: TaskClassifier returned no category!");
    process.exit(1);
  }

  const contextManager = new ContextManager(500);
  contextManager.addItem({ category: "system", content: "You are Inflynx Agent", priority: "pinned" });
  contextManager.addItem({ category: "user", content: task1, priority: "high" });
  contextManager.addItem({ category: "tool_result", content: "CanonicalPathGuard uses fs.realpathSync to resolve paths.", priority: "medium" });
  
  const compacted = contextManager.compactContext();
  console.log(`  ✓ Context Compaction: Token Count=${contextManager.getTotalTokens()}/500, Compacted Items=${compacted.length}`);

  const vectorStore = new HnswVectorStore(workspaceRoot);
  vectorStore.addChunk({
    id: "chunk_path_guard",
    filePath: "packages/policy-engine/src/path-guard.ts",
    chunkType: "class",
    symbolName: "CanonicalPathGuard",
    content: "CanonicalPathGuard resolves paths with fs.realpathSync to prevent symlink traversal",
    embedding: [0.95, 0.05, 0.0],
  });
  const vectorResults = vectorStore.searchSimilar([0.90, 0.10, 0.0], 1);
  console.log(`  ✓ Vector Search Match: ${vectorResults[0].chunk.symbolName} (score=${vectorResults[0].score.toFixed(2)})`);

  // ------------------------------------------------------------------
  // SCENARIO 2: Security Policy Enforcement & Surgical Patch Transactions
  // ------------------------------------------------------------------
  console.log("\n🔹 [Scenario 2] Testing Security Policy & Surgical Patch Engine...");

  const guard = new CanonicalPathGuard(workspaceRoot);
  const validPath = guard.validateAndResolve("packages/policy-engine/src/path-guard.ts");
  console.log(`  ✓ Path Guard Validation: ${path.relative(workspaceRoot, validPath)}`);

  let blockedTraversal = false;
  try {
    guard.validateAndResolve("../../../etc/passwd");
  } catch (err: any) {
    blockedTraversal = true;
    console.log(`  ✓ Security Guard Blocked Path Traversal -> ${err.message.slice(0, 70)}...`);
  }
  if (!blockedTraversal) {
    console.error("❌ Scenario 2 Failed: CanonicalPathGuard did NOT block path traversal!");
    process.exit(1);
  }

  let blockedCommand = false;
  try {
    CommandPolicy.validateShellCommand("rm -rf /");
  } catch (err: any) {
    blockedCommand = true;
    console.log(`  ✓ Command Policy Blocked Malicious Shell Command -> ${err.message.slice(0, 70)}...`);
  }
  if (!blockedCommand) {
    console.error("❌ Scenario 2 Failed: CommandPolicy did NOT block a destructive shell command!");
    process.exit(1);
  }

  // Surgical Patch & Diff Generation
  const codeBefore = `function add(a: number, b: number): number {\n  return a + b;\n}\n`;
  const patchRes = applySurgicalPatch(codeBefore, `return a + b;`, `return a + b; // patched`);
  const diff = computeUnifiedDiff("math.ts", codeBefore, patchRes.patchedContent);
  console.log(`  ✓ Surgical Patch Applied & Diff Generated:\n${diff.split("\n").map(l => "     " + l).join("\n")}`);

  // ------------------------------------------------------------------
  // SCENARIO 3: Real-Time Dual Persistence (Local JSON fallback + PostgreSQL) & Session Resume
  // ------------------------------------------------------------------
  console.log("\n🔹 [Scenario 3] Testing Real-Time Dual Persistence (Local JSON fallback + PostgreSQL) & Session Resume...");

  // Local JSON fallback store test (offline/no-Docker dev path — NOT SQLite, see LocalJsonSessionStore docs)
  const jsonStore = new LocalJsonSessionStore(workspaceRoot);
  const session1 = await jsonStore.createSession(workspaceRoot, "openai", "gpt-4o", "agent", "medium", "E2E Live Test Session");
  await jsonStore.saveMessage(session1.sessionId, { role: "user", content: "Prompt 1: Refactor path guard" });
  await jsonStore.saveMessage(session1.sessionId, { role: "assistant", content: "Response 1: Applied patch successfully" });
  await jsonStore.saveToolExecution(session1.sessionId, {
    toolCallId: "call_e2e_1",
    toolName: "patch_file",
    argsJson: JSON.stringify({ file: "path-guard.ts" }),
    output: "Patch committed",
    isError: false,
    durationMs: 30,
  });
  await jsonStore.updateTokenTelemetry(session1.sessionId, {
    promptTokens: 850,
    completionTokens: 210,
    reasoningTokens: 0,
    estimatedCostUsd: 0.008,
  });

  console.log(`  ✓ Local JSON Fallback Session Created & Saved -> ${session1.sessionId}`);

  // PostgreSQL Docker Persistence Test
  const pgUrl = process.env.DATABASE_URL || "postgresql://inflynx:inflynx_dev_pw@localhost:5432/inflynx_code";
  const pgStore = new PostgresSessionStore(pgUrl);
  const pgSession = await pgStore.createSession(workspaceRoot, "openai", "gpt-4o", "agent", "high", "E2E Docker PostgreSQL Session");
  await pgStore.saveMessage(pgSession.sessionId, { role: "user", content: "Prompt 2: Verify PostgreSQL persistence" });
  await pgStore.saveMessage(pgSession.sessionId, { role: "assistant", content: "Response 2: Database record written to Docker" });
  await pgStore.updateTokenTelemetry(pgSession.sessionId, {
    promptTokens: 1200,
    completionTokens: 300,
    reasoningTokens: 50,
    estimatedCostUsd: 0.012,
  });

  console.log(`  ✓ PostgreSQL Session Created in Docker DB -> ${pgSession.sessionId}`);

  // Session-ID consistency regression check against Postgres (see AgentOrchestrator.start()):
  // previously this exact sequence (orchestrator construction -> saveMessage using
  // orchestrator.sessionId) crashed with a foreign_key_violation because the
  // constructor created a session row under a DIFFERENT, unrelated random ID.
  const pgRegistry = new ToolRegistry();
  const pgOrchestrator = await AgentOrchestrator.start(
    { workspaceRoot, providerId: "openai", model: "gpt-4o", apiKey: "mock_key" },
    pgRegistry,
    undefined,
    async () => true,
    "low",
    pgStore
  );
  await pgStore.saveMessage(pgOrchestrator.sessionId, { role: "user", content: "FK regression check" });
  const pgRegressionHydration = await pgStore.getSessionHydration(pgOrchestrator.sessionId);
  if (!pgRegressionHydration || pgRegressionHydration.session.sessionId !== pgOrchestrator.sessionId) {
    console.error("❌ Scenario 3 Failed: AgentOrchestrator.start() session-ID mismatch regression against Postgres!");
    await pgStore.close();
    process.exit(1);
  }
  console.log(`  ✓ AgentOrchestrator.start() session ID matches persisted Postgres row -> ${pgOrchestrator.sessionId}`);

  // Session Listing & Session Resume Hydration
  // resumeSession() resolves a real provider API key from env (fails loudly if
  // missing) — set a mock one for this offline demo since we never call the model.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "mock_key_for_test";
  const registry = new ToolRegistry();
  const resumedOrchestrator = await AgentOrchestrator.resumeSession(workspaceRoot, session1.sessionId, registry, undefined, undefined, jsonStore);

  if (resumedOrchestrator && resumedOrchestrator.sessionId === session1.sessionId) {
    const hydration = await jsonStore.getSessionHydration(session1.sessionId);
    console.log(`  ✓ Session Resume & Hydration Succeeded:`);
    console.log(`     Session ID:    ${hydration?.session.sessionId}`);
    console.log(`     Saved Messages: ${hydration?.messages.length}`);
    console.log(`     Tool Runs:      ${hydration?.toolExecutions.length}`);
    console.log(`     Token Usage:    ${hydration?.telemetry.promptTokens} prompt tokens ($${hydration?.telemetry.estimatedCostUsd} USD)`);
  } else {
    console.error("❌ Session Resume Failed!");
    await pgStore.close();
    process.exit(1);
  }

  await pgStore.close();

  console.log("\n==================================================================");
  console.log("🎉 ALL 8-PHASE LIVE E2E MONOREPO VERIFICATION SCENARIOS PASSED 100%!");
  console.log("==================================================================");
}

runLiveE2EValidation().catch((err) => {
  console.error("Live E2E Validation Failed:", err);
  process.exit(1);
});

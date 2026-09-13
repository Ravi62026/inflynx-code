/**
 * Integration Test for Phase 3 — Shared Core Orchestrator, State Machine & Event Bus
 */

import { AgentEventBus, type PublicAgentEvent } from "../../packages/protocol/src/index.js";
import { StateMachine } from "../../packages/agent-core/src/orchestrator/StateMachine.js";
import { BudgetManager } from "../../packages/agent-core/src/orchestrator/BudgetManager.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";

async function runPhase3Tests() {
  console.log("🧪 Running Phase 3 Shared Core Orchestrator & State Machine Tests...\n");

  const sessionId = "test_sess_101";
  const eventBus = new AgentEventBus();
  const emittedEvents: PublicAgentEvent[] = [];

  eventBus.on("*", (evt) => {
    emittedEvents.push(evt);
  });

  // Test 1: State Machine Legal & Illegal Transitions
  const stateMachine = new StateMachine(sessionId, eventBus);
  stateMachine.transitionTo("classifying");
  stateMachine.transitionTo("planning");
  stateMachine.transitionTo("exploring");
  console.log("✓ Test 1 Passed: Legal state transitions succeeded (idle -> classifying -> planning -> exploring).");

  try {
    stateMachine.transitionTo("completed"); // Illegal direct transition from exploring -> completed
    console.error("❌ Test 1 Failed: Illegal transition was not blocked!");
    process.exit(1);
  } catch (err: any) {
    console.log("✓ Test 1 Passed: Illegal transition blocked ->", err.message);
  }

  // Test 2: Budget Manager Counter & Hard Limits
  const budgetManager = new BudgetManager("low", sessionId, eventBus);
  const profile = budgetManager.getEffortProfile();
  for (let i = 0; i < profile.maxModelTurns; i++) {
    budgetManager.recordTurn();
  }

  const limitCheck = budgetManager.checkLimits();
  if (limitCheck.isExhausted && limitCheck.reason?.includes("Max model turns reached")) {
    console.log("✓ Test 2 Passed: BudgetManager hard-stop turn limit enforced ->", limitCheck.reason);
  } else {
    console.error("❌ Test 2 Failed: Budget limits not enforced!", limitCheck);
    process.exit(1);
  }

  // Test 3: Agent Event Bus Pub/Sub Emission
  if (emittedEvents.length > 0 && emittedEvents.some((e) => e.type === "state.changed")) {
    console.log(`✓ Test 3 Passed: EventBus captured ${emittedEvents.length} events successfully.`);
  } else {
    console.error("❌ Test 3 Failed: EventBus captured no state.changed events!");
    process.exit(1);
  }

  // Test 4: Agent Orchestrator Turn Initialization
  const registry = new ToolRegistry(CORE_TOOLS);
  const orchestrator = new AgentOrchestrator(
    {
      sessionId,
      workspaceRoot: process.cwd(),
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "mock_key",
    },
    registry,
    eventBus,
    async () => true, // auto-approve handler for tests
    "low"
  );

  if (orchestrator.sessionId === sessionId && orchestrator.state === "idle") {
    console.log("✓ Test 4 Passed: AgentOrchestrator initialized with session ID and idle state.");
  } else {
    console.error("❌ Test 4 Failed: Orchestrator initialization invalid!");
    process.exit(1);
  }

  console.log("\n🎉 All Phase 3 Core Orchestrator Tests Passed Successfully!");
}

runPhase3Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

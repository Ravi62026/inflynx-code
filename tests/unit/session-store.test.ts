/**
 * Unit & Integration Test for @inflynx/session-store & Session Resume Engine
 */

import fs from "fs";
import path from "path";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { ToolRegistry } from "../../packages/tool-runtime/src/index.js";

async function runSessionStoreTests() {
  console.log("💾 Running Session Persistence & Hydration Engine Tests...\n");

  const tmpWorkspace = path.join(process.cwd(), ".tmp_session_test");
  fs.mkdirSync(tmpWorkspace, { recursive: true });

  const store = new LocalJsonSessionStore(tmpWorkspace);

  // Test 1: Session Creation
  const session = await store.createSession(tmpWorkspace, "openai", "gpt-4o", "agent", "medium", "Test Session");
  if (session && session.sessionId.startsWith("session_") && session.title === "Test Session") {
    console.log("✓ Test 1 Passed: Session record created successfully ->", session.sessionId);
  } else {
    console.error("❌ Test 1 Failed: Session creation failed!", session);
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  // Test 2: Message Persistence
  await store.saveMessage(session.sessionId, { role: "user", content: "Hello Agent!" });
  await store.saveMessage(session.sessionId, { role: "assistant", content: "Hello User!" });

  // Test 3: Tool Execution Logging
  await store.saveToolExecution(session.sessionId, {
    toolCallId: "call_123",
    toolName: "read_file",
    argsJson: JSON.stringify({ path: "package.json" }),
    output: "File contents...",
    isError: false,
    durationMs: 45,
  });

  // Test 4: Token Telemetry Persistence
  await store.updateTokenTelemetry(session.sessionId, {
    promptTokens: 500,
    completionTokens: 120,
    reasoningTokens: 0,
    estimatedCostUsd: 0.005,
  });

  // Test 5: Session Hydration Retrieval
  const hydration = await store.getSessionHydration(session.sessionId);
  if (
    hydration &&
    hydration.messages.length === 2 &&
    hydration.toolExecutions.length === 1 &&
    hydration.telemetry.promptTokens === 500
  ) {
    console.log("✓ Test 2 Passed: Full session hydration retrieved cleanly.");
  } else {
    console.error("❌ Test 2 Failed: Hydration mismatch!", hydration);
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  // Test 6: AgentOrchestrator Session Hydration & Resume
  // resumeSession() resolves a real provider API key from env (fails loudly if
  // missing, rather than silently falling back to a fake key) — set a mock one
  // for this offline test since we never actually call the model.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "mock_key_for_test";
  const registry = new ToolRegistry();
  const resumedOrchestrator = await AgentOrchestrator.resumeSession(tmpWorkspace, session.sessionId, registry, undefined, undefined, store);

  if (resumedOrchestrator && resumedOrchestrator.sessionId === session.sessionId) {
    console.log("✓ Test 3 Passed: AgentOrchestrator resumed target session cleanly.");
  } else {
    console.error("❌ Test 3 Failed: Orchestrator resume failed!");
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  // ─── REGRESSION TEST: session-ID consistency bug ──────────────────────────
  // Previously, AgentOrchestrator's constructor always fired an un-awaited
  // sessionStore.createSession(...) that generated its OWN random ID,
  // disconnected from ExecutionContext.sessionId (the ID every persistence
  // call actually used). This proves AgentOrchestrator.start() creates the
  // row FIRST with the exact ID the orchestrator subsequently uses.
  const freshRegistry = new ToolRegistry();
  const orchestrator = await AgentOrchestrator.start(
    {
      workspaceRoot: tmpWorkspace,
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "mock_key",
    },
    freshRegistry,
    undefined,
    async () => true,
    "low",
    store
  );

  // Simulate what runTurn() does internally: persist against orchestrator.sessionId.
  await store.saveMessage(orchestrator.sessionId, { role: "user", content: "Does the ID match?" });
  const idCheckHydration = await store.getSessionHydration(orchestrator.sessionId);

  if (
    idCheckHydration &&
    idCheckHydration.session.sessionId === orchestrator.sessionId &&
    idCheckHydration.messages.some((m) => m.content === "Does the ID match?")
  ) {
    console.log(`✓ Test 4 Passed: AgentOrchestrator.start() session ID (${orchestrator.sessionId}) matches persisted row — no orphan/mismatch.`);
  } else {
    console.error("❌ Test 4 Failed: Session-ID mismatch regression detected! orchestrator.sessionId has no matching hydratable row.", {
      orchestratorSessionId: orchestrator.sessionId,
      idCheckHydration,
    });
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  // Phase 4: only non-secret model/profile references and opaque continuation
  // metadata are persisted; switching models creates a clean session boundary.
  await store.updateSessionModelConfig(orchestrator.sessionId, {
    provider: "openai",
    model: "gpt-5.6-luna",
    credentialProfileId: "credential_profile_ref_only",
    baseUrl: "https://api.openai.com/v1",
    reasoningEffort: "high",
    actualModel: "gpt-5.6-luna-2026-09-01",
  });
  await store.saveMessage(orchestrator.sessionId, {
    role: "assistant",
    content: "Calling a tool",
    providerMetadataJson: JSON.stringify({
      openaiResponseItems: [{ type: "reasoning", id: "rs_safe" }],
    }),
  });
  const phase4Hydration = await store.getSessionHydration(orchestrator.sessionId);
  const switched = await orchestrator.switchModel({
    providerId: "openai",
    model: "gpt-5.6-luna",
    apiKey: "mock_key",
    reasoningEffort: "low",
  });
  const switchedHydration = await store.getSessionHydration(switched.sessionId);
  if (
    phase4Hydration?.session.credentialProfileId === "credential_profile_ref_only" &&
    phase4Hydration.session.actualModel === "gpt-5.6-luna-2026-09-01" &&
    phase4Hydration.messages.some((message) => message.providerMetadataJson?.includes("rs_safe")) &&
    switched.sessionId !== orchestrator.sessionId &&
    switchedHydration?.messages.length === 0
  ) {
    console.log("✓ Test 5 Passed: Profile references/continuations persist safely and model switching starts a new session.");
  } else {
    console.error("❌ Test 5 Failed: Phase 4 persistence or model-switch session boundary was incorrect.", {
      phase4Hydration,
      switchedHydration,
    });
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  // Cleanup
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  console.log("\n🎉 All Session Store & Resume Tests Passed 100%!");
}

runSessionStoreTests().catch((err) => {
  console.error("Session store test failed:", err);
  process.exit(1);
});

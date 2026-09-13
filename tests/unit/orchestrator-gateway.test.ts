/**
 * Integration Test for Phase 2 — AgentOrchestrator.runTurn() Gateway Enforcement
 *
 * CLI and TUI no longer run their own tool-execution loops; both now call
 * `AgentOrchestrator.runTurn()` exclusively. This suite proves — at the one
 * shared code path both apps now depend on — that:
 *   1. Mode-based tool restrictions (e.g. no mutations in [ask] mode) are
 *      enforced by `ToolExecutionGateway`, not bypassable by an approval "yes".
 *   2. A denied approval actually prevents the tool from running at all.
 *   3. `readonly` tools are auto-approved and never even reach the custom
 *      approval handler.
 *   4. An approved mutating tool call actually executes AND is persisted to
 *      SessionStore (message + tool-execution row).
 *
 * `streamModel()` talks to real provider HTTP APIs — since we only care about
 * verifying what happens once the model *proposes* a tool call, we stub
 * `global.fetch` to return a canned OpenAI-compatible SSE stream instead of
 * hitting the network or requiring a real API key.
 */

import fs from "fs";
import path from "path";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

// ─── Fake streamModel() transport (OpenAI-compatible SSE over fetch) ────────────

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** First streamModel() call in a turn: proposes exactly one tool call. */
function toolCallResponse(toolName: string, args: Record<string, unknown>): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_test_1", function: { name: toolName, arguments: "" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ]);
}

/** Follow-up streamModel() call: plain final answer, no more tool calls (ends runTurn's loop). */
function finalTextResponse(text = "Done."): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

/** Installs a fetch stub that returns `first` once, then `subsequent` for every call after. */
function stubFetchSequence(first: Response, subsequent: Response = finalTextResponse()) {
  let callCount = 0;
  (global as any).fetch = async (_url: string, _init: unknown) => {
    callCount++;
    return callCount === 1 ? first : subsequent;
  };
  return () => callCount;
}

async function runGatewayEnforcementTests() {
  console.log("🔒 Running Phase 2 AgentOrchestrator Gateway Enforcement Tests...\n");

  const originalFetch = global.fetch;
  const workspaceRoot = process.cwd();
  const scratchDir = path.join(workspaceRoot, ".tmp_gateway_test");
  const scratchFile = path.join(scratchDir, "scratch.txt");
  const relativeScratchFile = path.relative(workspaceRoot, scratchFile);

  fs.mkdirSync(scratchDir, { recursive: true });
  if (fs.existsSync(scratchFile)) fs.unlinkSync(scratchFile);

  const store = new LocalJsonSessionStore(workspaceRoot);
  const registry = new ToolRegistry(CORE_TOOLS);

  try {
    // ── Test 1: mode-based mutation block survives an approved request ──────────
    {
      let approvalCalls = 0;
      const eventBus = new AgentEventBus();
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "ask", modelAdapter: "openai-chat" },
        registry,
        eventBus,
        async () => {
          approvalCalls++;
          return true; // user says yes — the gateway must still refuse.
        },
        "medium",
        store
      );

      stubFetchSequence(toolCallResponse("write_file", { path: relativeScratchFile, content: "should never land" }));
      const result = await orchestrator.runTurn("please write a file");

      const blocked = result.toolResults[0];
      if (
        approvalCalls === 1 &&
        blocked?.isError &&
        blocked.output.includes("Security Policy Violation") &&
        blocked.output.includes("blocked in [ask] mode") &&
        !fs.existsSync(scratchFile)
      ) {
        console.log("✓ Test 1 Passed: [ask]-mode mutation blocked by ToolExecutionGateway even after user approval — no file written.");
      } else {
        console.error("❌ Test 1 Failed:", { approvalCalls, blocked, exists: fs.existsSync(scratchFile) });
        process.exit(1);
      }
    }

    // ── Test 2: approval denial prevents execution entirely ─────────────────────
    {
      let approvalCalls = 0;
      const eventBus = new AgentEventBus();
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        registry,
        eventBus,
        async () => {
          approvalCalls++;
          return false; // user says no
        },
        "medium",
        store
      );

      stubFetchSequence(toolCallResponse("write_file", { path: relativeScratchFile, content: "should never land" }));
      const result = await orchestrator.runTurn("please write a file");

      if (approvalCalls === 1 && result.toolResults.length === 0 && !fs.existsSync(scratchFile)) {
        console.log("✓ Test 2 Passed: Denied approval prevented tool execution — no ToolResult recorded, no file written.");
      } else {
        console.error("❌ Test 2 Failed:", { approvalCalls, toolResults: result.toolResults, exists: fs.existsSync(scratchFile) });
        process.exit(1);
      }
    }

    // ── Test 3: readonly tools never reach the custom approval handler ──────────
    {
      let approvalCalls = 0;
      const eventBus = new AgentEventBus();
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        registry,
        eventBus,
        async () => {
          approvalCalls++;
          return true;
        },
        "medium",
        store
      );

      stubFetchSequence(toolCallResponse("read_file", { path: "package.json", start_line: 1, end_line: 3 }));
      const result = await orchestrator.runTurn("please read package.json");

      const readResult = result.toolResults[0];
      if (approvalCalls === 0 && readResult && !readResult.isError) {
        console.log("✓ Test 3 Passed: readonly tool auto-approved without invoking the custom approval handler.");
      } else {
        console.error("❌ Test 3 Failed:", { approvalCalls, readResult });
        process.exit(1);
      }
    }

    // ── Test 4: approved mutation actually executes AND is persisted ────────────
    {
      let approvalCalls = 0;
      const eventBus = new AgentEventBus();
      const proposedEvents: unknown[] = [];
      eventBus.on("tool.proposed", (evt) => proposedEvents.push(evt.payload));

      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        registry,
        eventBus,
        async () => {
          approvalCalls++;
          return true;
        },
        "medium",
        store
      );

      stubFetchSequence(toolCallResponse("write_file", { path: relativeScratchFile, content: "written via gateway test" }));
      const result = await orchestrator.runTurn("please write the scratch file");

      const wrote = result.toolResults[0];
      const hydration = await store.getSessionHydration(orchestrator.sessionId);
      const persistedToolRun = hydration?.toolExecutions.find((t) => t.toolName === "write_file");

      if (
        approvalCalls === 1 &&
        wrote &&
        !wrote.isError &&
        fs.existsSync(scratchFile) &&
        fs.readFileSync(scratchFile, "utf-8") === "written via gateway test" &&
        proposedEvents.length === 1 &&
        persistedToolRun &&
        !persistedToolRun.isError
      ) {
        console.log("✓ Test 4 Passed: Approved mutation executed through the gateway AND persisted to SessionStore.");
      } else {
        console.error("❌ Test 4 Failed:", { approvalCalls, wrote, persistedToolRun, exists: fs.existsSync(scratchFile) });
        process.exit(1);
      }
    }

    console.log("\n🎉 All Phase 2 Gateway Enforcement Tests Passed Successfully!");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

runGatewayEnforcementTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

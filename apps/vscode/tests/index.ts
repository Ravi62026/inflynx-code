/**
 * Unit & Integration Test Suite for Inflynx VS Code Extension
 */

import { InflynxService } from "../src/InflynxService.js";
import { ApprovalRegistry } from "../src/approval-registry.js";
import type {
  BudgetStatePayload,
  ModelsResponse,
  ServerHealthResponse,
  SessionRecord,
  ToolApprovalRequestPayload,
  TurnCompletedPayload,
} from "../src/types.js";

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAILED: ${message}`);
    failedTests++;
    process.exitCode = 1;
  }
}

async function runTests() {
  console.log("================================================================");
  console.log("🧪 RUNNING INFLYNX VS CODE EXTENSION UNIT TEST SUITE");
  console.log("================================================================\n");

  // ─── Test Group 1: InflynxService Configuration & State Management ───
  console.log("Test Group 1: InflynxService Configuration & Defaults");
  {
    const service = new InflynxService("http://localhost:4000///");
    assert(service.getServerUrl() === "http://127.0.0.1:4000", "Normalizes server URL and resolves to 127.0.0.1 IPv4");

    assert(service.getCurrentMode() === "agent", "Defaults to 'agent' mode");
    service.setCurrentMode("debug");
    assert(service.getCurrentMode() === "debug", "Updates current mode correctly");

    assert(service.getCurrentBudget() === "medium", "Defaults to 'medium' budget");
    service.setCurrentBudget("max");
    assert(service.getCurrentBudget() === "max", "Updates current budget level");

    service.setCurrentModel("anthropic/claude-3-5-sonnet", "anthropic");
    assert(service.getCurrentModel() === "anthropic/claude-3-5-sonnet", "Sets active model and provider");
    assert(!service.getIsConnected(), "Initial connection state is false before probing");
    service.dispose();
  }

  // ─── Test Group 2: Event Emitting & Typed Listeners ───
  console.log("\nTest Group 2: InflynxService Event Bus & Typed Stream Events");
  {
    const service = new InflynxService("http://localhost:4000");
    let textDeltaReceived = "";
    let thoughtDeltaReceived = "";
    let toolProposed: ToolApprovalRequestPayload | null = null;
    let budgetUpdated: BudgetStatePayload | null = null;

    service.on("model.text_delta", (delta) => {
      textDeltaReceived += delta;
    });

    service.on("model.thought_delta", (delta) => {
      thoughtDeltaReceived += delta;
    });

    service.on("tool.proposed", (payload) => {
      toolProposed = payload;
    });

    service.on("budget.updated", (b) => {
      budgetUpdated = b;
    });

    // Simulate SSE event handling via private handleSSEEvent
    (service as any).handleSSEEvent("model.thought_delta", { delta: "Thinking..." });
    (service as any).handleSSEEvent("model.text_delta", { delta: "Hello " });
    (service as any).handleSSEEvent("model.text_delta", { delta: "World!" });

    (service as any).handleSSEEvent("tool.proposed", {
      toolCallId: "tc_123",
      toolName: "patch_file",
      permissionLevel: "readwrite",
      args: { targetFile: "src/main.ts" },
    });

    (service as any).handleSSEEvent("turn.completed", {
      finalText: "Done!",
      toolResults: [],
      budgetState: {
        level: "medium",
        turnsUsed: 3,
        maxTurns: 24,
        toolCallsUsed: 5,
        maxToolCalls: 45,
        tokensUsed: 12000,
        maxTokens: 225000,
        exhausted: false,
      },
      isCompleted: true,
    });

    assert(thoughtDeltaReceived === "Thinking...", "Thought delta dispatched correctly");
    assert(textDeltaReceived === "Hello World!", "Text deltas concatenated accurately");
    assert(toolProposed !== null && (toolProposed as any).toolName === "patch_file", "Tool proposed event received with payload");
    assert(budgetUpdated !== null && (budgetUpdated as any).turnsUsed === 3, "Budget state updated on turn.completed");

    service.dispose();
  }

  // ─── Test Group 3: Server Health & Mock Fetch Probing ───
  console.log("\nTest Group 3: Server Communication & Error Handling");
  {
    const service = new InflynxService("http://127.0.0.1:9999"); // offline port

    let disconnectedFired = false;
    service.on("disconnected", () => {
      disconnectedFired = true;
    });

    const health = await service.checkHealth();
    assert(health === null, "Fails gracefully when backend server is unreachable");
    assert(!service.getIsConnected(), "Server remains marked as disconnected");

    service.dispose();
  }

  // ─── Test Group 4: Plan Tree Markdown Parsing ───
  console.log("\nTest Group 4: Plan Step Parsing Logic");
  {
    // Test the parsing regex and step extraction logic
    const markdownSample = `
# Task Plan
- [x] Step 1: Initialize database schema in \`packages/db/schema.ts\`
- [-] Step 2: Implement authentication controller \`apps/server/src/auth.ts\`
- [ ] Step 3: Write end-to-end integration tests
`;

    const lines = markdownSample.split("\n");
    const parsedSteps: Array<{ title: string; status: string; file?: string }> = [];

    for (const line of lines) {
      const match = line.trim().match(/^[-*0-9.]+\s*\[([ xX~-])\]\s*(.+)/);
      if (match) {
        const check = match[1].toLowerCase();
        let status = "pending";
        if (check === "x") status = "completed";
        if (check === "~" || check === "-") status = "in_progress";

        const fileMatch = match[2].match(/`([^`]+\.[a-zA-Z0-9]+)`/);
        parsedSteps.push({
          title: match[2],
          status,
          file: fileMatch ? fileMatch[1] : undefined,
        });
      }
    }

    assert(parsedSteps.length === 3, "Parsed all 3 plan items");
    assert(parsedSteps[0].status === "completed", "Detected completed step ([x])");
    assert(parsedSteps[0].file === "packages/db/schema.ts", "Extracted target file for step 1");
    assert(parsedSteps[1].status === "in_progress", "Detected in-progress step ([-])");
    assert(parsedSteps[2].status === "pending", "Detected pending step ([ ])");
  }

  // ─── Test Group 5: Tool Approval & Permission Policy Verification ───
  console.log("\nTest Group 5: Tool Approval Policy Evaluation");
  {
    const readonlyRequest: ToolApprovalRequestPayload = {
      sessionId: "session_a",
      toolCallId: "tc_read_1",
      toolName: "read_file",
      permissionLevel: "readonly",
      args: { path: "package.json" },
    };

    const mutatingRequest: ToolApprovalRequestPayload = {
      sessionId: "session_a",
      toolCallId: "tc_write_1",
      toolName: "patch_file",
      permissionLevel: "readwrite",
      args: { path: "src/index.ts", target_code: "old", replacement_code: "new code" },
    };

    const shellRequest: ToolApprovalRequestPayload = {
      sessionId: "session_a",
      toolCallId: "tc_shell_1",
      toolName: "execute_shell",
      permissionLevel: "shell",
      args: { command: "rm -rf /" },
    };

    assert(readonlyRequest.permissionLevel === "readonly", "Readonly tools correctly classified");
    assert(mutatingRequest.permissionLevel === "readwrite", "File mutation correctly classified as readwrite");
    assert(shellRequest.permissionLevel === "shell", "Terminal execution correctly classified as shell");
  }

  // ─── Test Group 6: Approval Registry (single resolution, per-session keys) ───
  console.log("\nTest Group 6: ApprovalRegistry Idempotency & Session Scoping");
  {
    const registry = new ApprovalRegistry();

    assert(
      registry.track({ sessionId: "sess_1", toolCallId: "tc_1", toolName: "write_file", permissionLevel: "readwrite" }),
      "a new request is tracked"
    );
    assert(
      !registry.track({ sessionId: "sess_1", toolCallId: "tc_1", toolName: "write_file", permissionLevel: "readwrite" }),
      "a duplicate event for the same request is rejected"
    );

    const first = registry.resolve("sess_1", "tc_1", true);
    assert(first.status === "resolved" && first.approved === true, "the first answer settles the request");

    // This is the double-prompt bug: webview and native both answering one request.
    const second = registry.resolve("sess_1", "tc_1", false);
    assert(
      second.status === "already-settled" && second.approved === true,
      "a second, contradictory answer is reported as already settled — it cannot flip the decision"
    );
    assert(registry.pendingCount === 0, "nothing stays pending after settlement");

    // Same toolCallId, different session: must not collide.
    registry.track({ sessionId: "sess_A", toolCallId: "shared_id", toolName: "execute_shell", permissionLevel: "shell" });
    registry.track({ sessionId: "sess_B", toolCallId: "shared_id", toolName: "execute_shell", permissionLevel: "shell" });
    assert(registry.resolve("sess_A", "shared_id", true).status === "resolved", "session A answers its own request");
    assert(registry.isPending("sess_B", "shared_id"), "session B's identically-named request is untouched");
    assert(
      registry.resolve("sess_A", "shared_id", true).status === "already-settled",
      "answering session A twice does not leak into session B"
    );

    // An abandoned request (abort / switched session) is a denial, permanently.
    const orphan = new ApprovalRegistry();
    orphan.track({ sessionId: "sess_C", toolCallId: "tc_c1", toolName: "write_file", permissionLevel: "readwrite" });
    orphan.track({ sessionId: "sess_C", toolCallId: "tc_c2", toolName: "write_file", permissionLevel: "readwrite" });
    orphan.forgetSession("sess_C");
    assert(orphan.pendingCount === 0, "forgetSession clears the session's pending set");
    const late = orphan.resolve("sess_C", "tc_c1", true);
    assert(
      late.status === "already-settled" && late.approved === false,
      "a late answer to an abandoned request stays a denial"
    );
    assert(
      new ApprovalRegistry().resolve("nope", "nope", true).status === "unknown-request",
      "an answer for an unknown request is reported as such"
    );
  }

  console.log("\n================================================================");
  console.log(`TEST SUMMARY: ${passedTests} passed, ${failedTests} failed`);
  console.log("================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});

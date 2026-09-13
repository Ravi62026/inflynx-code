/**
 * Integration Test for Phase 1 — CanonicalPathGuard & CommandPolicy
 */

import path from "path";
import fs from "fs";
import { CanonicalPathGuard, CommandPolicy } from "../../packages/policy-engine/src/index.js";
import { ToolRegistry, CORE_TOOLS, ToolExecutionGateway } from "../../packages/tool-runtime/src/index.js";

async function runPhase1Tests() {
  console.log("🧪 Running Phase 1 Security Policy & Tool Execution Gateway Tests...\n");

  const workspaceRoot = process.cwd();
  const guard = new CanonicalPathGuard(workspaceRoot);

  // Test 1: Canonical Path Guard — Normal valid relative path
  const validPath = guard.validateAndResolve("package.json");
  console.log("✓ Test 1 Passed: Valid relative path resolved ->", validPath);

  // Test 2: Canonical Path Guard — Reject traversal escaping workspace
  try {
    guard.validateAndResolve("../../etc/passwd");
    console.error("❌ Test 2 Failed: Path traversal was not blocked!");
    process.exit(1);
  } catch (err: any) {
    console.log("✓ Test 2 Passed: Path traversal blocked ->", err.message);
  }

  // Test 3: Canonical Path Guard — Reject NULL byte injection
  try {
    guard.validateAndResolve("package.json\0.png");
    console.error("❌ Test 3 Failed: NULL byte injection was not blocked!");
    process.exit(1);
  } catch (err: any) {
    console.log("✓ Test 3 Passed: NULL byte injection blocked ->", err.message);
  }

  // Test 4: Command Policy — Reject destructive pattern
  try {
    CommandPolicy.validateShellCommand("rm -rf /");
    console.error("❌ Test 4 Failed: Destructive shell command was not blocked!");
    process.exit(1);
  } catch (err: any) {
    console.log("✓ Test 4 Passed: Destructive shell command blocked ->", err.message);
  }

  // Test 5: Command Policy — Safe command tokenization
  const parsed = CommandPolicy.parseCommandToArgs('git commit -m "feat: add security policy"');
  if (parsed.executable === "git" && parsed.args[0] === "commit" && parsed.args[2] === "feat: add security policy") {
    console.log("✓ Test 5 Passed: Command tokenized cleanly ->", parsed);
  } else {
    console.error("❌ Test 5 Failed: Unexpected command parse output:", parsed);
    process.exit(1);
  }

  // Test 6: Tool Execution Gateway — Guarded tool invocation (read_file)
  const registry = new ToolRegistry(CORE_TOOLS);
  const gateway = new ToolExecutionGateway(workspaceRoot);
  const result = await gateway.executeGuarded(
    registry,
    { id: "call_1", name: "read_file", args: { path: "package.json", start_line: 1, end_line: 5 } },
    { activeMode: "agent" }
  );

  if (!result.isError && result.output.includes("inflynx")) {
    console.log("✓ Test 6 Passed: Guarded tool executed successfully in agent mode.");
  } else {
    console.error("❌ Test 6 Failed:", result.output);
    process.exit(1);
  }

  // Test 7: Tool Execution Gateway — Mode boundary enforcement (execute_shell blocked in ask mode)
  const modeBlocked = await gateway.executeGuarded(
    registry,
    { id: "call_2", name: "execute_shell", args: { command: "echo hello" } },
    { activeMode: "ask" }
  );

  if (modeBlocked.isError && modeBlocked.output.includes("Security Policy Violation")) {
    console.log("✓ Test 7 Passed: Shell tool blocked in read-only [ask] mode.");
  } else {
    console.error("❌ Test 7 Failed: Shell tool was not blocked in ask mode!", modeBlocked);
    process.exit(1);
  }

  console.log("\n🎉 All Phase 1 Security Policy & Tool Gateway Tests Passed Successfully!");
}

runPhase1Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

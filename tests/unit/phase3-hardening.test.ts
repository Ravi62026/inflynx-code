/**
 * Phase 3 security hardening tests:
 * - MCP tools use the same gateway path/URL boundary checks as core tools.
 * - Redis rate limiting fails open only when Redis is intentionally absent.
 */

import { closeRedisClient, checkRateLimit } from "../../packages/cache/src/index.js";
import { ToolExecutionGateway, ToolRegistry, type ToolDefinition } from "../../packages/tool-runtime/src/index.js";

async function runPhase3Tests() {
  console.log("🛡️ Running Phase 3 Gateway, MCP & Rate-Limit Tests...\n");

  const workspaceRoot = process.cwd();
  const mcpTool: ToolDefinition = {
    name: "mcp__fixture__read",
    description: "Synthetic MCP tool for security testing.",
    permissionLevel: "readwrite",
    isMutating: true,
    origin: "mcp",
    serverName: "fixture",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path" },
        url: { type: "string", description: "Remote URL" },
      },
      required: [],
    },
    execute: async () => "should not execute",
  };

  const registry = new ToolRegistry([mcpTool]);
  const gateway = new ToolExecutionGateway(workspaceRoot);

  const escapedPath = await gateway.executeGuarded(
    registry,
    { id: "mcp_path", name: mcpTool.name, args: { path: "../outside.txt" } },
    { activeMode: "agent", sessionId: "phase3-test" }
  );
  if (escapedPath.isError && escapedPath.output.includes("Security Policy Violation")) {
    console.log("✓ Test 1 Passed: MCP path arguments use the canonical workspace boundary.");
  } else {
    console.error("❌ Test 1 Failed:", escapedPath);
    process.exit(1);
  }

  const privateUrl = await gateway.executeGuarded(
    registry,
    { id: "mcp_url", name: mcpTool.name, args: { url: "http://127.0.0.1:8080/admin" } },
    { activeMode: "agent", sessionId: "phase3-test" }
  );
  if (privateUrl.isError && privateUrl.output.includes("SSRF protection")) {
    console.log("✓ Test 2 Passed: MCP URL arguments use the SSRF guard.");
  } else {
    console.error("❌ Test 2 Failed:", privateUrl);
    process.exit(1);
  }

  const previousRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  await closeRedisClient();
  const failOpen = await checkRateLimit("phase3-no-redis", 1, 60);
  if (failOpen.allowed && failOpen.failedOpen) {
    console.log("✓ Test 3 Passed: Missing Redis fails open without disabling the rate-limit integration.");
  } else {
    console.error("❌ Test 3 Failed:", failOpen);
    process.exit(1);
  }

  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
  await closeRedisClient();

  console.log("\n🎉 All Phase 3 hardening tests passed!");
}

runPhase3Tests().catch((err) => {
  console.error("Phase 3 test runner failed:", err);
  process.exit(1);
});

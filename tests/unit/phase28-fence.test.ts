/**
 * Backlog Phase 28 — sensitive-write fence (B10) + argument validation.
 *
 * Two independent controls, both enforced at the gateway so every tool inherits them:
 *  - a mutating call may not target `.git/**`, `.env*`, `node_modules/**`, the credential
 *    store, or ssh/aws secret files;
 *  - a call's arguments are checked against the tool's own schema before it runs, and the
 *    error says what shape was wanted.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ToolRegistry, CORE_TOOLS, ToolExecutionGateway } from "../../packages/tool-runtime/src/index.js";
import { validateToolArgs } from "../../packages/tool-runtime/src/arg-validation.js";
import { isSensitiveToWrite } from "../../packages/policy-engine/src/sensitive-paths.js";
import { cleanupOnExit } from "../helpers/tmp.js";

function mkWorkspace(): string {
  const root = cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p28-")));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(root, ".inflynx"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-secret\n");
  fs.writeFileSync(path.join(root, ".env.example"), "OPENAI_API_KEY=\n");
  fs.writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports=1;\n");
  fs.writeFileSync(path.join(root, ".inflynx", "credentials.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  return root;
}

function gatewayCall(gw: ToolExecutionGateway, reg: ToolRegistry, name: string, args: Record<string, unknown>, mode: "agent" | "plan" = "agent") {
  return gw.executeGuarded(reg, { id: `c${Math.random()}`, name, args } as never, { activeMode: mode, sessionId: "s" } as never);
}

async function runPhase28Tests(): Promise<void> {
  console.log("🧪 Running Phase 28 Sensitive-Fence & Arg-Validation Tests...\n");

  // ── Test 1: the classifier itself, before it gates anything ───────────────
  {
    const root = "/ws";
    const blocked = [".git/config", ".env", ".env.local", "node_modules/x/index.js",
      ".inflynx/credentials.json", ".ssh/authorized_keys", ".aws/credentials",
      "sub/.git/hooks/pre-commit", "id_rsa", ".npmrc"];
    for (const rel of blocked) {
      assert.equal(isSensitiveToWrite(path.join(root, rel), root).sensitive, true, `.git/etc should be blocked: ${rel}`);
    }
    const allowed = ["src/app.ts", ".env.example", ".env.template", ".env.sample", "README.md",
      ".inflynx/PLAN.md", ".inflynx/sessions/s.json", "config.json", ".gitignore", "environment.ts"];
    for (const rel of allowed) {
      assert.equal(isSensitiveToWrite(path.join(root, rel), root).sensitive, false, `legitimate write blocked: ${rel}`);
    }
    // `.gitignore` is a normal committed file; `.git/` the directory is not.
    console.log("✓ Test 1 Passed: 11 secret shapes blocked, 9 ordinary files allowed (incl .env.example, .gitignore).");
  }

  // ── Test 2: write_file through the gateway honours the fence ─────────────
  {
    const root = mkWorkspace();
    const reg = new ToolRegistry(CORE_TOOLS);
    const gw = new ToolExecutionGateway(root);

    const gitCfg = await gatewayCall(gw, reg, "write_file", { path: ".git/config", content: "pwned" });
    assert.equal(gitCfg.isError, true, "write to .git/config succeeded");
    assert.match(gitCfg.output, /\.git\/|not source code/i, gitCfg.output);
    assert.equal(fs.readFileSync(path.join(root, ".git", "config"), "utf-8"), "[core]\n", "the blocked write still hit the disk");

    const env = await gatewayCall(gw, reg, "write_file", { path: ".env", content: "x" });
    assert.equal(env.isError, true, "write to .env succeeded");
    assert.match(env.output, /secret/i, env.output);

    // The committed template is exactly what a developer edits — must be allowed.
    const tmpl = await gatewayCall(gw, reg, "write_file", { path: ".env.example", content: "FOO=\n" });
    assert.ok(!tmpl.isError, `.env.example blocked: ${tmpl.output}`);

    const ok = await gatewayCall(gw, reg, "write_file", { path: "src/new.ts", content: "export const b = 2;\n" });
    assert.ok(!ok.isError, `a normal write was blocked: ${ok.output}`);
    console.log("✓ Test 2 Passed: .git/.env writes refused & not on disk; .env.example and src/ allowed.");
  }

  // ── Test 3: every mutating tool is covered, not just write_file ──────────
  {
    const root = mkWorkspace();
    const reg = new ToolRegistry(CORE_TOOLS);
    const gw = new ToolExecutionGateway(root);

    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["edit_file", { path: ".git/config", edits: [{ oldText: "core", newText: "evil" }] }, /git|not source/i],
      ["patch_file", { path: ".env", target_code: "sk", replacement_code: "ok" }, /secret/i],
      ["delete_path", { path: ".env" }, /secret|refus/i],
      ["move_path", { from: "src/app.ts", to: ".git/app.ts" }, /git|not source/i],
      ["write_file", { path: "node_modules/left-pad/index.js", content: "hijack" }, /node_modules|not source/i],
    ];
    for (const [tool, args, expect] of cases) {
      const r = await gatewayCall(gw, reg, tool, args);
      assert.equal(r.isError, true, `${tool} wrote to a sensitive path`);
      assert.match(r.output, expect, `${tool} refused for the wrong reason:\n${r.output}`);
    }
    // node_modules/left-pad/index.js still original
    assert.equal(fs.readFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "utf-8"), "module.exports=1;\n");
    console.log("✓ Test 3 Passed: edit/patch/delete/move/write all refused at .git/.env/node_modules targets.");
  }

  // ── Test 4: traversal that LANDS inside a sensitive dir is caught ────────
  {
    const root = mkWorkspace();
    const reg = new ToolRegistry(CORE_TOOLS);
    const gw = new ToolExecutionGateway(root);
    // src/../.git/config resolves inside .git — the guard canonicalises it first, and the
    // fence sees the resolved path, so obfuscation by traversal does not help.
    const r = await gatewayCall(gw, reg, "write_file", { path: "src/../.git/config", content: "x" });
    assert.equal(r.isError, true, "traversal into .git was allowed");
    assert.match(r.output, /git|not source/i, r.output);
    console.log("✓ Test 4 Passed: a `../`-obfuscated path is caught on its resolved form.");
  }

  // ── Test 5: reads are NOT fenced (that is Phase 33's job, deliberately) ──
  {
    const root = mkWorkspace();
    const reg = new ToolRegistry(CORE_TOOLS);
    const gw = new ToolExecutionGateway(root);
    const r = await gatewayCall(gw, reg, "read_file", { path: "node_modules/left-pad/index.js" });
    assert.ok(!r.isError, `reading a dependency should be allowed in Phase 28: ${r.output}`);
    console.log("✓ Test 5 Passed: read-only tools exempt from the write fence (node_modules readable).");
  }

  // ── Test 6: arg validation returns a correction, not a crash ────────────
  {
    const root = mkWorkspace();
    const reg = new ToolRegistry(CORE_TOOLS);
    const gw = new ToolExecutionGateway(root);

    const noPath = await gatewayCall(gw, reg, "read_file", {});
    assert.equal(noPath.isError, true, "read_file with no path ran");
    assert.match(noPath.output, /`path` is required|invalid arguments/i, noPath.output);
    assert.match(noPath.output, /Expected shape/, "no schema hint given");

    const pathsNotArray = await gatewayCall(gw, reg, "list_diagnostics", { paths: "bad.ts" });
    // string where array declared — providers sometimes send this; the tool's own resolver
    // is permissive, so assert at the validator level instead of via the gateway here.
    void pathsNotArray;

    const badEnum = await gatewayCall(gw, reg, "update_plan", { goal: "g", steps: [{ id: 1, title: "a", state: "nearly_done" }] });
    assert.equal(badEnum.isError, true, "an invalid enum state ran");
    assert.match(badEnum.output, /state|one of|nearly_done/i, badEnum.output);

    // A well-formed call still works (no false positives on the happy path).
    const good = await gatewayCall(gw, reg, "read_file", { path: "src/app.ts" });
    assert.ok(!good.isError, `a valid call was rejected: ${good.output}`);
    console.log("✓ Test 6 Passed: missing-required and bad-enum refused with a shape hint; valid calls pass.");
  }

  // ── Test 7: validateToolArgs unit behaviour (permissive where it must be) ─
  {
    const schema = {
      type: "object" as const,
      required: ["path"],
      properties: {
        path: { type: "string" as const },
        start_line: { type: "number" as const },
        mode: { type: "string" as const, enum: ["a", "b"] },
        files: { type: "array" as const, items: { type: "string" as const } },
      },
    };
    assert.equal(validateToolArgs(schema as never, { path: "x" }).ok, true, "minimal valid rejected");
    assert.equal(validateToolArgs(schema as never, { path: "x", extra: 9 }).ok, true, "unknown extra rejected (should allow)");
    assert.equal(validateToolArgs(schema as never, { path: "x", start_line: "3" }).ok, true, "numeric string for number rejected");
    assert.equal(validateToolArgs(schema as never, {}).ok, false, "missing required accepted");
    assert.equal(validateToolArgs(schema as never, { path: 123 }).ok, false, "number for path accepted");
    assert.equal(validateToolArgs(schema as never, { path: "x", mode: "z" }).ok, false, "bad enum accepted");
    assert.equal(validateToolArgs(schema as never, { path: "x", files: "not-array" }).ok, false, "string for array accepted");
    assert.equal(validateToolArgs(schema as never, { path: "x", files: ["a", 2] }).ok, false, "non-string array item accepted");
    console.log("✓ Test 7 Passed: validator strict on real violations, permissive on extras/coercion.");
  }

  console.log("\n🎉 All Phase 28 Sensitive-Fence & Arg-Validation Tests Passed 100%!");
}

runPhase28Tests().catch((err) => {
  console.error("Phase 28 test failed:", err);
  process.exit(1);
});

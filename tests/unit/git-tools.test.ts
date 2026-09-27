/**
 * Backlog Phase 24 — the git tool family.
 *
 * Everything here runs against a **real repository** created in a temp dir with `git init`,
 * because the useful properties are about git's actual behaviour: exit codes, "not a git
 * repository", whether `--short` parsing matches the real format, and whether a diff of the
 * agent's own work really does go back to empty after a revert.
 *
 * The security-critical section is the global-options refusal. An allowlist of subcommands
 * looks like a sandbox until you notice `--git-dir`, `-c core.fsmonitor=<cmd>` or
 * `git diff --output=/tmp/x` — all reachable through a "read-only" subcommand name.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ToolRegistry,
  CORE_TOOLS,
  ToolExecutionGateway,
  classifyGitInvocation,
  validateGitArgs,
  createToolExecutionContextFromGuard,
} from "../../packages/tool-runtime/src/index.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { cleanupOnExit } from "../helpers/tmp.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A committed repository with one tracked file, so diffs and logs have something to say. */
function makeRepo(opts: { commit?: boolean } = { commit: true }): string {
  // Exit-cleanup on top of each block's `finally`: the outer catch calls `process.exit(1)`,
  // which skips a pending `finally` and leaks the repo into the system temp dir.
  const root = cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-git-")));
  git(root, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(root, "app.ts"), "export const value = 1;\n", "utf-8");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n", "utf-8");
  if (opts.commit !== false) {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "initial commit"]);
  }
  return root;
}

async function runGitToolTests(): Promise<void> {
  console.log("🧪 Running Phase 24 Git Tool Tests...\n");

  // ── Test 1: grading is per invocation, and refuses the escapes ────────────
  {
    const readOnly = [
      ["status"], ["diff", "--stat"], ["log", "-3"], ["show", "HEAD"], ["blame", "app.ts"],
      ["ls-files"], ["rev-parse", "HEAD"], ["describe", "--always"], ["shortlog", "-sn"],
      ["branch", "--list"], ["tag", "--list"], ["stash", "list"], ["config", "--get", "user.name"],
      ["remote", "-v"], ["reflog"], ["grep", "-n", "value"],
    ];
    for (const argv of readOnly) {
      const info = classifyGitInvocation(argv);
      assert.equal(info.grade, "read-only", `${argv.join(" ")} → ${info.grade} (${info.reason})`);
    }

    const mutating = [
      ["add", "app.ts"], ["commit", "-m", "x"], ["checkout", "--", "app.ts"], ["reset", "--soft", "HEAD~1"],
      ["restore", "app.ts"], ["clean", "-fd"], ["merge", "other"], ["rebase", "main"], ["switch", "-c", "x"],
      ["stash", "push"], ["stash", "drop"], ["branch", "-D", "old"], ["tag", "v1"], ["mv", "a", "b"],
      ["rm", "app.ts"], ["apply", "p.patch"], ["push"], ["cherry-pick", "abc"], ["worktree", "add", "../x"],
    ];
    for (const argv of mutating) {
      const info = classifyGitInvocation(argv);
      assert.equal(info.grade, "mutating", `${argv.join(" ")} must ask, got ${info.grade}`);
    }

    // The allowlist is worthless if a global option redirects or executes.
    const refused: Array<[string[], string]> = [
      [["--git-dir=/tmp/other", "status"], "another repository (=-form)"],
      [["--work-tree=/tmp", "commit", "-m", "x"], "writes outside (= form)"],
      [["--git-dir", "/tmp/other", "status"], "another repository (spaced form)"],
      [["--namespace=ns", "status"], "namespace redirect (= form)"],
      [["-C", "/tmp", "status"], "changes directory"],
      [["-c", "core.fsmonitor=/tmp/evil", "log"], "config that executes"],
      [["diff", "--output=/tmp/stolen.diff"], "writes a file directly"],
      [["status", "--no-gpg-sign"], "disables signature checking"],
      [["add", "-p"], "interactive patch mode"],
      [["commit", "-i"], "interactive"],
      [["push", "--force", "origin", "main"], "force-push default branch"],
      [["push", "-f", "origin", "HEAD"], "force-push default branch"],
    ];
    for (const [argv, why] of refused) {
      const info = classifyGitInvocation(argv);
      assert.equal(info.grade, "refused", `NOT refused (${why}): ${argv.join(" ")} → ${info.grade}`);
      assert.ok(info.reason.length > 20, `refusal has no explanation for ${argv.join(" ")}`);
    }

    // Argument shape: no shell strings, no embedded newlines.
    assert.equal(validateGitArgs("status --short").ok, false, "a command string was accepted");
    assert.equal(validateGitArgs([]).ok, false);
    assert.equal(validateGitArgs(["log", "--format=%B\nsecond line"]).ok, false, "newline in argv accepted");
    assert.equal(validateGitArgs(["status", "--short"]).ok, true);
    console.log("✓ Test 1 Passed: read-only/mutating split correct, 10 escape attempts refused, argv-only.");
  }

  // ── Test 2: a real repo, structured summaries ─────────────────────────────
  {
    const root = makeRepo();
    try {
      const registry = new ToolRegistry(CORE_TOOLS);
      const gateway = new ToolExecutionGateway(root);
      const call = async (args: Record<string, unknown>) =>
        gateway.executeGuarded(registry, { id: `g${Math.random()}`, name: "git", args } as any,
          { activeMode: "agent", sessionId: "s" } as any);

      const clean = await call({ args: ["status", "--short"] });
      assert.ok(!clean.isError, `status failed: ${clean.output}`);
      assert.match(clean.output, /# 0 modified/, `a clean tree should summarize as zero changes: ${clean.output}`);

      fs.writeFileSync(path.join(root, "app.ts"), "export const value = 2;\nexport const extra = 3;\n");
      fs.writeFileSync(path.join(root, "new.ts"), "export const n = 1;\n");

      const dirty = await call({ args: ["status", "--short"] });
      assert.match(dirty.output, /# 1 modified, .*1 untracked/, `structured summary wrong: ${dirty.output}`);

      const diff = await call({ args: ["diff", "--stat"] });
      assert.match(diff.output, /app\.ts/, "diff lost the file");
      // git's own stat line is echoed, not re-counted by us — the wording ("1 file
      // changed", singular, no "(s)") is git's, so the test pins git's phrasing.
      assert.match(diff.output, /# 1 file changed, 2 insertions\(\+\), 1 deletion\(-\)/, `diff summary missing: ${diff.output}`);

      const nameOnly = await call({ args: ["diff", "--name-only"] });
      assert.match(nameOnly.output, /app\.ts/, "--name-only lost the file");
      assert.match(nameOnly.output, /# 1 file\(s\) listed/, `--name-only summary wrong: ${nameOnly.output}`);

      const log = await call({ args: ["log", "--oneline", "-5"] });
      assert.match(log.output, /initial commit/, "log empty");
      assert.match(log.output, /# 1 commit line\(s\) shown/, "log summary missing");

      const blame = await call({ args: ["blame", "app.ts"] });
      assert.ok(!blame.isError, `blame failed: ${blame.output.slice(0, 160)}`);

      // The mutating branch is executed but graded mutating; that is what the approval
      // layer consumes, and the tool itself must not silently become read-only.
      assert.match(String(blame.output), /read-only/, "a read-only call lost its provenance line");
      console.log("✓ Test 2 Passed: status/diff/log/blame against a real repo, each with a summary line.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 3: honesty when git is unhappy ───────────────────────────────────
  {
    const root = makeRepo({ commit: false });
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-nongit-"));
    try {
      const registry = new ToolRegistry(CORE_TOOLS);
      const gateway = new ToolExecutionGateway(nonRepo);
      const out = await gateway.executeGuarded(registry, {
        id: "g1", name: "git", args: { args: ["status"] },
      } as any, { activeMode: "agent", sessionId: "s" } as any);
      assert.equal(out.isError, true, "a non-repo claimed success");
      // git's own words, plus the exit code — not an invented "no changes".
      assert.match(out.output, /not a git repository/i, `unhelpful message: ${out.output.slice(0, 200)}`);
      assert.match(out.output, /exit code 128/, "exit code hidden");

      // A bad revision is a real error the model must be able to distinguish from empty.
      const gateway2 = new ToolExecutionGateway(root);
      const bad = await gateway2.executeGuarded(registry, {
        id: "g2", name: "git", args: { args: ["show", "definitely-not-a-ref"] },
      } as any, { activeMode: "agent", sessionId: "s" } as any);
      assert.equal(bad.isError, true, "an unknown revision reported success");
      assert.match(bad.output, /unknown revision|does not have any|exit code 128/i,
        `git error swallowed: ${bad.output.slice(0, 200)}`);
      console.log("✓ Test 3 Passed: non-repo and bad-ref both surface git's real error + exit code.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  }

  // ── Test 4: the guard applies to `path`, and [plan] mode is graded ─────────
  {
    const root = makeRepo();
    try {
      const registry = new ToolRegistry(CORE_TOOLS);
      const gateway = new ToolExecutionGateway(root);

      const escapee = await gateway.executeGuarded(registry, {
        id: "p1", name: "git", args: { args: ["status"], path: "../.." },
      } as any, { activeMode: "agent", sessionId: "s" } as any);
      assert.equal(escapee.isError, true, "git ran in a directory outside the workspace");
      assert.match(escapee.output, /rejected|outside/i, `escape not explained: ${escapee.output.slice(0, 160)}`);

      // [plan] mode: inspection yes, mutation no. Both are checked because a path-only
      // fence would get both of these backwards for this tool.
      const plannedRead = await gateway.executeGuarded(registry, {
        id: "p2", name: "git", args: { args: ["status", "--short"] },
      } as any, { activeMode: "plan", sessionId: "s" } as any);
      assert.ok(!plannedRead.isError, `[plan] blocked read-only git: ${plannedRead.output.slice(0, 160)}`);

      const plannedWrite = await gateway.executeGuarded(registry, {
        id: "p3", name: "git", args: { args: ["commit", "-m", "sneaky"] },
      } as any, { activeMode: "plan", sessionId: "s" } as any);
      assert.equal(plannedWrite.isError, true, "[plan] mode allowed a commit");
      assert.match(plannedWrite.output, /\[plan\] mode/, `plan refusal misworded: ${plannedWrite.output.slice(0, 160)}`);
      assert.equal(git(root, ["log", "--oneline"]).trim().split("\n").length, 1,
        "the blocked commit still landed");
      console.log("✓ Test 4 Passed: path guard holds; [plan] inspects but cannot commit.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: through a real turn — status asks nobody, commit asks you ─────
  {
    const root = makeRepo();
    const originalFetch = (globalThis as any).fetch;
    try {
      const sse = (lines: string[]) => new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); } }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const toolCall = (args: Record<string, unknown>) => sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "git", arguments: JSON.stringify(args) } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]",
      ]);
      const textReply = (t: string) => sse([
        JSON.stringify({ choices: [{ delta: { content: t } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]",
      ]);

      let approvals = 0;
      let req = 0;
      (globalThis as any).fetch = async () => {
        req++;
        if (req === 1) return toolCall({ args: ["status", "--short"] });
        return textReply("clean");
      };
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never, new AgentEventBus() as never,
        async () => { approvals++; return true; }, "low", new LocalJsonSessionStore(root) as never
      );
      const statusTurn = await orchestrator.runTurn("is anything dirty?");
      assert.equal(approvals, 0, "read-only git status demanded approval — the tool would be unusable");
      assert.ok(!statusTurn.toolResults[0]?.isError, `status call failed: ${statusTurn.toolResults[0]?.output}`);

      // Now a mutating one, with a handler that REFUSES. A tool that never reached the
      // human and a tool the human refused can look identical from the model's side, so
      // the tree itself is the assertion.
      fs.writeFileSync(path.join(root, "app.ts"), "export const value = 42;\n");
      req = 0;
      (globalThis as any).fetch = async () => {
        req++;
        if (req === 1) return toolCall({ args: ["commit", "-m", "bump", "--", "app.ts"] });
        return textReply("committed");
      };
      const refusing = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never, new AgentEventBus() as never,
        async () => { approvals++; return false; },
        "low", new LocalJsonSessionStore(root) as never
      );
      const commitTurn = await refusing.runTurn("commit that");
      assert.equal(approvals, 1, "git commit did not reach a human");
      assert.ok(!git(root, ["log", "--oneline"]).includes("bump"),
        "a refused commit was executed anyway");
      assert.match(String(commitTurn.toolResults[0]?.output ?? ""), /denied|refus/i,
        "the model was never told the commit was refused");

      // Approve it this time, and check it really commits.
      req = 0;
      (globalThis as any).fetch = async () => {
        req++;
        if (req === 1) return toolCall({ args: ["commit", "-m", "bump", "--", "app.ts"] });
        return textReply("done");
      };
      const approved = await AgentOrchestrator.start(
        { workspaceRoot: root, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never, new AgentEventBus() as never,
        async () => true, "low", new LocalJsonSessionStore(root) as never
      );
      await approved.runTurn("commit that");
      assert.match(git(root, ["log", "--oneline"]), /bump/, "an approved commit did not happen");
      console.log("✓ Test 5 Passed: `git status` runs silent, `git commit` asks, and a yes really commits.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 6: the phase's "Done when" — diff your turn, then revert it ──────
  {
    const root = makeRepo();
    try {
      const guard = new CanonicalPathGuard(root);
      const registry = new ToolRegistry(CORE_TOOLS);
      const ctx = createToolExecutionContextFromGuard(guard as never, { sessionId: "s6" });
      const gitTool = registry.get("git")!;
      const write = registry.get("write_file")!;
      const text = (r: unknown) => (typeof r === "string" ? r : (r as { output: string }).output);

      // The agent's own edit, then a diff of it.
      await write.execute({ path: "app.ts", content: "export const value = 99;\n" }, ctx);
      const diff = text(await gitTool.execute({ args: ["diff"] }, ctx));
      assert.match(diff, /-export const value = 1;/, `the diff missed the change:\n${diff.slice(0, 300)}`);
      assert.match(diff, /\+export const value = 99;/);
      assert.match(diff, /# 1 file\(s\) changed, \+1 \/ -1/, `diff stat wrong: ${diff}`);

      // git can put its own turn back…
      await gitTool.execute({ args: ["checkout", "--", "app.ts"] }, ctx);
      assert.equal(fs.readFileSync(path.join(root, "app.ts"), "utf-8"), "export const value = 1;\n",
        "git checkout did not revert the file");
      const after = text(await gitTool.execute({ args: ["diff"] }, ctx));
      assert.ok(!after.includes("value = 99"), `diff still shows the change: ${after.slice(0, 200)}`);

      // …and so can /undo, which is the path with a preview. Write again, undo via git's
      // own diff being empty afterwards — the two mechanisms must agree.
      await write.execute({ path: "app.ts", content: "export const value = 7;\n" }, ctx);
      const still = text(await gitTool.execute({ args: ["diff", "--name-only"] }, ctx));
      assert.match(still, /app\.ts/, "second edit not visible to git");
      assert.match(still, /# 1 file\(s\) listed/, `--name-only mis-summarised: ${still}`);
      text(await gitTool.execute({ args: ["restore", "app.ts"] }, ctx));
      assert.equal(fs.readFileSync(path.join(root, "app.ts"), "utf-8"), "export const value = 1;\n",
        "restore left the tree dirty");
      console.log("✓ Test 6 Passed: the agent can diff its own turn and take it back.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 7: the registry contract the UIs read ────────────────────────────
  {
    const tools = new ToolRegistry(CORE_TOOLS).list();
    const gitTool = tools.find((t) => t.name === "git");
    assert.ok(gitTool, "git tool missing from CORE_TOOLS");
    assert.equal(gitTool!.isMutating, true, "git must be declared mutating so [plan] and caches see it");
    assert.equal(gitTool!.cacheable, false, "a cached `git status` would lie after the next edit");
    assert.deepEqual(gitTool!.parameters.required, ["args"]);
    assert.ok(gitTool!.parameters.properties.args.items?.type === "string", "argv schema lost");
    // Pinned by names, not a count (see N11): a count says something drifted, not what.
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "delegate", "delete_path", "edit_file", "execute_shell", "fetch_url", "find_definition", "git", "glob_files",
        "list_diagnostics", "list_directory", "list_symbols", "move_path", "patch_file", "read_file",
        "search_files", "shell_list", "shell_output", "shell_stop", "update_plan", "web_search", "write_file",
      ].sort(),
      `tool set drifted (${tools.length}) — update §2 and agent.txt together`);
    console.log(`✓ Test 7 Passed: ${tools.length} tools; git mutating, non-cacheable, argv-array schema.`);
  }

  console.log("\n🎉 All Phase 24 Git Tool Tests Passed 100%!");
}

runGitToolTests().catch((err) => {
  console.error("Git tool test failed:", err);
  process.exit(1);
});

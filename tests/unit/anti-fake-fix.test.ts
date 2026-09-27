/**
 * Backlog Phase 32 — anti-fake-fix enforcement.
 *
 * Phase 31 gave the agent a gate; this phase stops it from passing the gate by hiding the
 * problem. The valuable half of this test file is not the first section (a rule that
 * catches `@ts-ignore` is easy) — it is the **false-positive** section. A detector that
 * fires on code already in the file, on a doc explaining a directive, or on ordinary
 * refactors makes the control unusable, and an unusable control gets turned off. That
 * is how this repo's previous shell ban failed.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  reviewPatchSafety,
  formatPatchSafetyForUser,
  isTestPath,
} from "../../packages/patch-engine/src/index.js";
import {
  ToolExecutionGateway,
  ToolRegistry,
  CORE_TOOLS,
  reviewMutatingPatchForSafety,
} from "../../packages/tool-runtime/src/index.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/index.js";
import { RepairLoop } from "../../packages/agent-core/src/verification/RepairLoop.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

const rules = (r: { violations: Array<{ rule: string }> }) => r.violations.map((v) => v.rule).sort();

function sse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function toolCall(name: string, args: Record<string, unknown>): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]",
  ]);
}
const textReply = (t: string) => sse([
  JSON.stringify({ choices: [{ delta: { content: t } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]",
]);

async function runAntiFakeFixTests(): Promise<void> {
  console.log("🧪 Running Phase 32 Anti-Fake-Fix Tests...\n");

  // ── Test 1: every rule catches what it exists for ──────────────────────────
  {
    const cases: Array<[string, string, string, string]> = [
      ["type suppression", "const x = compute();", "src/app.ts", "suppress-directive"],
      ["lint suppression", "const x = 1;", "src/app.ts", "linter-disable"],
      ["skipped test", "it('works', () => {});", "app.test.ts", "test-skipped"],
      ["isolated test", "it('works', () => {});", "app.test.ts", "test-isolated"],
      ["unfailable assert", "it('works', () => { doThing(); });", "app.test.ts", "trivial-assertion"],
      ["assertions removed", "expect(a).toBe(1); expect(b).toBe(2);", "app.test.ts", "assertion-removed"],
      ["commented assertion", "expect(a).toBe(1);", "app.test.ts", "assertion-commented-out"],
      ["test block removed", "it('a', () => {}); it('b', () => {});", "app.test.ts", "test-block-removed"],
      ["forced exit", "process.exit(0);", "app.test.ts", "forced-exit-in-test"],
      ["empty handler", "doWork();", "src/app.ts", "empty-handler"],
      ["secret", "const url = API;", "src/app.ts", "secret-introduced"],
    ];
    const BEFORE: Record<string, string> = {
      "type suppression": "const x = compute();\n",
      "lint suppression": "const x = 1;\n",
      "skipped test": "it('works', () => { expect(1).toBe(1); });\n",
      "isolated test": "it('works', () => { expect(1).toBe(1); });\n",
      "unfailable assert": "it('works', () => { doThing(); });\n",
      "assertions removed": "expect(a).toBe(1); expect(b).toBe(2);\n",
      "commented assertion": "expect(a).toBe(1);\n",
      "test block removed": "it('a', () => {}); it('b', () => {});\n",
      "forced exit": "run();\n",
      "empty handler": "doWork();\n",
      "secret": "const url = API;\n",
    };
    const AFTER: Record<string, string> = {
      "type suppression": "// @ts-ignore\nconst x = compute();\n",
      "lint suppression": "/* eslint-disable */\nconst x = 1;\n",
      "skipped test": "it.skip('works', () => { expect(1).toBe(1); });\n",
      "isolated test": "it.only('works', () => { expect(1).toBe(1); });\n",
      "unfailable assert": "it('works', () => { expect(true).toBe(true); });\n",
      "assertions removed": "expect(a).toBe(1);\n",
      "commented assertion": "// expect(a).toBe(1);\n",
      "test block removed": "it('a', () => {});\n",
      "forced exit": "run();\nprocess.exit(0);\n",
      "empty handler": "try { doWork(); } catch (e) {}\n",
      "secret": 'const key = "sk-ant-ABCDEFGHIJKLMNOP1234";\n',
    };

    for (const [label, _ignored, filePath, expectedRule] of cases) {
      const review = reviewPatchSafety({ filePath, before: BEFORE[label], after: AFTER[label] });
      assert.equal(review.safe, false, `${label}: not caught at all`);
      assert.ok(
        review.violations.some((v) => v.rule === expectedRule),
        `${label}: caught by ${rules(review).join(",")}, wanted ${expectedRule}`
      );
      // A refusal the model cannot act on is a refusal the model will route around.
      for (const v of review.violations) {
        assert.match(v.reason, /this patch|fix|must not|cannot/, `${label}: reason does not say what to do instead`);
        assert.ok(v.evidence.length > 0, `${label}: no evidence quoted`);
      }
    }
    console.log("✓ Test 1 Passed: 11 fake-fix shapes caught, each with a reason and quoted evidence.");
  }

  // ── Test 2: ADDITIONS ONLY — the rule that keeps this feature usable ───────
  {
    const existing = "// @ts-ignore — the upstream types are wrong\nexport const a = compute(a, b);\n/* eslint-disable no-explicit-any */\nexport const b = 2;\n";
    // An ordinary edit to a file that already contains every directive.
    const ordinary = existing.replace("export const b = 2;", "export const b = 3;");
    const review = reviewPatchSafety({ filePath: "src/legacy.ts", before: existing, after: ordinary });
    assert.equal(review.safe, true, `editing a file that already had suppressions was blocked: ${formatPatchSafetyForUser(review)}`);

    // Same for a file whose existing empty catch is untouched.
    const withCatch = "try { a(); } catch (e) {}\ntry { b(); } catch (e) {}\n";
    assert.equal(reviewPatchSafety({ filePath: "src/x.ts", before: withCatch, after: withCatch.replace("a();", "a(1);") }).safe, true);

    // But adding one MORE is exactly what should be caught.
    assert.ok(
      rules(reviewPatchSafety({ filePath: "src/legacy.ts", before: existing, after: existing + "\n// @ts-ignore\nbad();\n" })).includes("suppress-directive"),
      "a *new* directive alongside an existing one slipped through"
    );
    console.log("✓ Test 2 Passed: pre-existing directives don't lock a file; adding one still fires.");
  }

  // ── Test 3: honest refactors are not flagged ──────────────────────────────
  {
    const legit: Array<[string, string, string]> = [
      ["rename a variable", "const userCount = 5;\n", "const totalUsers = 5;\n"],
      ["move a function", "function a() { return 1; }\nfunction b() { return 2; }\n", "function a() { return 1; }\nfunction b() { return 3; }\n"],
      ["add a real assertion", "expect(1).toBe(1);\n", "expect(1).toBe(1);\nexpect(result).toBe(42);\n"],
      ["docs explaining suppression", "See below.\n", "Use `@ts-ignore` only as a last resort.\n"],
      ["regex mentioning skip", "const re = /skip|only/g;\n", "const re = /skip|only|x/g;\n"],
      ["string containing the word", 'const msg = "test.skip is disabled";\n', 'const msg = "test.skip and it.skip are disabled";\n'],
    ];
    for (const [label, before, after] of legit) {
      const r = reviewPatchSafety({ filePath: "src/App.tsx", before, after });
      assert.equal(r.safe, true, `${label} was flagged: ${formatPatchSafetyForUser(r)}`);
    }
    // The docs exemption must not become a hole: a secret in a README is still a finding.
    const readme = reviewPatchSafety({
      filePath: "docs/SETUP.md",
      before: "Set the token.\n",
      after: "Set the token: ghp_16C7eRYP2EASKfPMEGOXEOj5J3nIKh1LkGpL\n",
    });
    assert.ok(!readme.safe && rules(readme).includes("secret-introduced"),
      "a credential added to documentation was not caught");
    // ...while the same text explaining a directive is not a patch.
    assert.equal(
      reviewPatchSafety({ filePath: "docs/TYPES.md", before: "# Types\n", after: "# Types\n\nUse @ts-ignore sparingly.\n" }).safe,
      true, "documentation explaining a directive was refused"
    );
    console.log("✓ Test 3 Passed: renames, real assertions and docs pass; a secret in a README still does not.");
  }

  // ── Test 4: isTestPath / classification edges ─────────────────────────────
  {
    for (const p of ["a/b/c.test.ts", "tests/unit/x.test.ts", "src/__tests__/y.tsx", "main_test.go", "test_math.py", "FooTest.java", "e2e/flow.spec.ts"]) {
      assert.ok(isTestPath(p), `${p} not treated as a test`);
    }
    for (const p of ["src/App.tsx", "package.json", "latest.ts", "contest.ts", "docs/latest.md"]) {
      assert.ok(!isTestPath(p), `${p} wrongly treated as a test`);
    }
    console.log("✓ Test 4 Passed: test-file detection matches paths, not substrings like 'latest.ts'.");
  }

  // ── Test 5: the gateway refuses, and only an override passes ─────────────
  {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p32-gw-"));
    try {
      fs.writeFileSync(path.join(box, "app.ts"), "export const value = 1;\n");
      fs.writeFileSync(path.join(box, "app.test.ts"), "it('works', () => { expect(1).toBe(1); });\n");
      const registry = new ToolRegistry(CORE_TOOLS);
      const gateway = new ToolExecutionGateway(box);
      const ctx = { activeMode: "agent" as const, sessionId: "s" };

      const fakeFix = await gateway.executeGuarded(registry, {
        id: "t1", name: "patch_file",
        args: { path: "app.ts", target_code: "export const value = 1;", replacement_code: "// @ts-ignore\nexport const value = 1;" },
      } as any, ctx as any);
      assert.equal(fakeFix.isError, true, "gateway applied a fake fix");
      assert.match(fakeFix.output, /anti-fake-fix|@ts-ignore|suppress/i, `refusal unexplained: ${fakeFix.output.slice(0, 200)}`);
      assert.equal(fs.readFileSync(path.join(box, "app.ts"), "utf-8"), "export const value = 1;\n",
        "the file was written even though the call was refused");

      // An override must be an explicit, named one — not the absence of a check.
      const overridden = await gateway.executeGuarded(registry, {
        id: "t2", name: "patch_file",
        args: { path: "app.ts", target_code: "export const value = 1;", replacement_code: "// @ts-ignore\nexport const value = 1;" },
      } as any, { ...ctx, patchApprovalSource: "user:override-patch-safety" } as any);
      assert.ok(!overridden.isError, `a human override was still refused: ${overridden.output.slice(0, 160)}`);
      assert.match(fs.readFileSync(path.join(box, "app.ts"), "utf-8"), /@ts-ignore/, "override approved but did not write");

      // A legitimate edit passes untouched.
      const legit = await gateway.executeGuarded(registry, {
        id: "t3", name: "patch_file",
        args: { path: "app.ts", target_code: "export const value = 1;", replacement_code: "export const value = 2;" },
      } as any, ctx as any);
      assert.ok(!legit.isError, `an ordinary edit was refused: ${legit.output.slice(0, 160)}`);

      // write_file that deletes the assertions in a test file is caught too, and so is
      // deleting the test file itself by name.
      const stripped = await gateway.executeGuarded(registry, {
        id: "t4", name: "write_file",
        args: { path: "app.test.ts", content: "it('works', () => {});\n" },
      } as any, ctx as any);
      assert.equal(stripped.isError, true, "removing assertions via write_file passed");
      assert.match(stripped.output, /assertion|test/i);
      console.log("✓ Test 5 Passed: gateway refuses, real edits pass, and only a named override applies.");
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  }

  // ── Test 6: the before/after assembly per tool, including multi-hunk ──────
  {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p32-h-"));
    try {
      fs.writeFileSync(path.join(box, "f.ts"), "line1\nexpect(a).toBe(1);\nline3\nexpect(b).toBe(2);\n");
      const guard = new CanonicalPathGuard(box);
      const read = (p: string) => {
        const abs = guard.validateAndResolve(p);
        return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
      };
      const asTool = (name: string) => ({ name, isMutating: true, permissionLevel: "readwrite" } as any);

      // A fake fix split across two hunks must not read as two safe edits.
      const split = reviewMutatingPatchForSafety(asTool("edit_file"), {
        path: "f.ts",
        edits: [
          { oldText: "expect(a).toBe(1);", newText: "// expect(a).toBe(1);" },
          { oldText: "expect(b).toBe(2);", newText: "// expect(b).toBe(2);" },
        ],
      }, { readGuarded: read });
      assert.ok(split && !split.safe, "a fake fix spread over two hunks was not caught");
      assert.ok(rules(split!).includes("assertion-commented-out"), `wrong rules: ${rules(split!)}`);

      // Deleting a test file is caught by name; deleting ordinary code is not (that is
      // what delete_path exists for, and it is reversible via the trash + /undo).
      fs.writeFileSync(path.join(box, "helpers.test.ts"), "it('a', () => {});\n");
      const del = reviewMutatingPatchForSafety(asTool("delete_path"), { path: "helpers.test.ts" }, { readGuarded: read });
      assert.ok(del && !del.safe, "deleting a test file raised no concern");
      assert.ok(rules(del!).includes("test-file-deleted"), `wrong rules for a deleted test: ${rules(del!)}`);
      const delPlain = reviewMutatingPatchForSafety(asTool("delete_path"), { path: "scratch.ts" }, { readGuarded: () => "x" });
      assert.equal(delPlain?.safe, true, "deleting ordinary code was refused");

      // A non-content tool is not reviewed at all.
      assert.equal(reviewMutatingPatchForSafety(asTool("list_directory"), { path: "." }, { readGuarded: read }), null);
      // No path → nothing to review, rather than a crash.
      assert.equal(reviewMutatingPatchForSafety(asTool("write_file"), { content: "x" }, { readGuarded: read }), null);
      console.log("✓ Test 6 Passed: multi-hunk, deletions and non-edit tools are assembled correctly.");
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  }

  // ── Test 7: the old façade and the enforcement cannot disagree ────────────
  {
    // `RepairLoop.validatePatchSafety` is what existed before, and was never called.
    // It must now report the same verdict as the gateway path, or one of the two callers
    // is quietly working to a different definition of a fake fix.
    const loop = new RepairLoop("s-test");
    const cases: Array<[string, string, boolean]> = [
      ["const a = 1;", "// @ts-ignore\nconst a = 1;", false],
      ["const a = 1;", "const a = 2;", true],
      ["// @ts-ignore\nconst a = 1;", "// @ts-ignore\nconst a = 2;", true],
    ];
    for (const [before, after, wantSafe] of cases) {
      const viaLoop = loop.validatePatchSafety(before, after);
      const viaEngine = reviewPatchSafety({ before, after });
      assert.equal(viaLoop.isSafe, viaEngine.safe, "RepairLoop and the gateway disagree on the same input");
      assert.equal(viaLoop.isSafe, wantSafe, `wrong verdict for ${JSON.stringify(after)}`);
      if (!wantSafe) assert.ok((viaLoop.violations || []).length > 0 && viaLoop.violationReason, "no reason surfaced");
    }
    console.log("✓ Test 7 Passed: RepairLoop delegates to the same ruleset the gateway enforces.");
  }

  // ── Test 8: through a real turn, the human is asked BEFORE it is applied ──
  {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p32-loop-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      fs.writeFileSync(path.join(box, "app.ts"), "export const value = 1;\n");
      let request = 0;
      // `any` deliberately: TS narrows the closure-assigned value to `never` here,
      // and the assertions below are the runtime check that matters.
      let seenApproval: any = null;
      (globalThis as any).fetch = async () => {
        request++;
        if (request === 1) {
          return toolCall("patch_file", {
            path: "app.ts",
            target_code: "export const value = 1;",
            replacement_code: "// @ts-expect-error because it is fine\nexport const value = 1;",
          });
        }
        return textReply("done");
      };

      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: box, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async (req) => { seenApproval = req; return false; },   // human says NO
        "low",
        new LocalJsonSessionStore(box) as never
      );
      const turn = await orchestrator.runTurn("silence the error");

      assert.ok(seenApproval, "the human was never consulted");
      assert.ok(seenApproval!.patchSafety && !seenApproval!.patchSafety!.safe,
        "the approval request carried no fake-fix finding — the human would have seen a normal edit");
      assert.ok(rules(seenApproval!.patchSafety!).includes("suppress-directive"),
        `approval showed ${rules(seenApproval!.patchSafety!)}`);
      assert.equal(fs.readFileSync(path.join(box, "app.ts"), "utf-8"), "export const value = 1;\n",
        "a refused fake fix reached the disk");
      // The refusal must reach *both* audiences: the model through the tool message in
      // context, and the human through `toolResults`. Assert on the shared reason text so
      // neither can regress silently — "denied" alone would send the model off to retry a
      // variant, and an empty `toolResults` would hide the refusal from the CLI/extension.
      const denial = (orchestrator as any).context.history
        .filter((m: any) => m.role === "tool")
        .map((m: any) => String(m.content))
        .find((c: string) => /denied/i.test(c));
      assert.ok(denial, "the model was never told the edit did not happen");
      assert.match(denial, /anti-fake-fix/i, `the denial carried no reason: ${denial.slice(0, 200)}`);
      assert.match(denial, /underlying defect|override/i, `the denial gave no next step: ${denial.slice(0, 240)}`);
      assert.equal(turn.toolResults.length, 1, `denied call should be reported to the UI exactly once: ${JSON.stringify(turn.toolResults)}`);
      assert.equal(turn.toolResults[0].isError, true, "the refusal was reported as a success");
      assert.match(turn.toolResults[0].output, /anti-fake-fix/i,
        `the UI-facing result lost the reason: ${turn.toolResults[0].output.slice(0, 200)}`);
      console.log("✓ Test 8 Passed: in a real turn the violation reaches the human, and the model is told why.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(box, { recursive: true, force: true });
    }
  }

  // ── Test 9: a human "yes" really does apply the overridden edit ────────────
  {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p32-yes-"));
    const originalFetch = (globalThis as any).fetch;
    try {
      fs.writeFileSync(path.join(box, "app.ts"), "export const value = 1;\n");
      let request = 0;
      (globalThis as any).fetch = async () => {
        request++;
        if (request === 1) {
          return toolCall("patch_file", {
            path: "app.ts",
            target_code: "export const value = 1;",
            replacement_code: "// @ts-expect-error upstream types are wrong\nexport const value = 1;",
          });
        }
        return textReply("suppressed as agreed");
      };
      const orchestrator = await AgentOrchestrator.start(
        { workspaceRoot: box, providerId: "openai", model: "gpt-4o", apiKey: "mock_key", activeMode: "agent", modelAdapter: "openai-chat" },
        new ToolRegistry(CORE_TOOLS) as never,
        new AgentEventBus() as never,
        async () => true,   // human overrides
        "low",
        new LocalJsonSessionStore(box) as never
      );
      const turn = await orchestrator.runTurn("suppress it, I approve");
      assert.match(fs.readFileSync(path.join(box, "app.ts"), "utf-8"), /@ts-expect-error/,
        "an approved override did not apply — the human's decision was ignored");
      assert.equal(turn.toolResults.length, 1, "the approved edit produced no result");
      assert.ok(!turn.toolResults[0].isError, `approved override was refused: ${turn.toolResults[0].output.slice(0, 160)}`);
      console.log("✓ Test 9 Passed: an explicit human override applies, and is not silently re-refused.");
    } finally {
      (globalThis as any).fetch = originalFetch;
      fs.rmSync(box, { recursive: true, force: true });
    }
  }

  console.log("\n🎉 All Phase 32 Anti-Fake-Fix Tests Passed 100%!");
}

runAntiFakeFixTests().catch((err) => {
  console.error("Anti-fake-fix test failed:", err);
  process.exit(1);
});

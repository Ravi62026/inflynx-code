/**
 * Backlog Phase 25 — LSP/diagnostics + symbol tools.
 *
 * The headline property the phase sets ("post-edit the agent sees '2 type errors in
 * x.ts:12' without running `tsc`") is about the *compiler's* view, so the tests build a
 * tiny real TypeScript project in a temp dir and ask the language service behind the tools.
 * They assert on diagnostic codes and locations rather than exact message wording, which
 * drifts between TypeScript versions.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ToolRegistry,
  CORE_TOOLS,
  ToolExecutionGateway,
  createToolExecutionContextFromGuard,
  resetLanguageServices,
  type FileDiagnostic,
} from "../../packages/tool-runtime/src/index.js";
import { getDiagnosticsForFile } from "../../packages/tool-runtime/src/diagnostics-tools.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/index.js";
import { cleanupOnExit } from "../helpers/tmp.js";

/** A temp workspace with a tsconfig and one good + one bad file. */
function makeProject(): { root: string; goodRel: string; badRel: string } {
  const root = cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-diag-")));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true },
    include: ["**/*.ts"],
  }, null, 2));
  fs.writeFileSync(path.join(root, "good.ts"),
    "export function add(a: number, b: number): number { return a + b; }\n" +
    "export const LIMIT = 10;\n" +
    "export interface Shape { area(): number }\n" +
    "export class Circle implements Shape { constructor(private r: number) {} area() { return Math.PI * this.r * this.r; } }\n");
  // Two deliberate type errors: number→string on line 2, string→number on line 3.
  fs.writeFileSync(path.join(root, "bad.ts"),
    "import { add } from \"./good\";\n" +
    "const x: string = add(1, 2);\n" +
    "const y: number = \"definitely not a number\";\n" +
    "export { x, y };\n");
  return { root, goodRel: "good.ts", badRel: "bad.ts" };
}

function text(r: unknown): string {
  return typeof r === "string" ? r : (r as { output: string }).output;
}
function isError(r: unknown): boolean {
  return typeof r !== "string" && (r as { isError?: boolean }).isError === true;
}

async function runPhase25Tests(): Promise<void> {
  console.log("🧪 Running Phase 25 Diagnostics & Symbol Tool Tests...\n");

  // ── Test 1: real type errors, at the exact line:column ───────────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d1" });
    const reg = new ToolRegistry(CORE_TOOLS);
    const out = await reg.get("list_diagnostics")!.execute({ paths: ["bad.ts"] } as never, ctx as never);
    const s = text(out);
    assert.equal(isError(out), false, s);
    assert.match(s, /bad\.ts:2:7\s+error\s+TS2322/, `line 2 error wrong:\n${s}`);
    assert.match(s, /bad\.ts:3:7\s+error\s+TS2322/, `line 3 error wrong:\n${s}`);
    assert.match(s, /2 errors/, `count wrong:\n${s}`);
    assert.match(s, /not assignable/, `message lost:\n${s}`);
    console.log("✓ Test 1 Passed: the compiler's errors surface with exact line:col and TS codes, no tsc.");
  }

  // ── Test 2: a clean file is clean, and the note is honest ────────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d2" });
    const reg = new ToolRegistry(CORE_TOOLS);
    const out = await reg.get("list_diagnostics")!.execute({ paths: ["good.ts"] } as never, ctx as never);
    const s = text(out);
    assert.equal(isError(out), false, s);
    assert.match(s, /No type errors in good\.ts/, s);
    // The anti-false-green note: "no type errors" is not "the project builds".
    assert.match(s, /not a substitute for running the project's build/, `missing the honesty note:\n${s}`);
    console.log("✓ Test 2 Passed: clean file reported clean, with the honest scope caveat.");
  }

  // ── Test 3: it reflects an EDIT without re-running anything ──────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d3" });
    const reg = new ToolRegistry(CORE_TOOLS);
    const before = text(await reg.get("list_diagnostics")!.execute({ paths: ["good.ts"] } as never, ctx as never));
    assert.match(before, /No type errors/);
    // Introduce an error by rewriting the file, then ask again — the language service must
    // see the new bytes (the mtime+size snapshot version), not a stale AST.
    fs.writeFileSync(path.join(root, "good.ts"), "export const n: number = \"oops\";\n");
    const after = text(await reg.get("list_diagnostics")!.execute({ paths: ["good.ts"] } as never, ctx as never));
    assert.match(after, /good\.ts:1:14\s+error\s+TS2322/, `post-edit error not seen:\n${after}`);
    console.log("✓ Test 3 Passed: a fresh edit is diagnosed without any rebuild — the point of the phase.");
  }

  // ── Test 4: non-TS and out-of-workspace inputs are refused, not cleared ─
  {
    const { root } = makeProject();
    resetLanguageServices();
    fs.writeFileSync(path.join(root, "notes.md"), "# hello\n");
    const guard = new CanonicalPathGuard(root);
    const ctx = createToolExecutionContextFromGuard(guard as never, { sessionId: "d4" });
    const reg = new ToolRegistry(CORE_TOOLS);

    const md = await reg.get("list_diagnostics")!.execute({ paths: ["notes.md"] } as never, ctx as never);
    assert.equal(isError(md), true, "a .md file was reported as clean");
    assert.match(text(md), /TypeScript\/JavaScript/, text(md));

    const missing = await reg.get("list_diagnostics")!.execute({ paths: ["nope.ts"] } as never, ctx as never);
    assert.equal(isError(missing), true, "a missing file was reported as clean");
    assert.match(text(missing), /does not exist/, text(missing));

    // A directory is not a file — scanning "." would be an implicit whole-workspace typecheck.
    const dir = await reg.get("list_diagnostics")!.execute({ paths: ["."] } as never, ctx as never);
    assert.equal(isError(dir), true, "a directory was accepted");
    assert.match(text(dir), /individual files, not directories/, text(dir));

    // And no paths at all: the tool must not silently fall back to a huge scan.
    const none = await reg.get("list_diagnostics")!.execute({} as never, ctx as never);
    assert.equal(isError(none), true, "an empty request was accepted");
    assert.match(text(none), /deliberately not offered/, text(none));
    console.log("✓ Test 4 Passed: .md, missing file, directory and empty request all refuse with a reason.");
  }

  // ── Test 5: list_symbols is the real API surface, not a grep ────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d5" });
    const reg = new ToolRegistry(CORE_TOOLS);
    const s = text(await reg.get("list_symbols")!.execute({ path: "good.ts" } as never, ctx as never));
    for (const name of ["add", "LIMIT", "Shape", "Circle"]) {
      assert.ok(s.includes(name), `symbol ${name} missing:\n${s}`);
    }
    assert.match(s, /function\s+add/, s);
    assert.match(s, /interface\s+Shape/, s);
    assert.match(s, /class\s+Circle/, s);
    assert.equal(isError(await reg.get("list_symbols")!.execute({ path: "good.ts" } as never, ctx as never)), false);
    // exported_only filters; include_methods adds the class member.
    const exported = text(await reg.get("list_symbols")!.execute({ path: "bad.ts", exported_only: true } as never, ctx as never));
    // bad.ts exports only via `export { x, y }` (not inline), so an exported-only pass on it
    // legitimately finds nothing inline — assert the honest empty message, not a crash.
    assert.match(exported, /No top-level declarations found|exported/, `empty-export handling wrong:\n${exported}`);
    const withMethods = text(await reg.get("list_symbols")!.execute({ path: "good.ts", include_methods: true } as never, ctx as never));
    assert.match(withMethods, /method\s+area/, `class methods not listed:\n${withMethods}`);
    console.log("✓ Test 5 Passed: exported functions/classes/interfaces/types found; methods and filters work.");
  }

  // ── Test 6: find_definition jumps across files ──────────────────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d6" });
    const reg = new ToolRegistry(CORE_TOOLS);
    // bad.ts line 1: import { add } from "./good"; — `add` sits at column 10.
    const s = text(await reg.get("find_definition")!.execute({ path: "bad.ts", line: 1, column: 10 } as never, ctx as never));
    assert.match(s, /good\.ts:1:/, `did not jump to the declaration:\n${s}`);
    // A bad line is reported, not crashed on.
    const oob = await reg.get("find_definition")!.execute({ path: "bad.ts", line: 9999, column: 1 } as never, ctx as never);
    assert.equal(isError(oob), true, "an out-of-range line was accepted");
    assert.match(text(oob), /past the end/, text(oob));
    const kw = text(await reg.get("find_definition")!.execute({ path: "bad.ts", line: 4, column: 1 } as never, ctx as never));
    assert.ok(typeof kw === "string", "no-definition case must return text, not throw");
    console.log("✓ Test 6 Passed: cross-file go-to-definition works; bad positions are handled honestly.");
  }

  // ── Test 7: through the gateway — readonly, offered everywhere, no writes
  {
    const { root } = makeProject();
    resetLanguageServices();
    const registry = new ToolRegistry(CORE_TOOLS);
    const gateway = new ToolExecutionGateway(root);
    for (const mode of ["agent", "plan", "ask", "debug"] as const) {
      const r = await gateway.executeGuarded(registry, {
        id: `g${mode}`, name: "list_diagnostics", args: { paths: ["bad.ts"] },
      } as never, { activeMode: mode, sessionId: "s" } as never);
      assert.ok(!r.isError, `list_diagnostics blocked in [${mode}]: ${r.output.slice(0, 120)}`);
      assert.match(r.output, /TS2322/, `[${mode}] did not run the real check`);
    }
    // It never touches the disk as a mutation and never becomes a source edit for the gate.
    const tool = registry.get("list_diagnostics")!;
    assert.equal(tool.isMutating, false);
    assert.equal(tool.permissionLevel, "readonly");
    assert.equal(tool.cacheable, false, "a cached diagnosis would lie after the next edit");
    console.log("✓ Test 7 Passed: readonly + offered in all four modes through the gateway; non-cacheable.");
  }

  // ── Test 8: the verification-gate pre-check API is real ─────────────────
  {
    const { root } = makeProject();
    resetLanguageServices();
    const ctx = createToolExecutionContextFromGuard(new CanonicalPathGuard(root) as never, { sessionId: "d8" });
    const errs = getDiagnosticsForFile(path.join(root, "bad.ts"), ctx);
    assert.equal(errs.length, 2, `expected 2 errors, got ${errs.length}`);
    assert.ok(errs.every((e: FileDiagnostic) => e.severity === "error"), "warnings leaked into the error-only helper");
    assert.ok(errs.every((e: FileDiagnostic) => e.code > 0 && e.line > 0 && e.column > 0),
      "an error lacked a code or position");
    // The clean file yields none — so a pre-check on it is a no-op, not a false failure.
    assert.equal(getDiagnosticsForFile(path.join(root, "good.ts"), ctx).length, 0);
    console.log("✓ Test 8 Passed: getDiagnosticsForFile gives the gate an error-only cheap pre-check.");
  }

  // ── Test 9: registry contract the UIs read ──────────────────────────────
  {
    const tools = new ToolRegistry(CORE_TOOLS).list();
    const names = tools.map((t) => t.name);
    for (const expected of ["list_diagnostics", "list_symbols", "find_definition"]) {
      assert.ok(names.includes(expected), `${expected} not registered`);
    }
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "delegate", "delete_path", "edit_file", "execute_shell", "fetch_url", "find_definition", "git", "glob_files",
        "list_diagnostics", "list_directory", "list_symbols", "move_path", "patch_file", "read_file",
        "search_files", "shell_list", "shell_output", "shell_stop", "update_plan", "web_search", "write_file",
      ].sort(),
      `tool set drifted (${tools.length})`);
    console.log(`✓ Test 9 Passed: ${tools.length} tools; the three diagnostics tools are registered.`);
  }

  resetLanguageServices();
  console.log("\n🎉 All Phase 25 Diagnostics & Symbol Tool Tests Passed 100%!");
}

runPhase25Tests().catch((err) => {
  console.error("Phase 25 test failed:", err);
  process.exit(1);
});

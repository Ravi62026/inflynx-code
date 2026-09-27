/**
 * Backlog Phase 23 — multi-hunk `edit_file`.
 *
 * The property under test is *atomicity*: "the file is either fully edited or untouched".
 * That is only true if the check happens before any write, so most of these tests assert
 * the on-disk bytes after a failed call rather than trusting the error string.
 *
 * Also pinned here, because it is the part that would otherwise silently rot:
 *  - Phase 30's `/undo` must reverse a multi-edit call as ONE step
 *  - Phase 32's fake-fix review must see the combined result, not each hunk alone
 *  - the gateway's mode fence must treat edit_file as the mutating tool it is
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
} from "../../packages/tool-runtime/src/index.js";
import { CanonicalPathGuard } from "../../packages/policy-engine/src/index.js";
import { TurnCheckpointStore } from "../../packages/patch-engine/src/index.js";

const SOURCE = [
  "export function parse(text: string) {",
  "  const parts = text.split(\",\");",
  "  return parts.map((p) => p.trim());",
  "}",
  "",
  "export function format(items: string[]) {",
  "  return items.join(\",\");",
  "}",
  "",
].join("\n");

/** A tool returns a string on success and {output,isError} on refusal; read either. */
function textOf(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

/** One cast, because tests import `src` while tool-runtime types the `dist` guard (M8). */
function ctxFor(guard: CanonicalPathGuard, sessionId: string) {
  return createToolExecutionContextFromGuard(guard as never, { sessionId });
}

function fixture(): { root: string; guard: CanonicalPathGuard; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-p23-"));
  const guard = new CanonicalPathGuard(root);
  const file = path.join(root, "src", "parse.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SOURCE, "utf-8");
  return { root, guard, file };
}

async function runMultiHunkTests(): Promise<void> {
  console.log("🧪 Running Phase 23 Multi-Hunk Edit Tests...\n");

  // ── Test 1: several hunks, one write ──────────────────────────────────────
  {
    const { root, guard, file } = fixture();
    try {
      const ctx = ctxFor(guard, "s1");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;
      const out = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [
          { oldText: 'text.split(",")', newText: 'text.split(/\\s*,\\s*/)' },
          { oldText: "return parts.map((p) => p.trim());", newText: "return parts.map((p) => p.trim()).filter(Boolean);" },
          { oldText: 'return items.join(",");', newText: 'return items.join(", ");' },
        ],
      }, ctx));

      assert.match(out, /Applied 3 edit\(s\).*atomic/s, `unexpected result: ${out.slice(0, 200)}`);
      const now = fs.readFileSync(file, "utf-8");
      assert.ok(now.includes("text.split(/\\s*,\\s*/)"), "edit 1 missing");
      assert.ok(now.includes(".filter(Boolean)"), "edit 2 missing");
      assert.ok(now.includes('items.join(", ")'), "edit 3 missing");
      // Untouched lines must stay untouched — this is a diff, not a rewrite.
      assert.ok(now.includes("export function parse(text: string) {"), "the file was restructured");
      // Three changes inside an 8-line file, with 3 lines of context, merge into a
      // single hunk — several hunks here would mean the diff engine is not merging.
      assert.equal((out.match(/^@@ /gm) || []).length, 1,
        `expected one merged hunk for a small file, got ${out}`);
      console.log("✓ Test 1 Passed: 3 hunks applied in one write; untouched lines preserved.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 2: atomicity — a failure mid-list writes NOTHING ─────────────────
  {
    const { root, guard, file } = fixture();
    try {
      const ctx = ctxFor(guard, "s2");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;
      const before = fs.readFileSync(file, "utf-8");

      const out = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [
          { oldText: 'text.split(",")', newText: "CHANGED-1" },
          { oldText: "return items.join(\",\");", newText: "CHANGED-2" },
          { oldText: "this line does not exist anywhere", newText: "CHANGED-3" },
        ],
      }, ctx));

      assert.equal(fs.readFileSync(file, "utf-8"), before,
        "N3 BROKEN: edits 1 and 2 reached the disk although edit 3 failed");
      assert.match(out, /edit #3 of 3/, `error did not say which edit failed: ${out.slice(0, 180)}`);
      assert.match(out, /no match/i);
      // Two edits did precede this failure, so saying so is accurate — and it must still
      // be explicit that nothing reached disk.
      assert.match(out, /2 earlier edit\(s\).*nothing was written/s,
        `partial-state note wrong for a late failure: ${out.slice(0, 220)}`);
      assert.match(out, /Re-read|indentation/i, "the error gives the model no next step");
      console.log("✓ Test 2 Passed: edit #3 missing leaves the file byte-identical, and says which one.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 3: ambiguity refuses, and more context resolves it ───────────────
  {
    const { root, guard, file } = fixture();
    try {
      const ctx = ctxFor(guard, "s3");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;
      const before = fs.readFileSync(file, "utf-8");

      // `}` appears many times; `return ` twice.
      const ambiguous = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [{ oldText: "  return ", newText: "  RETURN " }],
      }, ctx));
      assert.match(ambiguous, /ambiguous/, `no ambiguity reported: ${ambiguous.slice(0, 180)}`);
      assert.match(ambiguous, /appears 2 times/, `count not reported: ${ambiguous}`);
      assert.equal(fs.readFileSync(file, "utf-8"), before, "an ambiguous edit was applied anyway");

      // Same call, made unique by including the line.
      const fixed = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [{ oldText: "  return parts.map", newText: "  const mapped = parts.map" }],
      }, ctx));
      assert.match(fixed, /Applied 1 edit/, `unique version failed: ${fixed.slice(0, 160)}`);
      console.log("✓ Test 3 Passed: a non-unique oldText is refused with its occurrence count; context fixes it.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 4: replace_all, and ordering (edit 2 sees edit 1's output) ───────
  {
    const { root, guard, file } = fixture();
    try {
      const ctx = ctxFor(guard, "s4");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;

      const all = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [{ oldText: "return ", newText: "RET ", replaceAll: true }],
      }, ctx));
      assert.match(all, /Applied 1 edit/, `replaceAll refused: ${all.slice(0, 160)}`);
      const now = fs.readFileSync(file, "utf-8");
      assert.ok(!now.includes("return "), "replaceAll did not replace all");
      assert.equal((now.match(/RET /g) || []).length, 2, `expected 2 replacements: ${now}`);

      // Sequential application: the second edit targets what the first produced.
      fs.writeFileSync(file, SOURCE, "utf-8");
      const seq = textOf(await edit.execute({
        path: "src/parse.ts",
        edits: [
          { oldText: "const parts = text.split", newText: "const pieces = text.split" },
          { oldText: "return parts.map", newText: "return pieces.map" },
        ],
      }, ctx));
      assert.match(seq, /Applied 2 edit/, `ordered edits failed: ${seq.slice(0, 200)}`);
      const after = fs.readFileSync(file, "utf-8");
      assert.ok(!after.includes("parts"), "edits were applied against the original text, not sequentially");
      console.log("✓ Test 4 Passed: replace_all replaces all; edits apply in order against the working copy.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 5: refusal paths that must not touch disk ────────────────────────
  {
    const { root, guard, file } = fixture();
    try {
      const ctx = ctxFor(guard, "s5");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;
      const before = fs.readFileSync(file, "utf-8");
      const expectError = async (args: Record<string, unknown>, re: RegExp, label: string) => {
        const out = textOf(await edit.execute(args as any, ctx));
        assert.match(out, re, `${label}: ${out.slice(0, 160)}`);
      };
      await expectError({ path: "src/parse.ts", edits: [] }, /non-empty 'edits'/, "empty list");
      await expectError({ path: "src/parse.ts", edits: [{ oldText: "", newText: "x" }] }, /empty oldText/, "empty oldText");
      await expectError({ path: "src/missing.ts", edits: [{ oldText: "a", newText: "b" }] }, /does not exist.*write_file|Use write_file/s, "missing file");
      await expectError({ path: "src/parse.ts", edits: [{ oldText: "nope, not in this file", newText: "y" }] }, /edit #1 of 1 found no match/, "first edit missing");
      // Nothing preceded this failure, so the message must not claim that it did.
      await expectError({ path: "src/parse.ts", edits: [{ oldText: "nope", newText: "y" }, { oldText: "x", newText: "z" }] }, /edit #1 of 2[\s\S]*Nothing was written/, "first-edit note must not mention earlier edits");
      assert.ok(!(await edit.execute({ path: "src/parse.ts", edits: [{ oldText: "nope", newText: "y" }] }, ctx) as any)
        .output.includes("earlier edit"), "a first-edit failure mentioned earlier edits");
      assert.equal(fs.readFileSync(file, "utf-8"), before, "a refused call modified the file");
      console.log("✓ Test 5 Passed: empty/ambiguous/missing-path calls refuse and leave the file alone.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 6: CRLF files are edited, not normalized ─────────────────────────
  {
    const { root, guard } = fixture();
    try {
      const crlf = path.join(root, "win.ts");
      fs.writeFileSync(crlf, "export const a = 1;\r\nexport const b = 2;\r\n", "utf-8");
      const ctx = ctxFor(guard, "s6");
      const edit = new ToolRegistry(CORE_TOOLS).get("edit_file")!;
      await edit.execute({ path: "win.ts", edits: [{ oldText: "export const b = 2;", newText: "export const b = 3;" }] }, ctx);

      const now = fs.readFileSync(crlf, "utf-8");
      assert.ok(now.includes("export const b = 3;"), "the edit did not land");
      assert.equal((now.match(/\r\n/g) || []).length, 2, `CRLF endings were normalized away: ${JSON.stringify(now)}`);
      assert.ok(!now.includes("export const a = 1;\r\r\n"), "double carriage returns appeared");
      console.log("✓ Test 6 Passed: a CRLF file keeps both its endings and its untouched line.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 7: through the gateway — fence, path coverage, atomic undo ───────
  {
    const { root, file } = fixture();
    try {
      const gateway = new ToolExecutionGateway(root);
      const registry = new ToolRegistry(CORE_TOOLS);
      const call = {
        id: "e1",
        name: "edit_file",
        args: {
          path: "src/parse.ts",
          edits: [
            { oldText: 'text.split(",")', newText: "WRONG" },
            { oldText: 'items.join(",")', newText: "ALSO-WRONG" },
          ],
        },
      };
      const before = fs.readFileSync(file, "utf-8");

      // The [plan] fence must see this as the mutating tool it is.
      const planned = await gateway.executeGuarded(registry, call as any, { activeMode: "plan", sessionId: "s7" } as any);
      assert.equal(planned.isError, true, "edit_file wrote files while in [plan] mode");
      assert.equal(fs.readFileSync(file, "utf-8"), before, "[plan] fence let the write through");

      // An absolute path INSIDE the workspace is allowed and canonicalised (that is the
      // guard's documented job) — what must be refused is anything that lands outside.
      const absInside = await gateway.executeGuarded(registry, {
        id: "e3", name: "edit_file",
        args: { path: file, edits: [{ oldText: 'text.split(",")', newText: "x" }] },
      } as any, { activeMode: "agent", sessionId: "s7" } as any);
      assert.ok(!absInside.isError, `an in-workspace absolute path was refused: ${absInside.output.slice(0, 160)}`);
      assert.match(fs.readFileSync(file, "utf-8"), /const parts = x;/, "the allowed edit did not land");

      for (const escapee of ["/etc/hosts", path.join(os.homedir(), ".ssh", "authorized_keys"), "../../outside.ts"]) {
        const escaped = await gateway.executeGuarded(registry, {
          id: "e4", name: "edit_file",
          args: { path: escapee, edits: [{ oldText: "x", newText: "y" }] },
        } as any, { activeMode: "agent", sessionId: "s7" } as any);
        assert.equal(escaped.isError, true, `edit_file reached outside the workspace via ${escapee}`);
      }

      // A legitimate run through the gateway, checkpointed, then undone as ONE step.
      // Reset first: the absolute-path case above already edited this file, and `call`
      // targets the original text.
      fs.writeFileSync(file, SOURCE, "utf-8");
      const before2 = fs.readFileSync(file, "utf-8");
      const store = new TurnCheckpointStore(root);
      store.beginTurn("s7", "turn-1", "two-hunk refactor");
      (gateway as any).checkpoints = store;
      const ok = await gateway.executeGuarded(registry, { ...call, id: "e5" } as any, { activeMode: "agent", sessionId: "s7" } as any);
      assert.ok(!ok.isError, `a legitimate edit_file was refused: ${ok.output.slice(0, 200)}`);
      const after = fs.readFileSync(file, "utf-8");
      assert.notEqual(after, before2, "the edit did not reach disk");
      await store.commitTurn();
      const undone = store.undo(store.latest("s7")!);
      assert.equal(undone.conflicts.length, 0, JSON.stringify(undone.conflicts));
      assert.equal(undone.restored.length, 1, "two hunks should be ONE undoable entry");
      assert.equal(fs.readFileSync(file, "utf-8"), before2,
        "undo did not restore the pre-call state byte-for-byte");
      console.log("✓ Test 7 Passed: gateway fence, path rules, and a multi-hunk edit undone as one step.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 8: Phase 32 sees the combined result, not each hunk alone ────────
  {
    const { root } = fixture();
    try {
      const gateway = new ToolExecutionGateway(root);
      const registry = new ToolRegistry(CORE_TOOLS);
      fs.writeFileSync(path.join(root, "src", "x.test.ts"), "it('a', () => { expect(1).toBe(1); });\nit('b', () => { expect(2).toBe(2); });\n", "utf-8");

      // Neither edit alone is obviously a fake fix; together they gut the assertions.
      const out = await gateway.executeGuarded(registry, {
        id: "e4", name: "edit_file",
        args: {
          path: "src/x.test.ts",
          edits: [
            { oldText: "expect(1).toBe(1);", newText: "// checked manually" },
            { oldText: "expect(2).toBe(2);", newText: "// checked manually" },
          ],
        },
      } as any, { activeMode: "agent", sessionId: "s8" } as any);

      assert.equal(out.isError, true, "a fake fix split across hunks passed the gate");
      assert.match(out.output, /anti-fake-fix|assertion|comment/i, `unexplained refusal: ${out.output.slice(0, 200)}`);
      assert.ok(!fs.readFileSync(path.join(root, "src", "x.test.ts"), "utf-8").includes("checked manually"),
        "the refused multi-hunk fake fix reached the disk");
      console.log("✓ Test 8 Passed: a fake fix spread over hunks is caught on the combined result.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Test 9: the contract the rest of the system reads ────────────────────
  {
    const tools = new ToolRegistry(CORE_TOOLS).list();
    const edit = tools.find((t) => t.name === "edit_file");
    assert.ok(edit, "edit_file is not in CORE_TOOLS");
    assert.equal(edit!.isMutating, true, "edit_file must be flagged mutating (it writes files)");
    assert.equal(edit!.permissionLevel, "readwrite");
    assert.deepEqual(edit!.parameters.required, ["path", "edits"]);
    // Pinned by *names*, not a bare count: a count tells you something drifted but not
    // what, and a duplicate or a rename can keep the number steady. Adding a tool here
    // means updating §2 of the backlog doc in the same change.
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "delete_path", "edit_file", "execute_shell", "fetch_url", "find_definition", "git", "glob_files",
        "list_diagnostics", "list_directory", "list_symbols", "move_path", "patch_file", "read_file",
        "search_files", "shell_list", "shell_output", "shell_stop", "update_plan", "web_search", "write_file",
      ].sort(),
      `tool set drifted (${tools.length}) — update §2 baseline and docs together`);
    // Nested schema must survive to the provider-facing shape.
    assert.ok(edit!.parameters.properties.edits.items?.properties?.oldText, "nested edit schema was lost");
    console.log(`✓ Test 9 Passed: ${tools.length} tools, edit_file declared mutating with a nested schema.`);
  }

  console.log("\n🎉 All Phase 23 Multi-Hunk Edit Tests Passed 100%!");
}

runMultiHunkTests().catch((err) => {
  console.error("Multi-hunk edit test failed:", err);
  process.exit(1);
});

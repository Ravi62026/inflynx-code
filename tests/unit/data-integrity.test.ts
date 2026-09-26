/**
 * Backlog Phases 4 & 5 — data-corruption and single-workspace-root regression suite.
 *
 * Guards four silent-corruption paths that produced no error and no visible
 * symptom, only wrong output:
 *
 *   1. `applySurgicalPatch` / `stageFileWrite` rewrote every line ending of a
 *      CRLF file (backlog F1).
 *   2. `redactSecrets` was applied to tool output *before it entered the model's
 *      own context*, so ordinary identifiers like `handle_user_authentication_flow`
 *      arrived as `[REDACTED_API_KEY]` and got written back to disk corrupted
 *      (backlog B13).
 *   3. No tool-result size ceiling existed outside `fetch_url`, so one large
 *      `read_file` could drop ~250k tokens into the conversation permanently
 *      (backlog D3).
 *   4. Tools re-resolved paths against `process.env.INFLYNX_WORKSPACE_ROOT ||
 *      process.cwd()` — a third root that disagreed with the gateway's guard and
 *      made multi-session servers able to read/write the wrong project
 *      (backlog H1, Phase 5).
 *
 * The harness stubs `global.fetch` the same way `orchestrator-gateway.test.ts`
 * does, and works entirely inside a temp directory — it never touches the real
 * `.inflynx/session_store.json` (see backlog M2).
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import {
  ToolExecutionGateway,
  ToolRegistry,
  CORE_TOOLS,
  capToolOutput,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
} from "../../packages/tool-runtime/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";
import { redactSecrets } from "../../packages/config/src/index.js";
import {
  applySurgicalPatch,
  detectEol,
  EditTransactionManager,
} from "../../packages/patch-engine/src/index.js";

// ─── Provider-stream stub helpers ─────────────────────────────────────────────

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}`).join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function toolCallResponse(toolName: string, args: Record<string, unknown>): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_integrity_1", function: { name: toolName, arguments: "" } }] } }],
    }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ]);
}

function finalTextResponse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

/** Stubs fetch, returning the scripted responses in order, and records every request body. */
function stubFetchRecording(requestBodies: string[]): Array<() => Response> {
  const queue: Array<() => Response> = [];
  let index = 0;
  (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
    if (init?.body) requestBodies.push(init.body);
    const next = queue[Math.min(index, queue.length - 1)];
    index++;
    return next();
  };
  return queue;
}

async function runDataIntegrityTests(): Promise<void> {
  console.log("🧱 Running Phase 4 & 5 Data-Integrity / Workspace-Isolation Tests...\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-integrity-"));
  const originalFetch = (globalThis as any).fetch;
  // No INFLYNX_WORKSPACE_ROOT juggling: since Phase 5 the gateway's guard is the
  // only root a tool can see, so this suite exercises corruption paths directly.
  const tempRoots: string[] = [];

  try {
    // ── Test 1: line endings survive a surgical patch ─────────────────────────
    {
      const crlf = "line1\r\nfunction f() {\r\n  return 1;\r\n}\r\n";
      const patched = applySurgicalPatch(crlf, "  return 1;", "  return 2;");
      const crlfCount = (s: string) => (s.match(/\r\n/g) || []).length;

      assert.equal(detectEol(crlf), "\r\n", "detectEol missed a pure CRLF file");
      assert.equal(
        crlfCount(patched.patchedContent),
        crlfCount(crlf),
        `patching a CRLF file changed its line endings (${crlfCount(crlf)} → ${crlfCount(patched.patchedContent)})`
      );
      assert.ok(
        patched.patchedContent.includes("return 2;"),
        "patch was not applied while preserving line endings"
      );

      const lf = "a\nb\nc\n";
      assert.equal(detectEol(lf), "\n", "detectEol mislabelled an LF file");
      const lfPatched = applySurgicalPatch(lf, "b", "BB");
      assert.ok(!lfPatched.patchedContent.includes("\r"), "patching an LF file introduced CR characters");

      // A CRLF-dominant file with one stray LF line still reads as CRLF.
      assert.equal(detectEol("a\r\nb\r\nc\nd\r\n"), "\r\n", "mixed file should resolve to dominant CRLF");
      console.log("✓ Test 1 Passed: CRLF and LF files both keep their own line endings through a patch.");
    }

    // ── Test 2: write_file over a CRLF file keeps CRLF ────────────────────────
    {
      const target = path.join(tmpDir, "crlf-write.txt");
      fs.writeFileSync(target, "first\r\nsecond\r\n", "utf-8");

      const tx = new EditTransactionManager(tmpDir);
      tx.stageFileWrite("crlf-write.txt", "first\nSECOND changed\n");
      tx.commit();

      const written = fs.readFileSync(target, "utf-8");
      assert.ok(written.includes("\r\n"), "overwriting a CRLF file flattened it to LF");
      // A "lone LF" is a \n not preceded by \r — its presence means mixed endings.
      assert.ok(!/(?<!\r)\n/.test(written), "mixed line endings produced");
      assert.ok(written.includes("SECOND changed"), "content change lost while preserving endings");
      assert.equal(written, "first\r\nSECOND changed\r\n", "unexpected write_file result");

      // A brand-new file has no prior convention and should stay LF.
      const fresh = new EditTransactionManager(tmpDir);
      fresh.stageFileWrite("brand-new.txt", "one\ntwo\n");
      fresh.commit();
      assert.ok(!fs.readFileSync(path.join(tmpDir, "brand-new.txt"), "utf-8").includes("\r"), "new file should be LF");
      console.log("✓ Test 2 Passed: write_file preserves an existing file's endings; new files stay LF.");
    }

    // ── Test 3: oversized tool output is capped, head+tail preserved ──────────
    {
      const bigFile = path.join(tmpDir, "big.ts");
      const header = "export const FIRST_MARKER = true;\n";
      const footer = "export const LAST_MARKER = true;\n";
      // Few lines, many characters: this isolates the *character* cap from
      // `read_file`'s line window, which is a separate protection (Test 3b).
      const filler = "const padding = '" + "x".repeat(20_000) + "';\n";
      fs.writeFileSync(bigFile, header + filler.repeat(12) + footer, "utf-8");

      const gateway = new ToolExecutionGateway(tmpDir);
      const registry = new ToolRegistry(CORE_TOOLS);
      const result = await gateway.executeGuarded(
        registry,
        { id: "cap_1", name: "read_file", args: { path: "big.ts" } },
        { activeMode: "agent", sessionId: "cap-session" }
      );

      assert.ok(!result.isError, `read_file failed: ${result.output.slice(0, 200)}`);
      assert.equal(result.truncated, true, "oversized result was not marked truncated");
      assert.ok(
        result.output.length < DEFAULT_MAX_TOOL_OUTPUT_CHARS + 1_000,
        `capped output still too large (${result.output.length} chars vs ${DEFAULT_MAX_TOOL_OUTPUT_CHARS} cap)`
      );
      assert.ok(result.output.includes("FIRST_MARKER"), "head was not preserved by the cap");
      assert.ok(result.output.includes("LAST_MARKER"), "tail was not preserved by the cap");
      assert.ok(/truncated this tool result/i.test(result.output), "no model-readable truncation marker");

      // ── Test 3b: a long file is *windowed by line*, and the window is announced ──
      // Silent truncation is how an agent confidently edits code it never saw, so
      // the contract is "cut, and tell the model exactly how to get the rest".
      const tallFile = path.join(tmpDir, "tall.ts");
      fs.writeFileSync(
        tallFile,
        "export const FIRST_MARKER = true;\n" + "const padding = 'x';\n".repeat(12_000) + "export const LAST_MARKER = true;\n",
        "utf-8"
      );
      gateway.beginToolTurn();
      const windowed = await gateway.executeGuarded(
        registry,
        { id: "cap_3", name: "read_file", args: { path: "tall.ts" } },
        { activeMode: "agent", sessionId: "cap-session" }
      );
      assert.ok(!windowed.isError, `windowed read failed: ${windowed.output.slice(0, 200)}`);
      assert.ok(windowed.output.includes("FIRST_MARKER"), "the window lost the top of the file");
      assert.ok(!windowed.output.includes("LAST_MARKER"), "the window returned the whole file anyway");
      assert.ok(
        /more line\(s\) not shown/.test(windowed.output) && windowed.output.includes("start_line=1001"),
        `no continuation instruction in the footer: ${windowed.output.slice(-260)}`
      );
      const statedTotal = windowed.output.match(/([\d,]+) lines in total/)?.[1];
      assert.ok(
        statedTotal && Number(statedTotal.replace(/,/g, "")) >= 12_000,
        `the footer does not state the real file length: ${windowed.output.slice(-200)}`
      );

      // And the advertised arguments actually work.
      gateway.beginToolTurn();
      const tailWindow = await gateway.executeGuarded(
        registry,
        { id: "cap_4", name: "read_file", args: { path: "tall.ts", start_line: 12_001, end_line: 12_003 } },
        { activeMode: "agent", sessionId: "cap-session" }
      );
      assert.ok(tailWindow.output.includes("LAST_MARKER"), "the advertised window did not reach the tail");
      assert.ok(!tailWindow.output.includes("not shown"), "an explicit range was windowed anyway");

      // Small results must pass through untouched.
      const small = await gateway.executeGuarded(
        registry,
        { id: "cap_2", name: "read_file", args: { path: "brand-new.txt" } },
        { activeMode: "agent", sessionId: "cap-session" }
      );
      assert.notEqual(small.truncated, true, "small result was needlessly truncated");

      const untouched = capToolOutput({
        toolCallId: "x",
        toolName: "y",
        output: "short",
        durationMs: 1,
      });
      assert.equal(untouched.output, "short", "capToolOutput altered a short result");
      console.log(
        `✓ Test 3 Passed: ${(header.length + filler.length * 12 + footer.length).toLocaleString()}-char read capped to ` +
        `${result.output.length.toLocaleString()} chars with head+tail and an explicit marker; ` +
        `a 12,002-line file is windowed with a continuation footer.`
      );
    }

    // ── Test 3c: a repeated read within one turn is a pointer, not a payload ───
    {
      const gateway = new ToolExecutionGateway(tmpDir);
      const registry = new ToolRegistry(CORE_TOOLS);
      fs.writeFileSync(
        path.join(tmpDir, "big-read.ts"),
        "const padding = 'x';\n".repeat(2_000),
        "utf-8"
      );
      const call = (id: string, args: Record<string, unknown>) =>
        gateway.executeGuarded(
          registry,
          { id, name: "read_file", args },
          { activeMode: "agent", sessionId: "dedupe-session" }
        );

      gateway.beginToolTurn();
      const first = await call("d_1", { path: "big-read.ts" });
      const repeat = await call("d_2", { path: "big-read.ts" });
      const different = await call("d_3", { path: "tall.ts" });

      assert.notEqual(first.cached, true, "the first read was served from the cache");
      assert.equal(repeat.cached, true, "an identical read in the same turn re-executed");
      assert.ok(
        repeat.output.length < first.output.length / 4 && repeat.output.includes("[cached]"),
        `cached result is not a short pointer: ${repeat.output.slice(0, 160)}`
      );
      assert.ok(repeat.output.includes("force_refresh"), "the pointer offers no way out");
      assert.notEqual(different.cached, true, "a different path was served from the same cache key");

      // The pointer must never be a *pessimization*: for a small result it would
      // cost more characters than it saves.
      const smallFirst = await call("d_7", { path: "brand-new.txt" });
      const smallRepeat = await call("d_8", { path: "brand-new.txt" });
      assert.notEqual(
        smallRepeat.cached, true,
        `deduplicated a ${smallFirst.output.length}-char result where the pointer is longer`
      );

      // A write must invalidate every remembered read, or a later read could be
      // answered from the pre-edit snapshot — the one failure mode that would let
      // the agent corrupt a file while believing it had just read it.
      await gateway.executeGuarded(
        registry,
        { id: "d_4", name: "write_file", args: { path: "big-read.ts", content: "one\ntwo\nthree\n" } },
        { activeMode: "agent", sessionId: "dedupe-session" }
      );
      const afterWrite = await call("d_5", { path: "big-read.ts" });
      assert.notEqual(afterWrite.cached, true, "a read after a write was served from cache");
      assert.ok(afterWrite.output.includes("three"), "the read after the write did not see the change");

      gateway.beginToolTurn();
      const boundary = await call("d_9", { path: "tall.ts" });
      await call("d_10", { path: "tall.ts" });
      assert.notEqual(
        boundary.cached, true,
        "a new turn reused the previous turn's cache — eviction may have dropped the original"
      );
      assert.equal(gateway.cachedToolCalls, 1, "beginToolTurn did not start from an empty cache");
      console.log(
        "✓ Test 3c Passed: large repeat reads dedupe to a pointer within a turn, small ones stay " +
        "verbatim, and a write or a new turn invalidates them."
      );
    }

    // ── Test 4: the model sees raw identifiers; egress still gets redaction ───
    {
      const sourceFile = path.join(tmpDir, "auth.ts");
      const identifier = "handle_user_authentication_flow";
      const secret = "sk-or-v1-abcdefghijklmnopqrstuvwx";
      fs.writeFileSync(
        sourceFile,
        `export function ${identifier}() {\n  const key = "${secret}";\n  return key;\n}\n`,
        "utf-8"
      );

      const store = new LocalJsonSessionStore(tmpDir);
      const registry = new ToolRegistry(CORE_TOOLS);
      const eventBus = new AgentEventBus();

      // Block bodies, not expression bodies: `push()` returns a number and the
      // listener contract is `void | Promise<void>`.
      const outputEvents: Array<{ outputSnippet?: string }> = [];
      eventBus.on<{ outputSnippet?: string }>("tool.output", (evt) => {
        outputEvents.push(evt.payload);
      });

      const textDeltas: string[] = [];
      eventBus.on<{ text?: string }>("model.text_delta", (evt) => {
        textDeltas.push(evt.payload?.text || "");
      });

      // Workspace packages resolve `@inflynx/*` to their built `dist/*.d.ts`,
      // while every suite in this folder imports from `src` so it can run without
      // a build step. TypeScript then sees two nominally distinct-but-structurally
      // identical types for the same class. Re-deriving the parameter types from
      // `start` itself keeps this honest instead of reaching for `any`.
      type StartArgs = Parameters<typeof AgentOrchestrator.start>;

      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot: tmpDir,
          providerId: "openai",
          model: "gpt-4o",
          apiKey: "mock_key",
          activeMode: "agent",
          modelAdapter: "openai-chat",
        },
        registry as unknown as StartArgs[1],
        eventBus as unknown as StartArgs[2],
        async () => true,
        "low",
        store as unknown as StartArgs[5]
      );

      const requestBodies: string[] = [];
      const queue = stubFetchRecording(requestBodies);
      queue.push(() => toolCallResponse("read_file", { path: "auth.ts" }));
      queue.push(() => finalTextResponse(`The function is named ${identifier}.`));

      const result = await orchestrator.runTurn("read auth.ts and tell me the function name");

      assert.equal(requestBodies.length, 2, "expected exactly two provider calls in this turn");

      // ── The second request is what the model actually read. ──
      const secondPayload = JSON.parse(requestBodies[1]);
      const toolMessage = (secondPayload.messages as Array<{ role: string; content?: string }>).find(
        (m) => m.role === "tool"
      );
      assert.ok(toolMessage, "no tool message reached the model");
      assert.ok(
        toolMessage!.content!.includes(identifier),
        `model received a corrupted identifier — the redaction bug is back (${toolMessage!.content!.slice(0, 160)})`
      );
      assert.ok(
        !toolMessage!.content!.includes("[REDACTED"),
        "redaction leaked into the model's own context"
      );

      // ── Egress must STILL be redacted. ──
      assert.equal(outputEvents.length, 1, "expected one tool.output event");
      assert.ok(
        outputEvents[0].outputSnippet!.includes("[REDACTED_API_KEY]"),
        "event stream stopped redacting the secret"
      );
      assert.ok(
        !outputEvents[0].outputSnippet!.includes(secret),
        "raw secret was emitted onto the event stream"
      );

      const { finalText } = result;
      assert.ok(finalText.includes(identifier), "returned finalText lost the raw identifier");
      assert.ok(!finalText.includes(secret), "returned finalText leaked the raw secret to the caller");

      const hydration = await store.getSessionHydration(orchestrator.sessionId);
      const persistedToolMsg = hydration!.messages.find((m) => m.role === "tool");
      assert.ok(
        persistedToolMsg!.content!.includes(identifier),
        "persisted copy lost the identifier (over-redaction of harmless text)"
      );
      assert.ok(
        !persistedToolMsg!.content!.includes(secret),
        "persisted copy stored the raw secret"
      );
      assert.ok(
        textDeltas.join("").includes("function is named") || textDeltas.length > 0,
        "no streamed deltas were emitted"
      );

      console.log(
        "✓ Test 4 Passed: model context keeps raw file content, while events, return value and the " +
        "stored transcript are all redacted."
      );
    }

    // ── Test 5: redaction is precise — catches credentials, spares code ───────
    {
      const mustRedact: Array<[string, string]> = [
        ["openrouter key sk-or-v1-abcdefghijklmnopqrstuvwx", "vendor prefix"],
        ["anthropic sk-ant-ABCDEFGHIJKLMNOP1234", "anthropic prefix"],
        ["github token ghp_16C7eRYP2EASKfPMEGOXEOj5J3nIKh1LkGpL", "github prefix"],
        ['{"apiKey": "abcdefghij123456"}', "assigned apiKey"],
        ["OPENROUTER_API_KEY=SuperSecretValue123", "env assignment"],
        ["client_secret: 'a1b2c3d4e5f6'", "assigned client secret"],
        ["password = 'hunter2hunter2'", "assigned password"],
        ["https://api.example.com?api_key=ZZZZzzzz9999", "query credential"],
        ["Authorization: Bearer abcdefghijklmnopQRSTUV", "bearer header"],
      ];
      for (const [input, label] of mustRedact) {
        const out = redactSecrets(input);
        assert.notEqual(out, input, `credential escaped redaction (${label}): ${input}`);
        assert.ok(/REDACTED/.test(out), `redaction produced no marker (${label})`);
      }

      const mustPreserve: string[] = [
        "export function handle_user_authentication_flow() { return true; }",
        "const DEFAULT_EFFORT_PROFILES = { low: 1, medium: 2 };",
        "Call validate_custom_model_endpoint_for_use before resolving credentials.",
        "SELECT id, name FROM user_account_preferences WHERE id = 42;",
        "max_retry_attempt_count and the user_session_expiry_window matter here.",
        "The billing_service_module exports calculate_invoice_amount.",
      ];
      for (const input of mustPreserve) {
        assert.equal(redactSecrets(input), input, `ordinary code/prose was mangled: ${input}`);
      }
      console.log(
        `✓ Test 5 Passed: ${mustRedact.length} credential shapes redacted, ` +
        `${mustPreserve.length} identifier/prose strings left byte-identical.`
      );
    }

    // ── Test 6: one root per session — the two-root (H1) regression guard ─────
    {
      // Root A is the session workspace; root B is a *different* project. Neither
      // is process.cwd(), which is exactly the situation an apps/server handling
      // two workspaces (or any CLI run from elsewhere) used to be in.
      const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-rootA-"));
      const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-rootB-"));
      tempRoots.push(rootA, rootB);
      fs.writeFileSync(path.join(rootA, "inside-a.txt"), "content owned by session A\n", "utf-8");
      fs.writeFileSync(path.join(rootB, "inside-b.txt"), "content owned by session B\n", "utf-8");

      const gatewayA = new ToolExecutionGateway(rootA);
      const registryA = new ToolRegistry(CORE_TOOLS);
      const opts = { activeMode: "agent" as const, sessionId: "multi-root" };

      // (a) A relative path must resolve against the SESSION root, not cwd.
      //     Pre-Phase-5 this resolved against process.cwd() and failed or read the
      //     wrong file — the gateway had already approved it.
      const own = await gatewayA.executeGuarded(
        registryA,
        { id: "root_1", name: "read_file", args: { path: "inside-a.txt" } },
        opts
      );
      assert.ok(!own.isError, `session-rooted relative read failed: ${own.output.slice(0, 160)}`);
      assert.ok(own.output.includes("content owned by session A"), "read returned the wrong file");

      // (b) An absolute path into another workspace must be refused outright.
      const escape = await gatewayA.executeGuarded(
        registryA,
        { id: "root_2", name: "read_file", args: { path: path.join(rootB, "inside-b.txt") } },
        opts
      );
      assert.equal(escape.isError, true, "cross-workspace read was allowed!");
      assert.match(escape.output, /Security Policy Violation|outside allowed workspace/);
      assert.ok(!escape.output.includes("content owned by session B"), "leaked another workspace's bytes");

      // (c) Writing into another workspace is refused too.
      const escapeWrite = await gatewayA.executeGuarded(
        registryA,
        { id: "root_3", name: "write_file", args: { path: path.join(rootB, "planted.txt"), content: "x" } },
        opts
      );
      assert.equal(escapeWrite.isError, true, "cross-workspace write was allowed!");
      assert.ok(!fs.existsSync(path.join(rootB, "planted.txt")), "planted a file in another workspace");

      // (d) `..` traversal out of the session root is refused.
      const traversal = await gatewayA.executeGuarded(
        registryA,
        { id: "root_4", name: "read_file", args: { path: "../outside.txt" } },
        opts
      );
      assert.equal(traversal.isError, true, "parent traversal was allowed!");

      // (e) The env side-channel must be gone for good.
      assert.equal(
        (globalThis as any).process.env.INFLYNX_WORKSPACE_ROOT,
        undefined,
        "INFLYNX_WORKSPACE_ROOT is back — the second root has returned"
      );

      console.log(
        "✓ Test 6 Passed: tools resolve only against the session root; other workspaces and `..` escapes refused."
      );
    }

    console.log("\n🎉 All Phase 4 & 5 Data-Integrity Tests Passed 100%!");
  } finally {
    (globalThis as any).fetch = originalFetch;
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runDataIntegrityTests().catch((err) => {
  console.error("Data-integrity test failed:", err);
  process.exit(1);
});

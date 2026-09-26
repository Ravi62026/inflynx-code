/**
 * Backlog Phase 43 — real MCP transports, and the trust model around them.
 *
 * I1 was that the "SSE" transport never spoke MCP: it registered one fabricated
 * `mcp__<id>__fetch` tool that did `GET ?query=`. So every assertion here goes through a
 * **real server** — a real stdio child speaking JSON-RPC, and real `node:http` listeners
 * for both HTTP wire styles — and checks the bytes on the wire, not that a function was
 * called. A mock of my own client would prove nothing about whether it can talk to
 * somebody else's server, which is the entire feature.
 *
 * $HOME is redirected for the whole run: the trust store lives in `~/.inflynx`, and a
 * test that grants trust there would leave a real grant behind on this machine.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs";
import http from "node:http";
import os from "os";
import path from "path";
import { McpClientManager, renderMcpCallResult, MCP_TIMEOUTS } from "../../packages/mcp-runtime/src/index.js";
import { ToolRegistry } from "../../packages/tool-runtime/src/index.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "../../packages/tool-runtime/src/index.js";
import {
  computeMcpTrustId,
  isMcpServerTrusted,
  trustMcpServer,
  type ResolvedMcpServer,
} from "../../packages/config/src/mcp-config.js";

/**
 * Every manager here spawns a real child process. The suite hung the first time it ran
 * because nothing reaped them: tests passed, assertions were green, and the process just
 * would not exit. Product code gets this right via `mcpManager.disconnectAll()` on CLI
 * exit; a test that creates a manager must dispose of it the same way.
 */
const managers: McpClientManager[] = [];
function newManager(options?: ConstructorParameters<typeof McpClientManager>[0]): McpClientManager {
  const m = new McpClientManager(options ?? {});
  managers.push(m);
  return m;
}

const realHome = process.env.HOME;
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-mcp-home-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-mcp-fixtures-"));

/** Loopback is exactly what the SSRF guard must refuse; tests opt in through a seam. */
const allowLoopback = async (raw: string) => new URL(raw);

// ─── stdio fixture ────────────────────────────────────────────────────────────

const STDIO_SERVER = `
import fs from "fs";
import readline from "readline";

const mode = process.env.FIXTURE_MODE || "normal";
const log = (m) => process.stderr.write("fixture: " + m + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const result = (id, r) => send({ jsonrpc: "2.0", id, result: r });
let initialized = false;

const TOOLS = [
  { name: "echo", description: "echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "sleepy", description: "takes a while", inputSchema: { type: "object" } },
];

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === "notifications/initialized") {
    initialized = true;
    if (process.env.HANDSHAKE_FILE) fs.writeFileSync(process.env.HANDSHAKE_FILE, "initialized");
    return;                       // notifications get no reply
  }
  if (method === "initialize") {
    if (mode === "never-answers") return;
    result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} },
                 serverInfo: { name: "fixture-server", version: "9.9.9" } });
    return;
  }
  if (method === "tools/list") {
    // A spec-compliant server waits for the initialized notification. If the client never
    // sends it (backlog I2), this hangs and the test fails for the real reason.
    if (!initialized && mode !== "no-init-required") {
      log("tools/list arrived before notifications/initialized — refusing");
      return;
    }
    if (mode === "no-tools") { result(id, { tools: [] }); return; }
    result(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    if (params.name === "sleepy") await new Promise((r) => setTimeout(r, 1500));
    if (params.name === "echo") {
      result(id, { content: [
        { type: "text", text: "echo:" + (params.arguments?.text || "") },
        { type: "image", mimeType: "image/png", data: "AAH" + "y".repeat(40000) },
        { type: "resource", resource: { uri: "file:///tmp/x.txt", mimeType: "text/plain", text: "hidden" } },
      ] });
      return;
    }
    result(id, { content: [{ type: "text", text: "slept" }] });
    return;
  }
  if (typeof id === "number") result(id, {});
});

if (mode === "die-after-list") {
  setTimeout(() => { log("deliberate crash"); process.exit(7); }, 700);
}
`;

let stdioServerPath: string;
let handshakeFile: string;

function spawnConfig(extra: Record<string, unknown> = {}): ResolvedMcpServer {
  const base = {
    id: "fixture",
    name: "fixture",
    transport: "stdio" as const,
    command: "node",
    args: [stdioServerPath],
    source: "user" as const,
    disabled: false,
    ...extra,
  };
  return { ...base, trustId: computeMcpTrustId(base) } as ResolvedMcpServer;
}

// ─── HTTP fixtures ────────────────────────────────────────────────────────────

interface HttpFixture {
  server: http.Server;
  url: string;
  port: number;
  seen: { methods: string[]; sessionIds: (string | null)[]; notifications: string[]; requests: number };
  close(): Promise<void>;
}

/** streamable-http: POST answers inline; JSON for list, SSE frames for a call. */
async function startStreamableServer(): Promise<HttpFixture> {
  const seen: HttpFixture["seen"] = { methods: [], sessionIds: [], notifications: [], requests: 0 };
  let issuedSession = "sess-42";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.requests++;
      seen.sessionIds.push(req.headers["mcp-session-id"] as string | undefined ?? null);
      const msg = JSON.parse(body || "{}");
      if (msg.method) seen.methods.push(msg.method);
      if (msg.method?.startsWith("notifications/")) seen.notifications.push(msg.method);

      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": issuedSession });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "streamable-fixture", version: "1.2.3" } } }));
        return;
      }
      if (!msg.method?.startsWith("notifications/") && msg.id === undefined) {
        res.writeHead(400).end(); return;
      }
      if (msg.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "remote_tool", description: "d", inputSchema: { type: "object" } }] } }));
        return;
      }
      if (msg.method === "tools/call") {
        // Answer as an SSE stream, which is the other half of the streamable contract.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "remote said hi" }] } })}\n\n`);
        // Then keep the stream open with junk: a client that waits for EOF would hang.
        res.write(`event: ping\ndata: {}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { server, port, url: `http://127.0.0.1:${port}/mcp`, seen, close: () => closeServer(server) };
}

/** legacy HTTP+SSE: GET opens a stream that names a POST endpoint; answers arrive on it. */
async function startLegacyServer(opts: { requireInitialized?: boolean } = {}): Promise<HttpFixture> {
  const seen: HttpFixture["seen"] = { methods: [], sessionIds: [], notifications: [], requests: 0 };
  let push: (frame: string) => void = () => {};
  const server = http.createServer((req, res) => {
    seen.requests++;
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const ready = setTimeout(() => res.write(`event: endpoint\ndata: /messages?sid=abc\n\n`), 20);
      push = (frame) => { try { res.write(`event: message\ndata: ${frame}\n\n`); } catch { /* gone */ } };
      req.on("close", () => { clearTimeout(ready); push = () => {}; });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        if (msg.method) seen.methods.push(msg.method);
        if (msg.method?.startsWith("notifications/")) seen.notifications.push(msg.method);
        res.writeHead(202).end();   // the answer goes on the stream, not here
        if (msg.method === "initialize") {
          push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
            protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy-fixture", version: "0.1" } } }));
        } else if (msg.method === "tools/list") {
          push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "legacy_tool", inputSchema: { type: "object" } }] } }));
        } else if (msg.method === "tools/call") {
          push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "legacy call ok" }] } }));
        }
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { server, port, url: `http://127.0.0.1:${port}/sse`, seen, close: () => { push = () => {}; return closeServer(server); } };
}

/**
 * `server.close()` waits for open connections, and a legacy SSE GET stream is open by
 * design. Closing without dropping those connections hangs the suite forever — which is
 * what this harness did the first time it ran.
 */
function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    (server as any).closeAllConnections?.();
    server.close(() => resolve());
  });
}

function urlConfig(fixture: HttpFixture, transport: "sse" | "streamable-http", extra: Record<string, unknown> = {}): ResolvedMcpServer {
  const base = {
    id: `srv-${transport}`, name: `srv-${transport}`, transport, url: fixture.url,
    source: "user" as const, disabled: false, ...extra,
  };
  return { ...base, trustId: computeMcpTrustId(base) } as ResolvedMcpServer;
}

/** Connect one server through the same gated path `connectAll` uses. */
async function connectOne(manager: McpClientManager, config: ResolvedMcpServer) {
  const list = await manager.connectConfigs([config]);
  return list[0];
}

async function runMcpTransportTests(): Promise<void> {
  console.log("🧪 Running Phase 43 MCP Transport Tests...\n");

  stdioServerPath = path.join(workDir, "stdio-fixture.mjs");
  handshakeFile = path.join(workDir, "handshake.flag");
  fs.writeFileSync(stdioServerPath, STDIO_SERVER, "utf-8");

  try {
    process.env.HOME = sandboxHome;
    (os as any).homedir = () => sandboxHome;

    // ── Test 1: a real stdio handshake, including `notifications/initialized` ──
    {
      const registry = new ToolRegistry([]) as never;
      const manager = newManager();
      // The child gets a minimal allowlisted environment, so the fixture is steered
      // through the config env (which is what a real server would use) rather than the
      // host environment — this test failed the first time for exactly that reason.
      const config = spawnConfig({ env: { FIXTURE_MODE: "normal", HANDSHAKE_FILE: handshakeFile } });
      trustMcpServer(config, "test grant");
      fs.writeFileSync(handshakeFile, "");

      const list = await manager.connectConfigs([config]);
      const server = list[0];
      assert.equal(server.status, "connected", `stdio handshake failed: ${server.error}`);
      assert.equal(server.wire, "stdio");
      assert.equal(server.serverInfo?.name, "fixture-server", "initialize result was discarded");
      assert.equal(fs.readFileSync(handshakeFile, "utf-8"), "initialized",
        "the server never saw notifications/initialized (backlog I2)");

      manager.registerToolsInto(registry as never);
      const names = (registry as never as ToolRegistry).list().map((t) => t.name).sort();
      assert.deepEqual(names, ["mcp__fixture__echo", "mcp__fixture__sleepy"], `tools from the server, not from config: ${names}`);
      assert.ok(!names.includes("mcp__fixture__fetch"),
        "the fabricated `fetch` tool from the old SSE mock is still being registered");
      assert.ok(!names.some((n) => n.includes("__fetch")), "some mock tool is still registered");
      console.log("✓ Test 1 Passed: stdio speaks real JSON-RPC, sends initialized, lists the server's tools.");
    }

    // ── Test 2: tools/call over stdio, and content that is not text ───────────
    {
      const registry = new ToolRegistry([]);
      const manager = newManager();
      const cfg2 = spawnConfig({ env: { FIXTURE_MODE: "normal" } });
      trustMcpServer(cfg2, "test grant");
      const server = (await manager.connectConfigs([cfg2]))[0];
      assert.equal(server.status, "connected", server.error);
      for (const t of server.tools) registry.register(t as never);

      const echo = registry.get("mcp__fixture__echo")!;
      const out = await echo.execute({ text: "hello" } as any, {} as any);
      const text = typeof out === "string" ? out : (out as any).output;
      assert.match(text, /echo:hello/, "the tool result was lost");
      assert.match(text, /\[image from fixture\/echo: image\/png/, "an image block was not described");
      assert.ok(!text.includes("AAHyyy"), "base64 image bytes were injected into the model's context (backlog I4)");
      assert.match(text, /\[resource from fixture\/echo: file:\/\/\/tmp\/x\.txt\]/, "a resource block was not reduced to its uri");
      assert.ok(!text.includes("hidden"), "resource payload leaked instead of a reference");
      console.log("✓ Test 2 Passed: call round-trips; images and resources become described references.");
    }

    // ── Test 3: result capping is announced, not silent ───────────────────────
    {
      const big = "z".repeat(DEFAULT_MAX_TOOL_OUTPUT_CHARS + 500);
      const capped = renderMcpCallResult("s", "t", { content: [{ type: "text", text: big }] });
      assert.ok(capped.length < big.length, "a huge result was passed through uncapped (backlog I4)");
      assert.match(capped, /omitted|truncated/i, "the cap was applied silently");
      assert.match(capped, /budget|characters/, "the truncation notice does not state the limit");

      const multi = renderMcpCallResult("s", "t", { content: [
        { type: "text", text: "a".repeat(1_000) },
        { type: "unknown_kind", blob: "x" },
      ]});
      assert.match(multi, /\[unknown_kind content from s\/t\]/, "an unrecognised content type vanished");
      assert.ok(multi.startsWith("a"), "the block order in a result was not preserved");
      console.log("✓ Test 3 Passed: over-budget results say so; unknown content types are named, not dropped.");
    }

    // ── Test 4: a dead server is errored, unregistered, and explains itself ───
    {
      const registry = new ToolRegistry([]);
      const manager = newManager();
      const dead = spawnConfig({ env: { FIXTURE_MODE: "die-after-list" } });
      trustMcpServer(dead, "test grant");
      const server = (await manager.connectConfigs([dead]))[0];
      assert.equal(server.status, "connected", server.error);
      manager.registerToolsInto(registry as never);
      assert.equal(registry.list().length, 2, "fixture tools were not registered");

      await new Promise((r) => setTimeout(r, 1500));   // the fixture exits at +700ms

      assert.equal(server.status, "error", "a dead server still reports itself connected (backlog I3)");
      assert.match(server.error || "", /code 7/, `exit code not reported: ${server.error}`);
      assert.match(server.error || "", /deliberate crash/, `stderr was discarded: ${server.error}`);
      assert.equal(registry.list().length, 0, "the dead server's tools are still offered to the model");
      console.log("✓ Test 4 Passed: exit → status error with code + stderr, and its tools are withdrawn.");
    }

    // ── Test 5: per-method timeouts, not one global 10 s ──────────────────────
    {
      assert.ok(MCP_TIMEOUTS.initialize <= 10_000, "the handshake budget grew");
      assert.ok(MCP_TIMEOUTS.call > MCP_TIMEOUTS.list, "a tool call is given less time than a listing");

      const manager = newManager();
      const slow = spawnConfig({ timeoutMs: 400, env: { FIXTURE_MODE: "normal" } });
      trustMcpServer(slow, "test grant");
      const server = (await manager.connectConfigs([slow]))[0];
      assert.equal(server.status, "connected", server.error);
      const sleepy = server.tools.find((t: { name: string }) => t.name === "mcp__fixture__sleepy")!;
      const started = Date.now();
      const out: any = await sleepy.execute({} as any, {} as any).catch((e: any) => ({ output: e.message, isError: true }));
      const took = Date.now() - started;
      assert.match(out.output || "", /did not answer within 0s|timeoutMs|400ms/i, `timeout not explained: ${out.output}`);
      assert.ok(took < 2_000, `the per-server override was ignored — waited ${took}ms`);
      console.log(`✓ Test 5 Passed: tools/call honours timeoutMs (${took}ms to refuse a 1.5s tool at 400ms).`);
    }

    // ── Test 6: streamable-http, session id echoed, SSE answer for a call ─────
    {
      const fixture = await startStreamableServer();
      try {
        const manager = newManager({ validateUrl: allowLoopback });
        const server = (await manager.connectConfigs([urlConfig(fixture, "streamable-http")]))[0];
        assert.equal(server.status, "connected", `streamable-http failed: ${server.error}`);
        assert.equal(server.wire, "streamable-http");
        assert.equal(server.serverInfo?.name, "streamable-fixture");
        assert.deepEqual(server.tools.map((t: { name: string }) => t.name), ["mcp__srv-streamable-http__remote_tool"]);

        assert.ok(fixture.seen.methods.includes("initialize"), "server never saw initialize");
        assert.ok(fixture.seen.notifications.includes("notifications/initialized"),
          "no initialized notification over HTTP either");
        assert.equal(fixture.seen.sessionIds[0], null, "session id sent before the server issued one");
        assert.ok(fixture.seen.sessionIds.slice(1).every((s) => s === "sess-42"),
          `Mcp-Session-Id was not echoed back: ${JSON.stringify(fixture.seen.sessionIds)}`);

        const call = await server.tools[0].execute({} as any, {} as any);
        const text = (call as any).output;
        assert.match(text, /remote said hi/, "an SSE-framed tool answer was not parsed");
        console.log("✓ Test 6 Passed: streamable-http handshakes, echoes the session id, parses SSE answers.");
      } finally {
        await fixture.close();
      }
    }

    // ── Test 7: legacy HTTP+SSE — endpoint learned, answers on the stream ─────
    {
      const fixture = await startLegacyServer();
      try {
        const manager = newManager({ validateUrl: allowLoopback });
        const server = (await manager.connectConfigs([urlConfig(fixture, "sse")]))[0];
        assert.equal(server.status, "connected", `legacy SSE failed: ${server.error}`);
        assert.equal(server.wire, "sse");
        assert.deepEqual(server.tools.map((t: { name: string }) => t.name), ["mcp__srv-sse__legacy_tool"]);
        assert.ok(fixture.seen.methods.includes("initialize"), "legacy server never saw initialize");

        const call = await server.tools[0].execute({} as any, {} as any);
        assert.match((call as any).output, /legacy call ok/, "a response arriving on the GET stream was missed");
        assert.ok(!server.tools.some((t: { name: string }) => t.name.endsWith("__fetch")), "the old mock tool is back");
        console.log("✓ Test 7 Passed: legacy SSE learns the POST endpoint and reads answers off the stream.");
      } finally {
        await fixture.close();
      }
    }

    // ── Test 8: a wrong `transport` in config falls back instead of failing ───
    {
      const legacy = await startLegacyServer();
      try {
        const manager = newManager({ validateUrl: allowLoopback });
        const server = (await manager.connectConfigs([urlConfig(legacy, "streamable-http")]))[0];
        assert.equal(server.status, "connected",
          `a config that guesses the wrong wire style is unrecoverable: ${server.error}`);
        assert.equal(server.wire, "sse", "should have fallen back to the legacy channel");
        console.log("✓ Test 8 Passed: wrong transport in config negotiates down to the style that works.");
      } finally {
        await legacy.close();
      }
    }

    // ── Test 9: the SSRF guard is still the default (the seam is not a hole) ──
    {
      const local = await startStreamableServer();
      try {
        const manager = newManager();          // no validateUrl injected
        const server = (await manager.connectConfigs([urlConfig(local, "streamable-http")]))[0];
        assert.equal(server.status, "error", "a loopback MCP url was accepted by the default guard");
        assert.ok(/private|loopback|reserved|SSRF|refus/i.test(server.error || ""),
          `rejection was not explained: ${server.error}`);
        assert.equal(local.seen.requests, 0, "the guard let a request reach the server anyway");
        console.log("✓ Test 9 Passed: without the test seam, loopback urls are refused before any request.");
      } finally {
        await local.close();
      }
    }

    // ── Test 10: repo-authored mcp.json cannot run itself, even for a url ────
    {
      const remote = await startStreamableServer();
      try {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-poisoned-"));
        fs.mkdirSync(path.join(repo, ".inflynx"), { recursive: true });
        // The attack fixture: a poisoned skill writes a config pointing at a live server.
        fs.writeFileSync(path.join(repo, ".inflynx", "mcp.json"), JSON.stringify({
          mcpServers: { "helpful-analytics": { url: remote.url, transport: "streamable-http" } },
        }), "utf-8");

        const manager = newManager({ validateUrl: allowLoopback });
        const list = await manager.connectAll(repo);
        const attacker = list.find((s) => s.config.id === "helpful-analytics")!;
        assert.ok(attacker, "the repo config was not even loaded (so the test proves nothing)");
        assert.equal(attacker.status, "needs-trust", "a repository config connected without a human (backlog B6)");
        assert.equal(attacker.tools.length, 0, "untrusted tools were registered");
        assert.equal(remote.seen.requests, 0, "the server was contacted before it was trusted");

        // Trust it, then move the url: the grant must not survive an edited target.
        const trusted = { ...attacker.config };
        trustMcpServer(trusted, "granted in test");
        assert.equal(isMcpServerTrusted(trusted), true);
        const edited = { ...trusted, url: "http://127.0.0.1:9999/other", trustId: computeMcpTrustId({ ...trusted, url: "http://127.0.0.1:9999/other" }) };
        assert.equal(isMcpServerTrusted(edited), false,
          "trusting a URL also trusted every other URL under the same id");
        fs.rmSync(repo, { recursive: true, force: true });
        console.log("✓ Test 10 Passed: repo mcp.json waits for a human; editing its url revokes the grant.");
      } finally {
        await remote.close();
      }
    }

    // ── Test 11: a server with nothing to offer says so, rather than looking fine
    {
      const manager = newManager();
      const empty = spawnConfig({ id: "emptyfixture", env: { FIXTURE_MODE: "no-tools" } });
      trustMcpServer(empty, "test grant");
      const server = (await manager.connectConfigs([empty]))[0];
      assert.equal(server.status, "connected", server.error);
      assert.equal(server.tools.length, 0);
      assert.match(server.error || "", /no tools/i, "'connected, 0 tools' was reported as a clean success");
      console.log("✓ Test 11 Passed: an empty tool list is reported distinctly, not as a silent success.");
    }

    console.log("\n🎉 All Phase 43 MCP Transport Tests Passed 100%!");
  } finally {
    for (const m of managers) {
      try { m.disconnectAll(); } catch { /* already gone */ }
    }
    if (realHome !== undefined) process.env.HOME = realHome;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  }
}

runMcpTransportTests().catch((err) => {
  console.error("MCP transport test failed:", err);
  process.exit(1);
});

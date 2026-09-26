/**
 * Backlog B5 / B6 / B9 — MCP trust, environment, and approval tests.
 *
 * These three were one vulnerability, not three: a repository could define an MCP
 * server, the model could write that definition, and the runtime would spawn it with
 * a copy of every API key the CLI held, auto-approving any tool the server chose to
 * label `readOnlyHint`. Each layer of that is asserted independently here.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildMcpEnvironment,
  computeMcpTrustId,
  isMcpServerTrusted,
  listTrustedMcpServers,
  loadMcpConfig,
  revokeMcpServer,
  trustMcpServer,
  type ResolvedMcpServer,
} from "../../packages/config/src/mcp-config.js";
import { ApprovalProvider } from "../../packages/agent-core/src/orchestrator/ApprovalProvider.js";
import { ToolExecutionGateway } from "../../packages/tool-runtime/src/ToolExecutionGateway.js";
import { ToolRegistry, type ToolDefinition } from "../../packages/tool-runtime/src/index.js";
import { filterToolsForMode } from "../../packages/agent-core/src/index.js";

function resolved(over: Partial<ResolvedMcpServer>): ResolvedMcpServer {
  const base = {
    id: over.id || "srv",
    name: over.id || "srv",
    transport: over.transport || "stdio",
    command: over.command ?? "npx",
    args: over.args,
    env: over.env,
    envPassthrough: over.envPassthrough,
    url: over.url,
    disabled: false,
    source: over.source || "project",
  };
  return { ...base, trustId: computeMcpTrustId(base) } as ResolvedMcpServer;
}

async function runMcpTrustTests(): Promise<void> {
  console.log("🔐 Running B5/B6/B9 MCP Trust & Environment Tests...\n");

  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-mcp-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-mcp-ws-"));
  fs.writeFileSync(path.join(workspace, "package.json"), "{\n  \"name\": \"fixture\"\n}\n", "utf-8");
  const realHome = process.env.HOME;
  const realEnv = { ...process.env };

  try {
    // The trust store and user config are both under $HOME, so redirecting it keeps
    // this suite from writing into the developer's real configuration.
    process.env.HOME = sandboxHome;

    // ── Test 1: a subprocess gets a minimal environment, not the user's ────────
    {
      process.env.PATH = "/usr/bin:/bin";
      process.env.OPENAI_API_KEY = "sk-secret-from-the-shell";
      process.env.ANTHROPIC_API_KEY = "sk-ant-secret-from-the-shell";
      process.env.GITHUB_TOKEN = "ghp_secret_from_the_shell";
      process.env.AWS_SECRET_ACCESS_KEY = "notpassedthrough";
      process.env.MY_OWN_SERVER_TOKEN = "explicit-opt-in-value";

      const bare = buildMcpEnvironment({ id: "bare", transport: "stdio", command: "npx" });
      assert.equal(bare.PATH, "/usr/bin:/bin", "PATH is not part of the base environment");
      assert.equal(bare.HOME, sandboxHome, "HOME is not part of the base environment");
      assert.equal(bare.OPENAI_API_KEY, undefined, "an ambient API key leaked into a bare MCP env");
      assert.equal(bare.ANTHROPIC_API_KEY, undefined, "an ambient API key leaked into a bare MCP env");
      assert.equal(bare.GITHUB_TOKEN, undefined, "an ambient token leaked into a bare MCP env");
      assert.equal(bare.AWS_SECRET_ACCESS_KEY, undefined, "an ambient secret leaked into a bare MCP env");

      // Explicit opt-in by *name*, so the config file states what the server can see.
      const opted = buildMcpEnvironment({
        id: "opted",
        transport: "stdio",
        command: "npx",
        envPassthrough: ["MY_OWN_SERVER_TOKEN", "NOT_SET_ANYWHERE"],
      });
      assert.equal(opted.MY_OWN_SERVER_TOKEN, "explicit-opt-in-value", "declared passthrough was ignored");
      assert.equal(opted.NOT_SET_ANYWHERE, undefined, "a missing var became an empty string");
      assert.equal(opted.OPENAI_API_KEY, undefined, "one passthrough unlocked the whole environment");

      // Interpolation keeps the secret in the environment while making the exposure
      // a visible line in the config file.
      const interpolated = buildMcpEnvironment({
        id: "interp",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_PAT: "${GITHUB_TOKEN}", STATIC: "literal" },
      });
      assert.equal(interpolated.GITHUB_PAT, "ghp_secret_from_the_shell", "${VAR} was not expanded");
      assert.equal(interpolated.STATIC, "literal", "a literal env value was altered");
      assert.equal(interpolated.OPENROUTER_API_KEY, undefined, "interpolation leaked unrelated vars");

      // And interpolating an unset name must not fabricate a value the server might
      // misread as valid.
      const missing = buildMcpEnvironment({
        id: "missing",
        transport: "stdio",
        command: "npx",
        env: { TOKEN: "${DEFINITELY_NOT_SET_12345}" },
      });
      assert.equal(missing.TOKEN, "", "an unset ${VAR} became something else");
      console.log("✓ Test 1 Passed: MCP subprocesses see a base environment plus what the config declares.");
    }

    // ── Test 2: trust identity tracks the command, not the name ────────────────
    {
      const a = computeMcpTrustId({ id: "figma", transport: "stdio", command: "npx", args: ["-y", "figma-mcp"] });
      const same = computeMcpTrustId({ id: "figma", transport: "stdio", command: "npx", args: ["-y", "figma-mcp"] });
      const changedArgs = computeMcpTrustId({ id: "figma", transport: "stdio", command: "npx", args: ["-y", "evil-pkg"] });
      const changedExe = computeMcpTrustId({ id: "figma", transport: "stdio", command: "curl", args: ["-y", "figma-mcp"] });
      const otherId = computeMcpTrustId({ id: "other", transport: "stdio", command: "npx", args: ["-y", "figma-mcp"] });

      assert.equal(a, same, "trust id is not deterministic");
      assert.notEqual(a, changedArgs, "changing the package kept the same trust id");
      assert.notEqual(a, changedExe, "changing the executable kept the same trust id");
      assert.notEqual(a, otherId, "two servers share an id");

      // The point of hashing: an approved entry cannot be quietly re-pointed.
      const approved = resolved({ id: "figma", command: "npx", args: ["-y", "figma-mcp"] });
      trustMcpServer(approved, "unit test");
      assert.equal(isMcpServerTrusted(approved), true, "a trusted entry is not recognised");
      const edited = resolved({ id: "figma", command: "npx", args: ["-y", "evil-pkg"] });
      assert.equal(
        isMcpServerTrusted(edited), false,
        "editing the command of a trusted server kept it trusted"
      );
      console.log("✓ Test 2 Passed: trust is bound to the exact command line, so an edit invalidates it.");
    }

    // ── Test 3: repo content cannot grant itself permission ────────────────────
    {
      const userServer = resolved({ id: "mine", source: "user" });
      const repoServer = resolved({ id: "from-a-clone", source: "project" });

      assert.equal(isMcpServerTrusted(userServer), true, "the user's own config was treated as untrusted");
      assert.equal(
        isMcpServerTrusted(repoServer), false,
        "a repository-defined server was trusted without anyone saying so"
      );
      assert.ok(
        listTrustedMcpServers().every((e) => e.trustId !== repoServer.trustId),
        "an untrusted server ended up in the trust store anyway"
      );

      // Revoke must actually revoke, and report honestly when there was nothing to do.
      assert.equal(revokeMcpServer(userServer.trustId), false, "revoke claimed an entry that never existed");
      trustMcpServer(repoServer, "explicit yes");
      assert.equal(isMcpServerTrusted(repoServer), true, "trusting had no effect");
      assert.equal(revokeMcpServer(repoServer.trustId), true, "revoke failed on a trusted entry");
      assert.equal(isMcpServerTrusted(repoServer), false, "revoked entry is still trusted");
      console.log("✓ Test 3 Passed: user config is consent, repo config is not; revoke round-trips.");
    }

    // ── Test 4: config loading distinguishes sources and reports junk ──────────
    {
      fs.mkdirSync(path.join(workspace, ".inflynx"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, ".inflynx", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            good: { command: "npx", args: ["-y", "good-mcp"] },
            broken_no_command: {},
            sse_without_url: { transport: "sse" },
          },
        }),
        "utf-8"
      );
      fs.mkdirSync(path.join(sandboxHome, ".inflynx"), { recursive: true });
      fs.writeFileSync(path.join(sandboxHome, ".inflynx", "mcp.json"), "{ this is not valid json", "utf-8");

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      let loaded: ResolvedMcpServer[] = [];
      try {
        loaded = loadMcpConfig(workspace);
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(loaded.length, 1, `expected only the valid entry, got ${loaded.map((l) => l.id).join(", ")}`);
      assert.equal(loaded[0].id, "good");
      assert.equal(loaded[0].source, "project", "a repo config was attributed to the user");
      assert.ok(loaded[0].trustId, "loaded servers carry no trust identity");
      assert.ok(
        warnings.some((w) => /broken_no_command/.test(w)) && warnings.some((w) => /sse_without_url/.test(w)),
        `malformed entries were swallowed silently: ${warnings.join(" | ")}`
      );
      console.log("✓ Test 4 Passed: sources attributed correctly, malformed entries reported.");
    }

    // ── Test 5: a self-declared "readonly" buys nothing ────────────────────────
    {
      const approvalsAskedFor: string[] = [];
      const provider = new ApprovalProvider(async (req) => {
        approvalsAskedFor.push(req.toolName);
        return false;
      });

      assert.equal(
        await provider.requestApproval({
          toolName: "read_file", permissionLevel: "readonly", origin: "core", args: {},
        }),
        true,
        "a core read-only tool now needs approval — that would be a UX regression"
      );

      const mcpReadonly = await provider.requestApproval({
        toolName: "mcp__srv__get_issue", permissionLevel: "readonly", origin: "mcp", args: {},
      });
      assert.equal(mcpReadonly, false, "an MCP tool auto-approved on its own readOnlyHint");
      assert.deepEqual(approvalsAskedFor, ["mcp__srv__get_issue"], "the user was never consulted about the MCP tool");

      const pluginReadonly = await provider.requestApproval({
        toolName: "plugin_thing", permissionLevel: "readonly", origin: "plugin", args: {},
      });
      assert.equal(pluginReadonly, false, "a plugin tool auto-approved itself");

      // No handler wired at all must fail closed, not open.
      const strict = new ApprovalProvider();
      assert.equal(await strict.requestApproval({
        toolName: "mcp__srv__x", permissionLevel: "readonly", origin: "mcp", args: {},
      }), false, "an unattended approval defaulted to allow");
      console.log("✓ Test 5 Passed: readonly auto-approval is limited to core tools; defaults stay closed.");
    }

    // ── Test 6: [ask]/[plan] neither offer nor execute third-party code ────────
    {
      const mcpTool: ToolDefinition = {
        name: "mcp__github__create_issue",
        description: "create an issue",
        permissionLevel: "readonly",
        isMutating: false,
        origin: "mcp",
        serverName: "github",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => "SHOULD NEVER RUN",
      };
      const coreTool: ToolDefinition = {
        name: "read_file",
        description: "read",
        permissionLevel: "readonly",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => "content",
      };
      const registry = new ToolRegistry([coreTool, mcpTool]);

      for (const mode of ["ask", "plan"] as const) {
        const offered = filterToolsForMode(registry.list(), mode).map((t) => t.name);
        assert.ok(!offered.includes(mcpTool.name), `${mode} mode offered an MCP tool to the model`);
        assert.ok(offered.includes("read_file"), `${mode} mode stopped offering core reads — regression`);

        const result = await new ToolExecutionGateway(workspace).executeGuarded(
          registry,
          { id: "x", name: mcpTool.name, args: {} },
          { activeMode: mode, sessionId: "mcp-trust-test" }
        );
        assert.equal(result.isError, true, `${mode} mode executed the MCP tool`);
        assert.ok(/External tool/.test(result.output), `unexpected refusal text: ${result.output}`);
        assert.ok(result.output.includes(`[${mode}] mode`), `refusal does not name the mode: ${result.output}`);
        assert.ok(result.output.includes("MCP server \"github\""), "the refusal does not name the server");
      }

      // [agent] mode may run it — the point is scoping, not banning.
      const agentResult = await new ToolExecutionGateway(workspace).executeGuarded(
        registry,
        { id: "y", name: mcpTool.name, args: {} },
        { activeMode: "agent", sessionId: "mcp-trust-test" }
      );
      assert.equal(agentResult.output, "SHOULD NEVER RUN", `an allowed-in-agent MCP tool was blocked: ${agentResult.output}`);
      console.log("✓ Test 6 Passed: third-party tools are unoffered and unexecutable outside [agent]/[debug].");
    }
  } finally {
    process.env.HOME = realHome;
    for (const key of Object.keys(process.env)) if (!(key in realEnv)) delete process.env[key];
    Object.assign(process.env, realEnv);
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  console.log("\n🎉 All B5/B6/B9 MCP Trust Tests Passed 100%!");
}

runMcpTrustTests().catch((err) => {
  console.error("MCP trust test failed:", err);
  process.exit(1);
});

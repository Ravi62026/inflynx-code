/**
 * @inflynx/config — MCP server configuration, trust, and process environment.
 *
 * One home for the whole MCP-config story, because the three parts of it are one
 * security story and must not be reasoned about separately:
 *
 *   1. *Where* a server definition came from (user-level vs project-level).
 *   2. *Whether* the user has agreed to run it at all.
 *   3. *What it inherits* when it is spawned.
 *
 * The hole this closes (backlog B5/B6): a project's `.inflynx/mcp.json` is repo
 * content. Cloning a repository, or letting the model `write_file` that config as
 * part of a `/mcp add` flow, used to be enough to get an arbitrary command executed
 * on the next start — with a copy of `process.env`, which is every API key the CLI
 * holds. Untrusted-by-default repo content + ambient credentials = remote code
 * execution with the user's wallet.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { findWorkspaceRoot } from "./workspace-root.js";

export interface McpServerConfig {
  id: string;
  name?: string;
  /**
   * `sse` is the legacy HTTP+SSE transport (GET the stream, learn a POST endpoint).
   * `streamable-http` is the current one (POST JSON-RPC, response as JSON or SSE).
   * Both are tried for a url server when unspecified, because servers in the wild
   * are mixed and a wrong guess should be a fallback rather than a failure.
   */
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Names of variables to copy from the real environment *in addition* to the
   * minimal base set. Opt-in per name, so a config says out loud which ambient
   * state it depends on instead of quietly inheriting everything.
   */
  envPassthrough?: string[];
  url?: string;
  /** Static headers for a url transport (auth tokens belong here, not in a query string). */
  headers?: Record<string, string>;
  /**
   * Ceiling for one `tools/call`, in ms. Handshakes and `tools/list` have their own
   * fixed budgets; a long-running tool is the only thing this should govern
   * (backlog I2 — one 10 s timeout used to apply to all three).
   */
  timeoutMs?: number;
  disabled?: boolean;
}

/** `user` = the developer's own `~/.inflynx/mcp.json`. `project` = repo content. */
export type McpConfigSource = "user" | "project";

export interface ResolvedMcpServer extends McpServerConfig {
  source: McpConfigSource;
  /** Stable identity of this *exact* definition — see computeMcpTrustId. */
  trustId: string;
}

export interface McpConfigFile {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    envPassthrough?: string[];
    url?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    disabled?: boolean;
    transport?: "stdio" | "sse" | "streamable-http";
  }>;
}

export function getUserMcpConfigPath(): string {
  return path.join(os.homedir(), ".inflynx", "mcp.json");
}

export function getProjectMcpConfigPaths(startDir: string = process.cwd()): string[] {
  const rootDir = findWorkspaceRoot(startDir);
  return [path.join(rootDir, ".inflynx", "mcp.json"), path.join(rootDir, "mcp.json")];
}

/**
 * Identity for a trust decision: server id + a digest of the command line.
 *
 * Hashing the command rather than trusting the id alone means that changing what a
 * server *runs* invalidates its trust. A reviewed-and-approved entry cannot be
 * quietly edited later into something else while keeping the same approval.
 */
export function computeMcpTrustId(config: Pick<McpServerConfig, "id" | "command" | "args" | "url" | "transport">): string {
  const commandLine =
    config.url && config.transport !== "stdio"
      ? // The URL *is* the thing being trusted, so it is inside the fingerprint: editing
        // `url` to another host must invalidate the grant exactly the way editing a
        // command line does. The `sse` prefix is historical — it labels the fingerprint,
        // not the transport, and also covers `streamable-http`. Renaming it would revoke
        // every existing grant for no security gain, which is its own kind of breakage.
        `sse\u0000${config.url}`
      : `stdio\u0000${config.command || ""}\u0000${(config.args || []).join("\u0000")}`;
  const digest = createHash("sha256").update(`${config.id}\u0000${commandLine}`).digest("hex").slice(0, 16);
  return `${config.id}:${digest}`;
}

// ─── Trust store ───────────────────────────────────────────────────────────────

function getTrustStorePath(): string {
  return path.join(os.homedir(), ".inflynx", "mcp-trust.json");
}

interface TrustStore {
  trusted?: Record<string, { trustedAt: number; source: McpConfigSource; label?: string }>;
}

function readTrustStore(): TrustStore {
  try {
    const file = getTrustStorePath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as TrustStore) : {};
  } catch {
    // A corrupt trust store must not become "everything is trusted".
    return {};
  }
}

/**
 * Records consent to run one specific server definition. Written to the **user**
 * directory on purpose: project-local config can never grant itself permission,
 * otherwise the trust store would be as mutable as the thing it gates.
 */
export function trustMcpServer(server: ResolvedMcpServer | McpServerConfig, label?: string): void {
  const trustId = "trustId" in server && server.trustId ? server.trustId : computeMcpTrustId(server as McpServerConfig);
  const file = getTrustStorePath();
  const store = readTrustStore();
  store.trusted = {
    ...store.trusted,
    [trustId]: { trustedAt: Date.now(), source: (server as ResolvedMcpServer).source || "user", label },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function revokeMcpServer(trustId: string): boolean {
  const store = readTrustStore();
  if (!store.trusted?.[trustId]) return false;
  delete store.trusted[trustId];
  fs.writeFileSync(getTrustStorePath(), JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  return true;
}

export function listTrustedMcpServers(): Array<{ trustId: string; trustedAt: number; source: McpConfigSource; label?: string }> {
  const store = readTrustStore();
  return Object.entries(store.trusted || {}).map(([trustId, meta]) => ({ trustId, ...meta }));
}

export function isMcpServerTrusted(server: ResolvedMcpServer): boolean {
  // The user's own file is a consent act in itself; a repo's file is not.
  if (server.source === "user") return true;
  return Boolean(readTrustStore().trusted?.[server.trustId]);
}

// ─── Loading & saving ──────────────────────────────────────────────────────────

function readConfigFile(file: string): McpConfigFile {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as McpConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Loads every configured server, tagged with where it came from.
 *
 * Malformed entries are reported rather than silently skipped — a half-parsed
 * `command` is exactly what a hostile config looks like, and "I ignored it" is not
 * information the user should have to ask for.
 */
export function loadMcpConfig(startDir: string = process.cwd()): ResolvedMcpServer[] {
  const sources: Array<{ file: string; source: McpConfigSource }> = [
    { file: getUserMcpConfigPath(), source: "user" },
    ...getProjectMcpConfigPaths(startDir).map((file) => ({ file, source: "project" as McpConfigSource })),
  ];

  const servers = new Map<string, ResolvedMcpServer>();
  const problems: string[] = [];

  for (const { file, source } of sources) {
    const parsed = readConfigFile(file);
    for (const [id, cfg] of Object.entries(parsed.mcpServers || {})) {
      const transport = cfg.transport || (cfg.url ? "streamable-http" : "stdio");
      if (transport === "stdio") {
        if (!cfg.command) {
          problems.push(`${file}: "${id}" has no command — ignored.`);
          continue;
        }
      } else if (!cfg.url) {
        // A url transport without a url is not a misconfigured stdio server — running
        // something else under this id is exactly what the trust fingerprint prevents.
        problems.push(`${file}: "${id}" is ${transport} but has no url — ignored.`);
        continue;
      }
      if (cfg.timeoutMs !== undefined && (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1000)) {
        problems.push(`${file}: "${id}" has timeoutMs ${cfg.timeoutMs} — ignored; the floor is 1000ms.`);
      }
      const base = {
        id,
        name: id,
        transport,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        envPassthrough: cfg.envPassthrough,
        url: cfg.url,
        headers: cfg.headers,
        timeoutMs: Number.isFinite(cfg.timeoutMs) && (cfg.timeoutMs as number) >= 1000 ? cfg.timeoutMs : undefined,
        disabled: cfg.disabled ?? false,
        source,
      };
      servers.set(id, { ...base, trustId: computeMcpTrustId(base) });
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.warn(`[config] MCP config problem — ${problem}`);
  }
  return Array.from(servers.values());
}

export function saveMcpServerConfig(
  serverConfig: McpServerConfig,
  startDir: string = process.cwd()
): void {
  const inflynxDir = path.join(findWorkspaceRoot(startDir), ".inflynx");
  if (!fs.existsSync(inflynxDir)) {
    fs.mkdirSync(inflynxDir, { recursive: true });
  }

  const cfgPath = path.join(inflynxDir, "mcp.json");
  const currentConfig = readConfigFile(cfgPath);
  if (!currentConfig.mcpServers) currentConfig.mcpServers = {};

  currentConfig.mcpServers[serverConfig.id] = {
    command: serverConfig.command,
    args: serverConfig.args,
    env: serverConfig.env,
    envPassthrough: serverConfig.envPassthrough,
    url: serverConfig.url,
    headers: serverConfig.headers,
    timeoutMs: serverConfig.timeoutMs,
    transport: serverConfig.transport,
    disabled: serverConfig.disabled,
  };

  fs.writeFileSync(cfgPath, JSON.stringify(currentConfig, null, 2), "utf-8");
}

// ─── Process environment ──────────────────────────────────────────────────────

/**
 * The minimum an MCP subprocess needs to start at all. Anything more specific is
 * declared per server in `env`/`envPassthrough`, so the config file is a complete
 * and reviewable statement of what that server can see.
 */
export const MCP_BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ",
  "TMPDIR", "TEMP", "TMP", "NODE_ENV", "DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
] as const;

const CREDENTIAL_SHAPED = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE)/i;

/** Expands `${VAR}` references in a config value against the real environment. */
function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

/**
 * Builds the environment for one MCP subprocess.
 *
 * Deliberately does **not** spread `process.env`. `github_pat_…`, `OPENROUTER_API_KEY`
 * and friends used to be handed to every project-local, model-authored process,
 * which turns any prompt injection that can reach `mcp.json` into credential
 * theft (backlog B5).
 */
export function buildMcpEnvironment(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const key of MCP_BASE_ENV_KEYS) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  // Windows needs SystemRoot/ComSpec for child_process to work at all.
  for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA"]) {
    if (env[key] !== undefined) result[key] = env[key];
  }

  for (const name of server.envPassthrough || []) {
    if (typeof name !== "string" || !name) continue;
    if (env[name] === undefined) {
      console.warn(`[config] MCP server "${server.id}" asked to pass through ${name}, which is not set.`);
      continue;
    }
    if (CREDENTIAL_SHAPED.test(name)) {
      console.warn(
        `[config] MCP server "${server.id}" is being given ${name} via envPassthrough. ` +
        `That is a credential leaving the agent's control — make sure this server is one you chose.`
      );
    }
    result[name] = env[name];
  }

  for (const [key, rawValue] of Object.entries(server.env || {})) {
    if (typeof rawValue !== "string") continue;
    // An explicit assignment in the config is the user's own statement of intent,
    // including `${OPENAI_API_KEY}` written out in full. Interpolating here keeps
    // secrets in the keychain/env while making the *exposure* visible in the config.
    result[key] = interpolate(rawValue, env);
  }

  return result;
}

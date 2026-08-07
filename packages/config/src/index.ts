/**
 * @inflynx/config
 * Configuration loader, secret redaction, and execution profile validation.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface InflynxConfig {
  provider: "google" | "openai" | "anthropic" | "deepseek" | "openrouter" | "ollama";
  model: string;
  maxSteps: number;
  maxTurns: number;
  autoConfirm: boolean;
  apiKey?: string;
  baseURL?: string;
}

export interface ProviderInfo {
  id: "deepseek" | "google" | "openrouter" | "openai" | "anthropic";
  name: string;
  envKey: string;
  defaultModel: string;
  models: string[];
}

export const TOP_PROVIDERS: ProviderInfo[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
  },
  {
    id: "google",
    name: "Google Gemini",
    envKey: "GOOGLE_API_KEY",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-3.5-sonnet",
    models: ["anthropic/claude-3.5-sonnet", "deepseek/deepseek-r1", "openai/gpt-4o"],
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-3-5-sonnet-20241022",
    models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
  },
];

export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(curr, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(curr, ".inflynx"))
    ) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  // Fallback: farthest parent containing package.json
  curr = path.resolve(startDir);
  let rootCandidate = curr;
  while (true) {
    if (fs.existsSync(path.join(curr, "package.json"))) {
      rootCandidate = curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return rootCandidate;
}

export function loadEnv(startDir: string = process.cwd()): void {
  const rootDir = findWorkspaceRoot(startDir);
  const envFiles: string[] = [
    path.join(os.homedir(), ".inflynx", ".env"),
  ];

  // Search for .env from current directory up to root monorepo directory
  let curr = path.resolve(startDir);
  while (true) {
    envFiles.push(path.join(curr, ".env"));
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  if (process.env.INIT_CWD) {
    envFiles.push(path.join(process.env.INIT_CWD, ".env"));
  }

  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) {
      try {
        const content = fs.readFileSync(envFile, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        // ignore read errors
      }
    }
  }
}

export function saveKeyToEnv(envKey: string, value: string, startDir: string = process.cwd()): void {
  const rootDir = findWorkspaceRoot(startDir);
  const envPath = path.join(rootDir, ".env");
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  const lines = content.split("\n");
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${envKey}=`)) {
      found = true;
      return `${envKey}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${envKey}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join("\n"), "utf-8");
  process.env[envKey] = value;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, "[REDACTED_API_KEY]")
    .replace(/(AIzaSy[a-zA-Z0-9_-]{33})/g, "[REDACTED_API_KEY]");
}

// ─── MCP Configuration Loader ────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name?: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
}

export interface McpConfigFile {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    disabled?: boolean;
    transport?: "stdio" | "sse";
  }>;
}

export function loadMcpConfig(startDir: string = process.cwd()): McpServerConfig[] {
  const rootDir = findWorkspaceRoot(startDir);
  const configPaths = [
    path.join(os.homedir(), ".inflynx", "mcp.json"),
    path.join(rootDir, ".inflynx", "mcp.json"),
    path.join(rootDir, "mcp.json"),
  ];

  const serversMap = new Map<string, McpServerConfig>();

  for (const cfgPath of configPaths) {
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, "utf-8");
        const parsed = JSON.parse(raw) as McpConfigFile;
        if (parsed.mcpServers) {
          for (const [id, cfg] of Object.entries(parsed.mcpServers)) {
            serversMap.set(id, {
              id,
              name: id,
              transport: cfg.transport || (cfg.url ? "sse" : "stdio"),
              command: cfg.command,
              args: cfg.args,
              env: cfg.env,
              url: cfg.url,
              disabled: cfg.disabled ?? false,
            });
          }
        }
      } catch {
        // ignore malformed config files
      }
    }
  }

  return Array.from(serversMap.values());
}

export function saveMcpServerConfig(
  serverConfig: McpServerConfig,
  startDir: string = process.cwd()
): void {
  const rootDir = findWorkspaceRoot(startDir);
  const inflynxDir = path.join(rootDir, ".inflynx");
  if (!fs.existsSync(inflynxDir)) {
    fs.mkdirSync(inflynxDir, { recursive: true });
  }

  const cfgPath = path.join(inflynxDir, "mcp.json");
  let currentConfig: McpConfigFile = { mcpServers: {} };

  if (fs.existsSync(cfgPath)) {
    try {
      currentConfig = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch {
      currentConfig = { mcpServers: {} };
    }
  }

  if (!currentConfig.mcpServers) {
    currentConfig.mcpServers = {};
  }

  currentConfig.mcpServers[serverConfig.id] = {
    command: serverConfig.command,
    args: serverConfig.args,
    env: serverConfig.env,
    url: serverConfig.url,
    transport: serverConfig.transport,
    disabled: serverConfig.disabled,
  };

  fs.writeFileSync(cfgPath, JSON.stringify(currentConfig, null, 2), "utf-8");
}


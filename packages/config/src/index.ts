/**
 * @inflynx/config
 * Configuration loader, secret redaction, and execution profile validation.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { ProviderId } from "./model-catalog.js";

export {
  assertSupportedReasoningEffort,
  getModelCapability,
  getProvider,
  MODEL_CATALOG,
  REASONING_EFFORTS,
  resolveModelCapability,
  supportsReasoningEffort,
  TOP_PROVIDERS,
  type ModelAdapter,
  type ModelCapability,
  type ProviderId,
  type ProviderInfo,
  type ReasoningEffort,
} from "./model-catalog.js";
export {
  createCredentialProfile,
  createEnvironmentCredentialProfile,
  deleteCredentialProfile,
  getCredentialProfile,
  listCredentialProfiles,
  normalizeBaseUrl,
  resolveCredentialSecret,
  setCredentialBackendForTests,
  validateCustomModelEndpoint,
  validateCustomModelEndpointForUse,
  type CredentialBackend,
  type CredentialProfile,
  type CredentialProviderId,
  type CreateCredentialProfileInput,
} from "./credential-store.js";
export {
  listDiscoveredModels,
  refreshModelCatalog,
  type DiscoveredModel,
} from "./model-discovery.js";

export interface InflynxConfig {
  provider: ProviderId;
  model: string;
  maxSteps: number;
  maxTurns: number;
  autoConfirm: boolean;
  apiKey?: string;
  baseURL?: string;
}

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

/**
 * Redacts common API-key and Authorization-header representations before an
 * error reaches terminal output, persisted messages, or telemetry.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;"]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._-]{16,}/gi, "$1[REDACTED]")
    .replace(/\b(sk-(?:ant-)?[a-zA-Z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(AIza[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gsk_[a-zA-Z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(sk-or-v1-[a-zA-Z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b([a-z]{2,16}_[a-zA-Z0-9_-]{24,})\b/gi, "[REDACTED_API_KEY]");
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


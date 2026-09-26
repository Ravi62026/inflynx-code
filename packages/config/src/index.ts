/**
 * @inflynx/config
 * Configuration loader, secret redaction, and execution profile validation.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { ProviderId } from "./model-catalog.js";
import { findWorkspaceRoot } from "./workspace-root.js";

export {
  assertSupportedReasoningEffort,
  CONSERVATIVE_CONTEXT_WINDOW,
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
  CONTEXT_STRATEGIES,
  DEFAULT_CONTEXT_STRATEGY,
  getModelCapability,
  getProvider,
  MODEL_CATALOG,
  REASONING_EFFORTS,
  resolveContextLimits,
  resolveContextStrategy,
  resolveModelCapability,
  supportsReasoningEffort,
  TOP_PROVIDERS,
  type ContextLimits,
  type ContextStrategy,
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

export { findWorkspaceRoot } from "./workspace-root.js";

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
 * Credential-shaped strings from known issuers. Prefix-scoped on purpose: the
 * previous catch-all (`[a-z]{2,16}_[A-Za-z0-9_-]{24,}`) also matched ordinary
 * source identifiers such as `handle_user_authentication_flow`, which corrupted
 * agent output and the text shown to users (backlog B13).
 */
const VENDOR_TOKEN_PATTERN =
  /\b((?:sk-(?:ant-|or-v1-)?|gsk_|gh[pousr]_|github_pat_|xox[baprs]-|npm_|hf_|dckr_pat_|ASIA)[A-Za-z0-9_-]{12,})\b/g;

/**
 * A long opaque value *assigned to* a secret-sounding name, e.g.
 * `"apiKey": "..."`, `OPENROUTER_API_KEY=...`, `client_secret = "..."`.
 * Requiring an assignment context plus a secret-ish key name is what keeps
 * ordinary identifiers and prose intact.
 */
const ASSIGNED_SECRET_PATTERN =
  /(["']?)([A-Za-z0-9]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|credential)s?)\1(\s*[:=]\s*)(["'`]?)([A-Za-z0-9_\-./+]{8,})/gi;

/**
 * Redacts credential-shaped text before it reaches terminal output, persisted
 * messages, the event stream or telemetry. It is deliberately NOT applied to
 * content handed back to the model — see `AgentOrchestrator.runTurn`.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;"]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._-]{16,}/gi, "$1[REDACTED]")
    .replace(/\b(AIza[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(VENDOR_TOKEN_PATTERN, "[REDACTED_API_KEY]")
    .replace(ASSIGNED_SECRET_PATTERN, (match, quote = "", key = "", sep = "", innerQuote = "", value = "") => {
      // Never re-redact an already-redacted placeholder.
      if (value.startsWith("[REDACTED")) return match;
      return `${quote}${key}${quote}${sep}${innerQuote}[REDACTED]`;
    });
}

// ─── MCP configuration, trust & subprocess environment ───────────────────────
// Lives in `mcp-config.ts` so that loading, trusting and spawning one server are
// decided in one place — splitting them across files is how "where did this config
// come from" and "what may it see" stop being the same question (backlog B5/B6).
export {
  buildMcpEnvironment,
  computeMcpTrustId,
  getProjectMcpConfigPaths,
  getUserMcpConfigPath,
  isMcpServerTrusted,
  listTrustedMcpServers,
  loadMcpConfig,
  MCP_BASE_ENV_KEYS,
  revokeMcpServer,
  saveMcpServerConfig,
  trustMcpServer,
  type McpConfigFile,
  type McpConfigSource,
  type McpServerConfig,
  type ResolvedMcpServer,
} from "./mcp-config.js";


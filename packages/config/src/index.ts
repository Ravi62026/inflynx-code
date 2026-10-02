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
  clampReasoningEffort,
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

export { findWorkspaceRoot, loadProjectInstructions } from "./workspace-root.js";

export function loadEnv(startDir: string = process.cwd()): void {
  const rootDir = findWorkspaceRoot(startDir);
  // Most-specific first: the current project's .env (and any parent up to the workspace root) must
  // WIN over a stale global ~/.inflynx/.env, because vars are only applied when unset (see below).
  // Previously the global file was loaded first and shadowed the project config (wrong ports/URLs).
  const envFiles: string[] = [];

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

  // Global defaults LAST — they only fill keys no project .env provided.
  envFiles.push(path.join(os.homedir(), ".inflynx", ".env"));

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

// ─── Terminal output safety ───────────────────────────────────────────────────

/**
 * Strip terminal control sequences from text that this tool did not author.
 *
 * Tool output, MCP server responses, fetched pages, cloned-repo file contents and
 * restored transcripts are all written by someone else, and a terminal *executes* what
 * it is handed: an embedded OSC 8 makes a clickable link out of anything, OSC 52 replaces
 * the clipboard, and raw cursor/erase sequences can overwrite the line a security prompt
 * is about to print. For a CLI whose entire safety story is "a human reads this and
 * approves it", that is not a rendering bug (backlog N5).
 *
 * Applied at the same egress boundary as `redactSecrets`, and with the same restraint:
 * only the externally-sourced value is passed through, never the surrounding string that
 * contains this tool's own color codes — sanitizing those would silently break the UI.
 *
 * Also removes C0 control characters other than tab/newline, which terminals interpret in
 * various ways, and the C1 range.
 *
 * Two things about the sequence patterns are deliberate:
 * - They consume to the terminator (`BEL` or `ST` = `ESC \`) rather than stopping at an
 *   inner `ESC`, because that is what terminals do — tmux passthrough (`DCS`) legitimately
 *   contains nested `ESC` sequences, and a non-nesting match would strand them.
 * - A final unconditional `ESC` strip guarantees the invariant the sanitizer exists for:
 *   **no escape introducer survives**, whatever the input was. An unterminated OSC in the
 *   wild would otherwise leave the whole payload printing as data with a live `ESC` in it.
 */
export function sanitizeForTerminal(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    // OSC: ESC ] ... terminated by BEL or ST
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // DCS / SOS / PMC / APC — may contain nested ESC sequences, same terminators
    .replace(/\u001b[PX^_][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // CSI: ESC [ parameters ... final byte @..~
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // Any remaining ESC + single interleaved byte ("other end-of-sequence" set)
    .replace(/\u001b[@-Z\\-]/g, "")
    // C0 controls except tab and newline; DEL; and C1 as bytes
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, "")
    // Last resort, and the actual guarantee: nothing here may still be an ESC.
    .replace(/\u001b/g, "");
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


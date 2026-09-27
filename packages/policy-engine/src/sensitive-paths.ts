/**
 * The sensitive-path fence (backlog Phase 28 / finding B10).
 *
 * Before this there was no write fence at all: a mutating tool whose path survived the
 * canonical guard could overwrite `.git/config`, `~/.ssh/authorized_keys` (when the
 * workspace root is broad), the credential store, or anything under `node_modules`. The
 * guard answers "is this inside the workspace"; that is not the same question as "is this
 * a file the agent should be editing". A repository's own `.git/` is inside every workspace
 * and is precisely the thing an agent must never write.
 *
 * This module answers the second question, in one place, so the mutating-tool fence in
 * `ToolExecutionGateway`, the attachment-transport path in the server, and any future reader
 * share a single opinion rather than each inventing its own prefix list.
 *
 * ## Why reads are treated differently from writes
 *
 * The write fence is unambiguous: there is no legitimate reason for the agent to write
 * `.git/config`. *Reading* secrets is a separate, larger control (the Phase 33 content
 * fence + redaction, which also has to decide what a model may see), so this module exposes
 * a distinct `isSensitiveToRead` and defaults it conservatively. Phase 28 enforces the write
 * side; the read side is opt-in per call site so it is not turned on half-way.
 */

import path from "path";

export interface SensitiveVerdict {
  sensitive: boolean;
  /** Why, phrased so the model can correct rather than retry blindly. */
  reason?: string;
  /** The pattern that matched, for the audit log. */
  rule?: string;
}

/** Directory names that are never an agent's to write, matched as whole segments. */
const SENSITIVE_DIR_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".config",
  ".vscode-server",
]);

/**
 * Exact basenames that hold credentials or change security behaviour. Matched on the final
 * path segment so a `my.env.ts` source file is not caught by the `.env` family below.
 */
const SENSITIVE_BASENAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  "authorized_keys",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  ".htpasswd",
  "credentials.json",
  "credentials.yml",
  "secrets.json",
]);

/**
 * Private-key / keystore extensions. Writing one of these is as destructive as writing
 * `.env`, so they are fenced for both directions; the workspace index uses the same idea on
 * the read side.
 */
const SECRET_FILE_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".kdbx", ".jks"];

/**
 * `.env` and `.env.local` etc. are secrets, but `.env.example` / `.env.sample` /
 * `.env.template` / `.env.dist` are the *committed templates* whose entire purpose is to be
 * edited. Refusing those would block ordinary work, so the allow-list is explicit.
 */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".txt"];

function normalizeSlashes(p: string): string {
  return p.split(path.sep).join("/");
}

/** True for `.env` or `.env.<name>` that is not a shared template. */
function isSecretEnvFile(base: string): boolean {
  if (base !== ".env" && !base.startsWith(".env.")) return false;
  return !ENV_TEMPLATE_SUFFIXES.some((s) => base.endsWith(s));
}

/**
 * Classify `absPath` (already canonicalised and inside the workspace by the caller) for a
 * WRITE. `root` is only used to phrase the reason; the match is on the path shape itself so a
 * `.git/` anywhere under the root is caught, not just the top-level one.
 */
export function isSensitiveToWrite(absPath: string, root: string): SensitiveVerdict {
  const rel = normalizeSlashes(path.isAbsolute(absPath) ? path.relative(root, absPath) : absPath);
  const segments = rel.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";

  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) {
      return {
        sensitive: true,
        rule: `dir:${seg}`,
        reason: `it is under \`${seg}/\` — that directory is not source code the agent edits ` +
          `(repository state, installed dependencies, or credentials). Ask the user to change it themselves if it is really required.`,
      };
    }
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return {
      sensitive: true,
      rule: `file:${base}`,
      reason: `\`${base}\` holds credentials or changes security/tooling behaviour, so the agent will not write it.`,
    };
  }
  const lowerBase = base.toLowerCase();
  if (SECRET_FILE_SUFFIXES.some((s) => lowerBase.endsWith(s))) {
    return {
      sensitive: true,
      rule: `key:${lowerBase.slice(lowerBase.lastIndexOf("."))}`,
      reason: `a \`${lowerBase.slice(lowerBase.lastIndexOf("."))}\` private-key/keystore file is credential material; the agent will not write it.`,
    };
  }
  if (isSecretEnvFile(base)) {
    return {
      sensitive: true,
      rule: "env",
      reason: `\`${base}\` is treated as a secret file (API keys, tokens). The agent reads configuration through the credential store, not by editing .env — add a key yourself if this is what you meant.`,
    };
  }
  // The credential store the onboarding flow writes: `.inflynx/credentials.json`. The rest of
  // `.inflynx/` is the agent's own working area (plans, sessions, checkpoints) and stays writable.
  if (segments.length >= 2 && segments[0] === ".inflynx" && segments[1] === "credentials.json") {
    return {
      sensitive: true,
      rule: "credentials",
      reason: "`credentials.json` is the encrypted credential store; the agent stores keys through the settings flow, not by writing the file.",
    };
  }
  return { sensitive: false };
}

/**
 * The read side, kept separate so it is only switched on deliberately. Today it is the same
 * shape minus `node_modules` (reading an installed dependency is normal). Phase 33 owns the
 * fuller content/redaction policy; this exists so Phase 27's attachment transport can refuse
 * to inline a `.env`/`.git`/key file without pretending to have built the whole read fence.
 */
export function isSensitiveToRead(absPath: string, root: string): SensitiveVerdict {
  const w = isSensitiveToWrite(absPath, root);
  if (w.sensitive && w.rule === "dir:node_modules") return { sensitive: false };
  return w;
}

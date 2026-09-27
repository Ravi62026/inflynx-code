/**
 * @inflynx/tool-runtime
 * Dynamic Tool Registry, Core Tools, & Dependency DAG Scheduler.
 */

import fs from "fs";
import path from "path";
import { validatePublicUrl, CanonicalPathGuard, CommandPolicy } from "@inflynx/policy-engine";
import { applySurgicalPatch, computeUnifiedDiff, EditTransactionManager, type TurnCheckpointStore } from "@inflynx/patch-engine";
import {
  ShellRegistry,
  BACKGROUND_SHELL_MAX_LIFETIME_MS,
  BACKGROUND_SHELL_RETENTION_BYTES,
} from "./background-shells.js";
import { GIT_TOOL } from "./git-tools.js";
import { wrapUntrusted } from "@inflynx/protocol";
import { UPDATE_PLAN_TOOL } from "./plan-tool.js";
import { LIST_DIAGNOSTICS_TOOL, LIST_SYMBOLS_TOOL, FIND_DEFINITION_TOOL } from "./diagnostics-tools.js";

export {
  LIST_DIAGNOSTICS_TOOL,
  LIST_SYMBOLS_TOOL,
  FIND_DEFINITION_TOOL,
  getDiagnosticsForFile,
  resetLanguageServices,
  type FileDiagnostic,
  type CodeSymbol,
} from "./diagnostics-tools.js";

export {
  UPDATE_PLAN_TOOL,
  PLAN_RELATIVE_PATH,
  buildPlanFromInput,
  type UpdatePlanInput,
} from "./plan-tool.js";

export {
  GIT_TOOL,
  classifyGitInvocation,
  validateGitArgs,
  type GitGrade,
  type GitInvocationInfo,
} from "./git-tools.js";

export {
  ShellRegistry,
  BACKGROUND_SHELL_MAX_LIFETIME_MS,
  BACKGROUND_SHELL_RETENTION_BYTES,
  type BackgroundShellRecord,
  type ShellReadResult,
  type ShellStartResult,
} from "./background-shells.js";

export {
  ToolExecutionGateway,
  capToolOutput,
  reviewMutatingPatchForSafety,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  type GatewayExecutionOptions,
} from "./ToolExecutionGateway.js";

// ─── JSON Tool Argument Parser & Repair Helper ────────────────────────────────

export function safeParseJsonArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.raw === "string" && Object.keys(obj).length === 1) {
      return safeParseJsonArgs(obj.raw);
    }
    return obj;
  }
  if (typeof raw !== "string") return {};

  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      const sanitized = trimmed.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) => {
        return match
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\t/g, "\\t");
      });
      return JSON.parse(sanitized);
    } catch {
      // No smarter recovery on purpose. The previous version regex-scraped
      // `{ path, content }` out of arbitrary broken JSON, so a malformed tool call
      // could "succeed" against the wrong file with truncated content (backlog E6).
      // Returning `{ raw }` makes the tool fail on its own required arguments, which
      // gives the model a real, correctable error instead of silent corruption.
      return { raw: trimmed };
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  dependencies?: string[];
}

/**
 * The single source of truth a tool is allowed to have about *where* it may
 * operate.
 *
 * `resolvePath` and `pathGuard` are the same instance the
 * `ToolExecutionGateway` used to validate the arguments, so validation and
 * execution can no longer disagree. Previously each tool re-resolved from
 * `process.env.INFLYNX_WORKSPACE_ROOT || process.cwd()` — a third, process-wide
 * root that broke multi-session servers and opened a guard bypass (backlog H1).
 */
export interface ToolExecutionContext {
  signal?: AbortSignal;
  /** Canonical, symlink-resolved root for this session. */
  workspaceRoot: string;
  /** Shared guard — never construct a second one inside a tool. */
  pathGuard: CanonicalPathGuard;
  resolvePath(targetPath: string): string;
  sessionId?: string;
  mode?: ToolExecutionMode;
  /**
   * This session's background shells. Owned by the gateway (one per session) and
   * handed to each tool call, so `execute_shell({background})`, `shell_output` and
   * `shell_stop` all see the same registry while a second session cannot even name
   * one of its shells. A context built outside a gateway gets a private one.
   */
  shells: ShellRegistry;
  /**
   * Per-turn undo journal, owned by the gateway and opened by the orchestrator at the
   * start of each turn. Optional: a context built outside a session (tests, plugins,
   * `/verify`) simply does not checkpoint, and nothing about tool behaviour changes.
   */
  checkpoints?: TurnCheckpointStore;
  /**
   * Phase 19: the owning session's sub-agent runner. Present only when the orchestrator supplied
   * one; the `delegate` tool calls it to explore in a nested, budget-limited context and get a
   * distilled summary back. Optional so tests/plugins/embedded contexts simply have no delegation.
   */
  runSubAgent?: (task: string) => Promise<string>;
}

/**
 * Snapshot of a path's on-disk state. A file that cannot be read as UTF-8 is reported as
 * absent rather than as empty text — an unrecordable file must never look like a
 * deletion, because `/undo` acts on what was recorded.
 */
function fileSnapshot(absPath: string): { content: string; exists: boolean } {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) return { content: "", exists: false };
  try {
    return { content: fs.readFileSync(absPath, "utf-8"), exists: true };
  } catch {
    return { content: "", exists: false };
  }
}

/** Non-overlapping occurrences of `needle`. `split` counts correctly and skips regex traps. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Keeps an error message about a long snippet readable. */
function truncateForMessage(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `… (${text.length - max} more chars)` : text;
}

/**
 * Record a completed file mutation so `/undo` can reverse it. The post-image is read back
 * from disk rather than taken from what the tool thinks it wrote — the reverse patch has
 * to be true about the bytes that are actually there.
 */
function recordCheckpoint(
  ctx: ToolExecutionContext,
  absPath: string,
  before: { content: string; exists: boolean }
): void {
  if (!ctx.checkpoints) return;
  const relPath = path.relative(ctx.pathGuard.getWorkspaceRoot(), absPath);
  if (!relPath || relPath.startsWith("..")) return;
  ctx.checkpoints.recordEdit(relPath.split(path.sep).join("/"), before, fileSnapshot(absPath));
}

/**
 * Record a rename for `/undo`. Both `move_path` and `delete_path` are renames (the latter
 * into `.inflynx/.trash/`), so a move entry is how a directory delete stays reversible
 * without copying the tree.
 */
function recordMove(ctx: ToolExecutionContext, fromAbs: string, toAbs: string): void {
  if (!ctx.checkpoints) return;
  const rel = (p: string) => path.relative(ctx.workspaceRoot, p).split(path.sep).join("/");
  const fromRel = rel(fromAbs);
  const toRel = rel(toAbs);
  if (!fromRel || !toRel || fromRel.startsWith("..") || toRel.startsWith("..")) return;
  ctx.checkpoints.recordMove(fromRel, toRel);
}

/** Mirrors `@inflynx/agent-core`'s `AgentMode`; kept local to avoid a cycle. */
export type ToolExecutionMode = "ask" | "plan" | "agent" | "debug";

/**
 * Builds a context from an existing guard — use this when the caller already
 * owns the canonical guard (as `ToolExecutionGateway` does) so no second guard
 * is ever constructed for the same session. Pass `shells` to share a registry
 * across calls; omit it for a throwaway one.
 */
export function createToolExecutionContextFromGuard(
  pathGuard: CanonicalPathGuard,
  options: {
    signal?: AbortSignal;
    sessionId?: string;
    mode?: ToolExecutionMode;
    shells?: ShellRegistry;
    checkpoints?: TurnCheckpointStore;
    runSubAgent?: (task: string) => Promise<string>;
  } = {}
): ToolExecutionContext {
  return {
    signal: options.signal,
    workspaceRoot: pathGuard.getWorkspaceRoot(),
    pathGuard,
    resolvePath: (targetPath: string) => pathGuard.validateAndResolve(targetPath),
    sessionId: options.sessionId,
    mode: options.mode,
    shells: options.shells ?? new ShellRegistry(),
    checkpoints: options.checkpoints,
    runSubAgent: options.runSubAgent,
  };
}

/**
 * Convenience wrapper for direct/embedded tool execution (tests, plugins,
 * one-off scripts). Production request paths should go through
 * `ToolExecutionGateway.executeGuarded`, which builds this for you.
 */
export function createToolExecutionContext(
  workspaceRoot: string,
  options: { signal?: AbortSignal; sessionId?: string; mode?: ToolExecutionMode } = {}
): ToolExecutionContext {
  return createToolExecutionContextFromGuard(new CanonicalPathGuard(workspaceRoot), options);
}

/**
 * A JSON Schema node, typed permissively.
 *
 * This used to be `{ type, description, default }`, which made it impossible to declare a
 * tool that takes an array of objects — so `edit_file` (multi-hunk edits), a git tool
 * taking a file list, or anything structured could not be described to the model at all,
 * and tools resorted to string-encoded blobs. Widening it here is what lets Phase 23 and
 * 24 exist without inventing a mini-language per tool.
 */
export type ToolParameterSchema = {
  type: string;
  description?: string;
  default?: unknown;
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  enum?: readonly unknown[];
};

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required: string[];
  };
  isMutating?: boolean;
  permissionLevel: "readonly" | "readwrite" | "shell";
  origin?: "core" | "mcp" | "plugin";
  serverName?: string;
  /**
   * Safe for the gateway to de-duplicate when the exact same call repeats inside
   * one turn. Opt-in, and only for pure local reads: an MCP tool may look readonly
   * while quietly mutating something, and a network tool's answer legitimately
   * changes. The gateway additionally clears every entry whenever a mutating tool
   * succeeds, so a read cannot be answered from a pre-edit snapshot.
   */
  cacheable?: boolean;
  execute: (args: TArgs, ctx: ToolExecutionContext) => Promise<string | ToolExecuteResult>;
}

/**
 * A tool that needs to say "this failed, and here is the useful output anyway".
 *
 * Returning a plain string cannot express that, and throwing loses the payload:
 * a failing `pnpm test` used to come back as only stderr, which is the opposite of
 * what a build/test report needs. Non-zero exit is information, not an exception.
 */
export interface ToolExecuteResult {
  output: string;
  isError?: boolean;
  /** Reported where a process exit code is meaningful, for the shell audit log. */
  exitCode?: number | null;
  /**
   * Set by `update_plan` only. A tool that changes the plan cannot express that through
   * `output` — the CLI progress line and the extension sidebar need the *structure*, and
   * every reader re-parsing the markdown is exactly the arrangement Phase 26 removed.
   * Typed loosely on purpose: the canonical shape is `PlanSpec` in `@inflynx/protocol`,
   * and this package's `plan-tool.ts` imports it from there.
   */
  plan?: import("@inflynx/protocol").PlanSpec;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  durationMs: number;
  /**
   * Process exit code, for tools that run one. Kept separate from `isError` so the
   * audit log can tell "exited 1" from "the tool threw".
   */
  exitCode?: number | null;
  /** Set when the gateway capped `output` to protect the model context. */
  truncated?: boolean;
  /**
   * Set when the gateway answered from an identical read already made in this turn,
   * so `output` is a pointer rather than the content. Telemetry and the UI need to
   * be able to tell a cheap hit from a real result.
   */
  cached?: boolean;
  /**
   * For a successful mutating tool: the canonical path it changed, as the gateway
   * resolved it. Reported from the resolved value rather than left to the caller to
   * re-derive, because "did this turn touch source code that needs verifying?" is a
   * question only the layer holding the guard can answer accurately. Relative paths,
   * `..` segments and symlinks all resolve to the same file.
   */
  touchedPath?: string;
  /** True when `touchedPath` lies outside `.inflynx/`, i.e. it is a real source edit. */
  touchedSourceFile?: boolean;
  /**
   * The structured plan, when this call published or advanced one (`update_plan`).
   * The orchestrator turns it into the `plan.updated` event, which had been declared in
   * the protocol and emitted by nothing since the event list existed.
   */
  plan?: import("@inflynx/protocol").PlanSpec;
}

// ─── Core Tool Implementations ────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*>([\s\S]*?)<\/script>/gi, "")
    .replace(/<style\b[^<]*>([\s\S]*?)<\/style>/gi, "")
    .replace(/<head\b[^<]*>([\s\S]*?)<\/head>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

/**
 * Default `read_file` window, in lines.
 *
 * A whole-file read is the single largest avoidable context cost an agent makes:
 * files are re-read across turns, and every re-read is replayed in all later
 * requests. 1000 lines is wide enough for any real source file the model should
 * be editing in one pass, and the output always states the exact arguments for
 * continuing, so windowing is a pause rather than a blind spot. An explicit
 * `start_line`/`end_line` is always honoured in full.
 */
export const DEFAULT_READ_WINDOW_LINES = 1_000;

/**
 * Shell timeouts. The previous default of 30 s made `pnpm install`, a real build and
 * most test suites impossible to run at all, which is part of why the shell tool was
 * never used (backlog E2).
 */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/**
 * Ceiling on the lines `search_files` returns. `--max-count=50` is *per file*, so a
 * common token across a monorepo used to be an unbounded aggregate that only the
 * gateway's character cap would catch — mid-file, without explaining itself.
 */
export const MAX_SEARCH_RESULT_LINES = 400;

/** Directory names the workspace walkers skip, matching `list_directory`'s policy. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", ".cache", ".next", "coverage", ".turbo",
]);

/** Ceiling on `glob_files` results; the count of the remainder is always reported. */
export const MAX_GLOB_RESULTS = 200;

/**
 * How many files `glob_files` will *examine* before stopping, independent of how many
 * match. These are two different limits and conflating them is how a search starts
 * reporting a partial tree as if it were the whole answer.
 */
export const MAX_GLOB_SCAN = 5_000;

/**
 * Where `delete_path` puts things instead of deleting them.
 *
 * Under `.inflynx/` so it is gitignored, invisible to the workspace index, and
 * collected with the rest of the session state. Deleting by *rename* rather than by
 * `rm` means the agent's most irreversible operation is a rename that takes
 * microseconds, costs no disk twice, and can be undone with `move_path` — which
 * matters now, because turn checkpoints and `/undo` are still Epic 4 (Phase 30).
 */
export const TRASH_RELATIVE_PATH = path.join(".inflynx", ".trash");

/**
 * Converts a glob to an anchored regex.
 *
 * Supported: `**` (crosses directories), `*` (within one segment), `?`, and `{a,b}`.
 * A pattern with no `/` is matched against the basename too, so `*.test.ts` finds
 * tests anywhere in the tree — which is what a caller means by it. Anything else is
 * escaped, so `[` or `(` in a filename cannot blow up the matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything.
        source += pattern[i + 2] === "/" ? "(?:[^/]*?/)*?" : ".*?";
        i += pattern[i + 2] === "/" ? 2 : 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (ch === "?") { source += "[^/]"; continue; }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const options = pattern.slice(i + 1, close).split(",");
        source += `(?:${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = close;
        continue;
      }
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const anchored = new RegExp(`^${source}$`);
  const basename = pattern.includes("/")
    ? anchored
    : new RegExp(`(?:^|/)${source}$`);
  return basename;
}

/**
 * Depth-first walk yielding workspace-relative paths, bounded by `limit + 1` so a
 * caller can tell "exactly at the cap" from "hit the cap".
 */
function walkWorkspaceFiles(
  root: string,
  limit: number,
  shouldAbort: () => boolean
): { relPaths: string[]; truncated: boolean; skippedDirs: number } {
  const found: string[] = [];
  let truncated = false;
  let skippedDirs = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (shouldAbort() || found.length > limit) {
      truncated = truncated || found.length > limit;
      break;
    }
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than fail the whole search
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === path.basename(TRASH_RELATIVE_PATH)) {
          skippedDirs++;
          continue;
        }
        if (abs === root || abs.startsWith(root + path.sep)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks are not followed by either walker
      if (found.length >= limit) { truncated = true; break; }
      found.push(path.relative(root, abs));
    }
  }
  return { relPaths: found, truncated, skippedDirs };
}

export const CORE_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path. Optionally specify start and end line numbers.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        start_line: { type: "number", description: `Optional start line (1-indexed)`, default: 1 },
        end_line: { type: "number", description: `Optional end line (inclusive). Without it, at most ${DEFAULT_READ_WINDOW_LINES} lines are returned and the output says how to continue.` },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const { path: filePath, start_line, end_line } = args as {
        path: string; start_line?: number; end_line?: number;
      };

      const absPath = ctx.resolvePath(filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${absPath}`);
      }

      const stat = fs.statSync(absPath);
      if (stat.size > 1_000_000) {
        throw new Error(`File too large (${(stat.size / 1024).toFixed(0)} KB). Use search_files to locate specific sections.`);
      }

      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      const start = (start_line ?? 1) - 1;
      // A default window instead of "the whole file". `read_file` used to admit up
      // to 1 MB per call, so one careless read could cost a quarter of a million
      // tokens and stay there for every later turn (backlog D3/D4). The window is
      // always *announced* with the exact arguments to continue, because a silent
      // truncation is how an agent confidently edits code it never saw.
      const windowed = !end_line || end_line <= 0;
      const end = windowed ? Math.min(lines.length, start + DEFAULT_READ_WINDOW_LINES) : end_line;
      const sliced = lines.slice(start, end);

      const body = sliced
        .map((l, i) => `${String(start + i + 1).padStart(4)} │ ${l}`)
        .join("\n");

      if (end < lines.length) {
        return (
          body +
          `\n\n[${lines.length - end} more line(s) not shown — ${path.basename(absPath)} has ` +
          `${lines.length} lines in total. Continue with start_line=${end + 1}` +
          `${end + DEFAULT_READ_WINDOW_LINES < lines.length ? `, end_line=${end + DEFAULT_READ_WINDOW_LINES}` : ""} ` +
          `to read the next window.]`
        );
      }
      return body;
    },
  },

  {
    name: "patch_file",
    description: "Surgically replace a specific function, class, or code snippet in a file without modifying untouched code.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        target_code: { type: "string", description: "Exact code block or function lines to replace" },
        replacement_code: { type: "string", description: "New replacement code block or function lines" },
      },
      required: ["path", "target_code", "replacement_code"],
    },
    execute: async (args, ctx) => {
      const { path: filePath, target_code, replacement_code } = args as {
        path: string; target_code: string; replacement_code: string;
      };

      const absPath = ctx.pathGuard.validateAndResolve(filePath);
      const before = fileSnapshot(absPath);
      const txManager = new EditTransactionManager(ctx.pathGuard);
      const patch = txManager.stagePatch(filePath, target_code, replacement_code);
      txManager.commit();
      recordCheckpoint(ctx, absPath, before);

      return `✓ Surgically patched: ${filePath}\nDiff:\n${patch.diff}`;
    },
  },

  {
    name: "write_file",
    description: "Write or overwrite a file with provided content. Creates parent directories if needed.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        content: { type: "string", description: "Full content to write to file" },
      },
      required: ["path", "content"],
    },
    execute: async (args, ctx) => {
      const { path: filePath, content } = args as { path: string; content: string };
      const absPath = ctx.pathGuard.validateAndResolve(filePath);
      const before = fileSnapshot(absPath);
      const txManager = new EditTransactionManager(ctx.pathGuard);
      txManager.stageFileWrite(filePath, content);
      txManager.commit();
      recordCheckpoint(ctx, absPath, before);

      const lines = content.split("\n").length;
      return `✓ Written: ${filePath} (${lines} lines)`;
    },
  },

  {
    name: "edit_file",
    /**
     * Multi-hunk editing (backlog Phase 23). `patch_file` takes one snippet, so a
     * five-line refactor across four places costs four calls, four approvals and four
     * chances for the file to change underneath. This applies a list of edits in order
     * and writes **once** — either every edit located cleanly, or nothing is written.
     */
    description:
      "Apply several exact-string replacements to one file in a single atomic edit. " +
      "Edits apply in order, each old_text must match exactly one place unless replace_all is set, " +
      "and if any edit cannot be applied the file is left untouched. Prefer this over repeated " +
      "patch_file calls for a refactor that touches several places.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit" },
        edits: {
          type: "array",
          description: "Replacements applied in order",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact existing text to replace" },
              newText: { type: "string", description: "Text to put in its place" },
              replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    execute: async (args, ctx) => {
      const { path: filePath, edits } = args as {
        path: string;
        edits: Array<{ oldText?: string; newText?: string; replaceAll?: boolean }>;
      };
      if (!Array.isArray(edits) || edits.length === 0) {
        return { output: "Error: edit_file needs a non-empty 'edits' array.", isError: true };
      }

      const absPath = ctx.pathGuard.validateAndResolve(filePath);
      const before = fileSnapshot(absPath);
      if (!before.exists) {
        return {
          output:
            `Error: "${filePath}" does not exist, so there is nothing to edit. ` +
            `Use write_file to create it.`,
          isError: true,
        };
      }

      // Every edit is resolved against the working copy before a single byte is written,
      // which is what makes "all-or-nothing" true rather than a claim.
      let working = before.content;
      const applied: number[] = [];
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] || {};
        const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
        const newText = typeof edit.newText === "string" ? edit.newText : "";
        if (!oldText) {
          return { output: `Error: edit #${i + 1} has an empty oldText, which would match everywhere.`, isError: true };
        }

        const occurrences = countOccurrences(working, oldText);
        if (occurrences === 0) {
          // Only true when something actually preceded this edit — claiming earlier
          // edits were applied when #1 is the one that failed would send the model
          // looking for a partial write that never happened.
          const partialNote = i === 0
            ? "Nothing was written."
            : `The ${i} earlier edit(s) in this call *were* applied to the in-memory copy, but nothing was written.`;
          return {
            output:
              `Error: edit #${i + 1} of ${edits.length} found no match for its oldText in "${filePath}".\n` +
              `${partialNote}\n` +
              `Re-read the file and match the text that is actually there, including indentation.\n` +
              `Looking for: ${JSON.stringify(truncateForMessage(oldText, 220))}`,
            isError: true,
          };
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return {
            output:
              `Error: edit #${i + 1} is ambiguous — oldText appears ${occurrences} times in "${filePath}" ` +
              `and replace_all was not set. Nothing was written.\n` +
              `Either include more surrounding lines to make it unique, or pass replaceAll: true ` +
              `if you really mean every occurrence.`,
            isError: true,
          };
        }

        working = edit.replaceAll
          ? working.split(oldText).join(newText)
          : working.replace(oldText, newText);
        applied.push(occurrences);
      }

      const txManager = new EditTransactionManager(ctx.pathGuard);
      const staged = txManager.stageFileWrite(filePath, working);
      txManager.commit();
      recordCheckpoint(ctx, absPath, before);

      const changed = computeUnifiedDiff(filePath, before.content, staged.newContent);
      return (
        `✓ Applied ${applied.length} edit(s) to ${filePath} in one atomic write.\n` +
        `Diff:\n${changed}`
      );
    },
  },

  {
    name: "list_directory",
    description: "List directory contents recursively up to a given depth. Respects .gitignore patterns.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list", default: "." },
        depth: { type: "number", description: "Maximum directory depth to recurse", default: 3 },
      },
      required: [],
    },
    execute: async (args, ctx) => {
      const { path: dirPath = ".", depth = 3 } = args as { path?: string; depth?: number };
      const absPath = ctx.resolvePath(dirPath);

      const lines: string[] = [];
      function walk(dir: string, indent: string, currentDepth: number) {
        if (currentDepth > depth) return;
        let entries: string[];
        try {
          entries = fs.readdirSync(dir).sort();
        } catch {
          return;
        }

        for (const entry of entries) {
          if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
          const fullPath = path.join(dir, entry);
          const stat = fs.lstatSync(fullPath);
          if (stat.isSymbolicLink()) {
            lines.push(`${indent}🔗 ${entry} (symlink skipped)`);
            continue;
          }
          if (stat.isDirectory()) {
            lines.push(`${indent}📁 ${entry}/`);
            walk(fullPath, indent + "  ", currentDepth + 1);
          } else {
            const kb = (stat.size / 1024).toFixed(1);
            lines.push(`${indent}📄 ${entry} (${kb}KB)`);
          }
        }
      }

      walk(absPath, "", 1);
      return lines.join("\n") || "(empty directory)";
    },
  },

  {
    name: "glob_files",
    description:
      "Find files by path pattern (e.g. '*.ts', 'src/**/*.{test,spec}.ts', '**/README.md'). " +
      "Returns workspace-relative paths sorted by last modified, newest first. " +
      "Skips node_modules, .git, dist, .cache, .next, coverage, .turbo and the trash dir.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob; * within a segment, ** across segments, ? one char, {a,b} alternatives. A pattern with no / also matches the basename." },
        path: { type: "string", description: "Directory to search under", default: "." },
        limit: { type: "number", description: `Maximum paths to return (default and max ${MAX_GLOB_RESULTS})` },
      },
      required: ["pattern"],
    },
    execute: async (args, ctx) => {
      const { pattern, path: basePath = ".", limit } = args as {
        pattern: string; path?: string; limit?: number;
      };
      if (!pattern || !pattern.trim()) return { output: "Error: glob_files needs a non-empty pattern.", isError: true };

      const rootDir = ctx.resolvePath(basePath);
      const cap = Math.min(Math.max(1, limit ?? MAX_GLOB_RESULTS), MAX_GLOB_RESULTS);
      const matcher = globToRegExp(pattern.trim());
      // Scan a wide net, then filter, then cap the *matches*. The scan limit is
      // reported separately from the result limit, because "I looked at 5,000 files
      // and 200 matched" and "I looked at everything" are different answers.
      const walk = walkWorkspaceFiles(rootDir, MAX_GLOB_SCAN, () => ctx.signal?.aborted === true);
      if (ctx.signal?.aborted) return { output: "Error: File search was cancelled.", isError: true };

      const matched = walk.relPaths.filter((rel) => matcher.test(rel.split(path.sep).join("/")));
      const scanNote = walk.truncated
        ? ` NOTE: the search stopped after examining ${MAX_GLOB_SCAN.toLocaleString()} files in this ` +
          `directory — this may not be the whole tree. Narrow "path" to search deeper parts.`
        : "";
      if (matched.length === 0) {
        return (
          `No files matched "${pattern}" under ${path.relative(ctx.workspaceRoot, rootDir) || "."}. ` +
          `node_modules, .git, dist and other build directories are never searched — ` +
          `absence here is not evidence the file does not exist.${scanNote}`
        );
      }

      const withMtime = matched.map((rel) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(rootDir, rel)).mtimeMs;
        } catch {
          /* raced with a delete; sort it oldest */
        }
        return { rel, mtimeMs };
      });
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const shown = withMtime.slice(0, cap);
      return (
        shown.map((entry, i) => `${String(i + 1).padStart(4)}  ${entry.rel}`).join("\n") +
        (withMtime.length > cap
          ? `\n\n[${withMtime.length - cap} more matching file(s) not shown. Narrow the pattern, `
            + `or pass a smaller "path" to search one directory at a time.]`
          : "") +
        scanNote
      );
    },
  },

  {
    name: "delete_path",
    description:
      "Remove a file or directory from the workspace by moving it into .inflynx/.trash/ " +
      "(gitignored, never indexed). Recoverable with move_path from the printed trash " +
      "path — this is not an irreversible rm.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to remove (workspace-relative or absolute)" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const target = ctx.resolvePath(String(args.path ?? ""));
      const root = ctx.workspaceRoot;

      if (target === root) {
        return { output: "Error: delete_path refuses to remove the workspace root itself.", isError: true };
      }
      const trashDir = path.join(root, TRASH_RELATIVE_PATH);
      if (target === trashDir || target.startsWith(trashDir + path.sep)) {
        return {
          output: "Error: that path is already in the trash. Emptying the trash is a human action.",
          isError: true,
        };
      }
      const gitDir = path.join(root, ".git");
      if (target === gitDir || target.startsWith(gitDir + path.sep)) {
        return {
          output: "Error: delete_path will not touch .git/ — that would destroy the repository's history.",
          isError: true,
        };
      }
      if (!fs.existsSync(target)) {
        return { output: `Error: nothing to delete at "${args.path}" — it does not exist.`, isError: true };
      }

      const isDir = fs.statSync(target).isDirectory();
      const staging = path.join(trashDir, ctx.sessionId || "session");
      fs.mkdirSync(staging, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const landed = path.join(staging, `${stamp}_${path.basename(target)}`);

      try {
        fs.renameSync(target, landed);
      } catch (err: any) {
        if (isDir || (err?.code !== "EXDEV" && err?.code !== "EPERM")) {
          return { output: `Error: could not move "${args.path}" to the trash: ${err?.message || err}`, isError: true };
        }
        // Different filesystem (e.g. a mounted volume): copy then unlink. Explicitly
        // reported, because "moved to trash" and "copied then removed" are different
        // guarantees about how fast and how recoverable this was.
        try {
          fs.copyFileSync(target, landed);
          fs.unlinkSync(target);
        } catch (copyErr: any) {
          return {
            output:
              `Error: cross-device delete of "${args.path}" failed after the rename did (${copyErr?.message}). ` +
              `The file is still in place — nothing was lost.`,
            isError: true,
          };
        }
        return `✓ Removed ${isDir ? "directory" : "file"} "${args.path}" (copied out of the trash staging area) — ${landed}`;
      }

      // Undo renames it straight back out of the trash, which is why deleting a directory
      // costs one entry rather than a copy of everything inside it.
      recordMove(ctx, target, landed);

      return (
        `✓ ${isDir ? "Directory" : "File"} "${args.path}" moved to the trash.\n` +
        `  recoverable at: ${path.relative(root, landed)} (via move_path)\n` +
        `  it no longer exists in the workspace and will not appear in searches or the index.`
      );
    },
  },

  {
    name: "move_path",
    description:
      "Move or rename a file or directory within the workspace. Moving onto an existing " +
      "path fails unless overwrite is true, so work is never silently replaced.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Existing file or directory" },
        to: { type: "string", description: "Destination path; an existing directory is treated as a target folder" },
        overwrite: { type: "boolean", description: "Replace the destination if it already exists", default: false },
      },
      required: ["from", "to"],
    },
    execute: async (args, ctx) => {
      const from = ctx.resolvePath(String(args.from ?? ""));
      let to = ctx.resolvePath(String(args.to ?? ""));
      const overwrite = args.overwrite === true;
      const root = ctx.workspaceRoot;

      if (!fs.existsSync(from)) {
        return { output: `Error: "${args.from}" does not exist, so it cannot be moved.`, isError: true };
      }
      if (from === to) return { output: "Error: source and destination are the same path.", isError: true };
      if (to.startsWith(from + path.sep)) {
        return { output: "Error: a directory cannot be moved inside itself.", isError: true };
      }
      const trashDir = path.join(root, TRASH_RELATIVE_PATH);
      if (to === trashDir || to.startsWith(trashDir + path.sep)) {
        return {
          output: "Error: the trash is not a destination — use delete_path to retire a file.",
          isError: true,
        };
      }

      if (fs.existsSync(to) && fs.statSync(to).isDirectory() && !fs.statSync(from).isDirectory()) {
        to = path.join(to, path.basename(from));
      }
      if (fs.existsSync(to) && !overwrite) {
        return {
          output:
            `Error: destination "${args.to}" already exists and overwrite is not set. ` +
            `Nothing was moved. Pass overwrite: true to replace it, or choose another name.`,
          isError: true,
        };
      }

      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.existsSync(to)) {
          // Explicit replacement: park the outgoing file in the trash first, so
          // `overwrite: true` cannot silently destroy work either.
          const staging = path.join(trashDir, ctx.sessionId || "session");
          fs.mkdirSync(staging, { recursive: true });
          const displaced = path.join(staging, `${Date.now()}_replaced_${path.basename(to)}`);
          fs.renameSync(to, displaced);
          fs.renameSync(from, to);
          // Two entries, so undo replays them in reverse: the replacement goes back to
          // `to` first, then `from` returns to where it was.
          recordMove(ctx, to, displaced);
          recordMove(ctx, from, to);
          return `✓ Moved ${path.relative(root, from)} → ${path.relative(root, to)}\n  replaced file kept at ${path.relative(root, displaced)}`;
        }
        fs.renameSync(from, to);
        recordMove(ctx, from, to);
        return `✓ Moved ${path.relative(root, from)} → ${path.relative(root, to)}`;
      } catch (err: any) {
        return { output: `Error: move failed: ${err?.message || err}. Nothing was changed.`, isError: true };
      }
    },
  },

  {
    name: "search_files",
    description: "Search for a text pattern or regex in workspace files. Excludes node_modules, .git, and build artifacts.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (string or regex)" },
        path: { type: "string", description: "Directory or file to search in", default: "." },
        file_glob: { type: "string", description: "File glob filter (e.g. '*.ts')", default: "" },
        case_insensitive: { type: "boolean", description: "Case insensitive search", default: false },
      },
      required: ["pattern"],
    },
    execute: async (args, ctx) => {
      const {
        pattern,
        path: searchPath = ".",
        file_glob = "",
        case_insensitive = false,
      } = args as { pattern: string; path?: string; file_glob?: string; case_insensitive?: boolean };

      const absPath = ctx.resolvePath(searchPath);

      // The description has always said "Directory or file to search in". Searching a
      // file did not work: `absPath` was passed as the child's *working directory*, so a
      // file target made the spawn fail with ENOTDIR — an advertised surface that does the
      // opposite of what it claims (backlog N9, §7 item 8).
      if (!fs.existsSync(absPath)) {
        return {
          output:
            `Error: nothing to search at "${searchPath}" — that path does not exist. ` +
            `This is not "no matches"; the search never ran.`,
          isError: true,
        };
      }
      const searchIsDirectory = fs.statSync(absPath).isDirectory();
      const runCwd = searchIsDirectory ? absPath : path.dirname(absPath);
      const shownName = path.relative(ctx.workspaceRoot, absPath) || ".";

      // Safe argument-array execution for rg (ripgrep)
      const rgArgs: string[] = [
        "--line-number",
        "--no-heading",
        "--max-count=50",
        "--max-columns=240",
        "--glob=!node_modules/**",
        "--glob=!.git/**",
        "--glob=!dist/**",
      ];
      if (case_insensitive) rgArgs.push("-i");
      if (file_glob) rgArgs.push("--glob", file_glob);
      rgArgs.push("--", pattern, absPath);

      // Safe argument-array execution for grep fallback
      const grepArgs: string[] = [
        "-rn",
        "--max-count=50",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
      ];
      if (case_insensitive) grepArgs.push("-i");
      if (file_glob) grepArgs.push(`--include=${file_glob}`);
      grepArgs.push("--", pattern, absPath);

      // Exit codes mean different things and the model has to be told which one
      // happened. Previously every non-zero came back as "No matches found", so a bad
      // regex or an unreadable path produced a confident wrong conclusion — the single
      // most damaging thing a search tool can do (backlog E4).
      const format = (raw: string) => {
        const lines = raw.split("\n").filter((line) => line.trim().length > 0);
        if (lines.length === 0) return "";
        const shown = lines.slice(0, MAX_SEARCH_RESULT_LINES);
        const rel = (line: string) => line.replaceAll(`${absPath}/`, "").replaceAll(absPath, shownName);
        return (
          shown.map(rel).join("\n") +
          (lines.length > shown.length
            ? `\n\n[${lines.length - shown.length} more matching line(s) not shown. Narrow the ` +
              `pattern or pass file_glob to see less.]`
            : "")
        );
      };

      const rg = await CommandPolicy.execProcessDirectDetailed("rg", rgArgs, runCwd, 15_000, ctx.signal);
      if (rg.spawnError === "ABORTED") return { output: "Error: Search was cancelled.", isError: true };

      if (rg.spawnError !== "ENOENT") {
        if (rg.exitCode === 0) {
          const body = format(rg.output);
          return body || `No matches found for: ${pattern}`;
        }
        if (rg.exitCode === 1) {
          return `No matches found for: ${pattern} (searched ${shownName}${
            file_glob ? `, ${file_glob}` : ""
          } — rg ran successfully and matched nothing)`;
        }
        return {
          output:
            `Error: search failed rather than finding nothing — the pattern may not be a valid ` +
            `regex, or a path may be unreadable. rg exited ${rg.exitCode}:\n${(rg.output || "(no stderr)").trim()}`,
          isError: true,
        };
      }

      // ripgrep is not installed: fall back to grep, with the same exit-code honesty.
      const grep = await CommandPolicy.execProcessDirectDetailed("grep", grepArgs, runCwd, 15_000, ctx.signal);
      if (grep.spawnError === "ABORTED") return { output: "Error: Search was cancelled.", isError: true };
      if (grep.spawnError === "ENOENT") {
        return {
          output: "Error: neither rg (ripgrep) nor grep is available on this machine, so search_files cannot run.",
          isError: true,
        };
      }
      if (grep.exitCode === 0) return format(grep.output) || `No matches found for: ${pattern}`;
      if (grep.exitCode === 1) return `No matches found for: ${pattern} (searched ${shownName} — grep ran and matched nothing)`;
      return {
        output:
          `Error: search failed rather than finding nothing — the pattern may not be a valid ` +
          `regex, or a path may be unreadable. grep exited ${grep.exitCode}:\n${(grep.output || "(no stderr)").trim()}`,
        isError: true,
      };
    },
  },

  {
    name: "web_search",
    description: "Search Google/DuckDuckGo live on the internet for documentation, packages, news, or error solutions.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query keywords" },
        max_results: { type: "number", description: "Max results to return (1-10)", default: 5 },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      const { query, max_results = 5 } = args as { query: string; max_results?: number };
      const results: Array<{ title: string; link: string; snippet: string }> = [];

      // Strategy 1: Serper API if available
      const serperKey = process.env.SERPER_API_KEY;
      if (serperKey) {
        try {
          const res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: max_results }),
          });
          if (res.ok) {
            const data: any = await res.json();
            if (Array.isArray(data.organic)) {
              for (const item of data.organic.slice(0, max_results)) {
                results.push({ title: item.title, link: item.link, snippet: item.snippet });
              }
            }
          }
        } catch { /* fallback */ }
      }

      // Strategy 2: Universal HTML scraping via curl
      if (results.length === 0) {
        try {
          const encoded = encodeURIComponent(query);
          const html = await CommandPolicy.execProcessDirect(
            "curl",
            [
              "-sL",
              "-m", "8",
              `https://html.duckduckgo.com/html/?q=${encoded}`,
              "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ],
            // `ctx.workspaceRoot`, not `process.cwd()`: a tool must not reach for a
            // process-wide directory when the session already told it where it lives.
            ctx.workspaceRoot,
            10_000,
            ctx.signal
          );

          const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let match: RegExpExecArray | null;

          while ((match = linkRegex.exec(html)) !== null && results.length < max_results) {
            let rawUrl = match[1].trim();
            if (rawUrl.includes("uddg=")) {
              const matchUddg = rawUrl.match(/uddg=([^&]+)/);
              if (matchUddg) rawUrl = decodeURIComponent(matchUddg[1]);
            }
            if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;

            const title = stripHtmlTags(match[2]);
            const isExternalUrl = rawUrl.startsWith("http") &&
              !rawUrl.includes("duckduckgo.com") &&
              !rawUrl.includes("google.com") &&
              !rawUrl.includes("bing.com");

            if (title && title.length > 5 && isExternalUrl) {
              if (!results.some((r) => r.link === rawUrl)) {
                results.push({
                  title,
                  link: rawUrl,
                  snippet: title,
                });
              }
            }
          }
        } catch { /* fallback */ }
      }

      // Strategy 3: DuckDuckGo Instant Answer API
      if (results.length === 0) {
        try {
          const apiRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
          if (apiRes.ok) {
            const data: any = await apiRes.json();
            if (data.AbstractText && data.AbstractURL) {
              results.push({ title: data.Heading || query, link: data.AbstractURL, snippet: data.AbstractText });
            }
            if (Array.isArray(data.RelatedTopics)) {
              for (const topic of data.RelatedTopics) {
                if (results.length >= max_results) break;
                if (topic.Text && topic.FirstURL) {
                  results.push({ title: topic.Text.slice(0, 80) + "...", link: topic.FirstURL, snippet: topic.Text });
                }
              }
            }
          }
        } catch { /* fallback */ }
      }

      if (results.length === 0) {
        return `No live web search results found for query: "${query}". Try refining search terms.`;
      }

      return wrapUntrusted("web_search", results
        .slice(0, max_results)
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet}`)
        .join("\n\n"));
    },
  },

  {
    name: "fetch_url",
    description: "Fetch web page content from a public URL and convert HTML to clean readable text.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public URL to fetch (http or https)" },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const { url } = args as { url: string };
      try {
        const publicUrl = await validatePublicUrl(url);
        const response = await fetch(publicUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          },
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          throw new Error("Redirects are disabled by SSRF protection; validate the redirect target explicitly.");
        }
        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const text = stripHtmlTags(html);
        const truncated = text.length > 12_000 ? text.slice(0, 12_000) + "\n\n... (truncated for context length)" : text;

        return wrapUntrusted(`web page ${publicUrl.toString()}`, `Content from ${publicUrl.toString()}:\n\n${truncated}`);
      } catch (err: any) {
        return `Failed to fetch URL ${url}: ${err?.message || String(err)}`;
      }
    },
  },

  {
    name: "execute_shell",
    description: "Execute a shell command in the workspace. Returns stdout and stderr. 30 second timeout.",
    permissionLevel: "shell",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Command line for a real shell (/bin/bash -lc). Pipelines, &&/||, ; , redirections, " +
            "quoting, globs and $VAR all work. Each call starts in `cwd`; use `cd x && …` to move.",
        },
        cwd: { type: "string", description: "Working directory for the command", default: "." },
        timeout_ms: {
          type: "number",
          description: `Kill the whole process group after this many ms (default ${DEFAULT_SHELL_TIMEOUT_MS}, max ${MAX_SHELL_TIMEOUT_MS}). Long installs and builds are fine; ask for more instead of splitting a command.`,
        },
        background: {
          type: "boolean",
          description:
            "Return immediately with a shell id instead of waiting. For anything that does not " +
            "terminate on its own — a dev server, a watcher, `docker compose up`. Read its log with " +
            "shell_output and stop it with shell_stop. Omit it for build/test/install, which should " +
            "be awaited.",
          default: false,
        },
      },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const {
        command,
        cwd: cmdCwd = ".",
        timeout_ms = DEFAULT_SHELL_TIMEOUT_MS,
        background = false,
      } = args as { command: string; cwd?: string; timeout_ms?: number; background?: boolean };

      const absCwd = ctx.resolvePath(cmdCwd);

      if (background) {
        // Policy was already applied by the gateway for this exact command line; a
        // backgrounded command is the same command with a longer leash, not a
        // less-reviewed one.
        const started = ctx.shells.start(command, absCwd);
        return {
          output:
            `✓ Backgrounded as ${started.id} (pid ${started.pid ?? "?"}) in ${absCwd}\n` +
            `  shell_output({ shell_id: "${started.id}", since: 0 }) reads its log;\n` +
            `  shell_stop({ shell_id: "${started.id}" }) ends the whole process group.\n` +
            `  it will be killed automatically at ${BACKGROUND_SHELL_MAX_LIFETIME_MS.toLocaleString()}ms.\n` +
            (started.preview.trim()
              ? `\n--- first output ---\n${started.preview}`
              : "\n(no output captured yet — poll shell_output)"),
          isError: false,
        };
      }

      const result = await CommandPolicy.runShellLine(command, absCwd, {
        timeoutMs: Math.min(Math.max(1_000, timeout_ms || DEFAULT_SHELL_TIMEOUT_MS), MAX_SHELL_TIMEOUT_MS),
        signal: ctx.signal,
      });

      // Policy lives in the gateway (`reviewShellCommand`), never here: this is the
      // execution layer, and a second copy of the rules is a second thing to get wrong.
      return {
        output: result.output,
        // A non-zero exit is reported, not thrown — the report *is* the useful part.
        isError: result.exitCode !== 0 || result.timedOut || result.aborted,
        exitCode: result.exitCode,
      };
    },
  },

  {
    name: "shell_output",
    description:
      "Read a background shell's log from a byte offset, returning only what is new. " +
      "Pass the next_offset from the previous call as `since` to avoid resending output " +
      "you already have (and your context).",
    permissionLevel: "readonly",
    isMutating: false,
    // Explicitly NOT cacheable: this is a live, offset-based read. Deduplicating it
    // would hand back a stale log and the caller would never see the server come up.
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "The id returned by execute_shell({ background: true })" },
        since: { type: "number", description: "Byte offset to read from; 0 reads everything still retained", default: 0 },
      },
      required: ["shell_id"],
    },
    execute: async (args, ctx) => {
      const shellId = String(args.shell_id ?? "");
      const since = Number(args.since ?? 0);
      const read = ctx.shells.read(shellId, Number.isFinite(since) ? Math.max(0, since) : 0);
      if (!read) {
        const known = ctx.shells.list().map((s) => s.id).join(", ");
        return {
          output:
            `Error: no background shell "${shellId}" in this session. `
            + (known ? `Known: ${known}.` : "None have been started here."),
          isError: true,
        };
      }

      const head = read.droppedPrefix
        ? `[${read.droppedPrefixBytes.toLocaleString()} earlier bytes were dropped from the ` +
          `${BACKGROUND_SHELL_RETENTION_BYTES.toLocaleString()}-byte retention buffer; this starts at ` +
          `the oldest retained output.]\n`
        : "";
      const status = read.running
        ? "running"
        : `exited (code ${read.exitCode}${read.signal ? `, ${read.signal}` : ""}${read.terminatedReason ? `, ${read.terminatedReason}` : ""})`;

      return (
        `${head}${read.text || "(no new output)"}\n\n` +
        `[${status} · next_offset=${read.nextOffset}` +
        (read.running ? " · poll again with since=" + read.nextOffset : "") + "]"
      );
    },
  },

  {
    name: "shell_list",
    description:
      "List this session's background shells with their state. Use it after a context " +
      "compaction or a resumed session, when the ids from earlier are no longer visible.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: false,
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_args, ctx) => {
      const shells = ctx.shells.list();
      if (shells.length === 0) return "No background shells have been started in this session.";
      return shells
        .map((s) => {
          const state = s.endedAt === undefined
            ? `running (pid ${s.pid ?? "?"}, ${((Date.now() - s.startedAt) / 1000).toFixed(0)}s, ${s.totalBytes.toLocaleString()} bytes)`
            : `exited (code ${s.exitCode}${s.signal ? `, ${s.signal}` : ""}${s.terminatedReason ? `, ${s.terminatedReason}` : ""})`;
          return `  ${s.id}  ${state}\n    $ ${s.command}\n    cwd ${s.cwd}`;
        })
        .join("\n");
    },
  },

  {
    name: "shell_stop",
    description:
      "Stop a background shell and its whole process group (SIGTERM, escalating to " +
      "SIGKILL after 2s). Idempotent; already-exited shells are reported, not re-killed.",
    permissionLevel: "readonly",
    // Stopping is a *reduction* in capability, and requiring approval for cleanup
    // would push callers to leave processes running instead. It cannot touch another
    // session's shells: the registry is per-session and an unknown id fails closed.
    isMutating: false,
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "The shell to stop" },
      },
      required: ["shell_id"],
    },
    execute: async (args, ctx) => {
      const shellId = String(args.shell_id ?? "");
      const existing = ctx.shells.get(shellId);
      if (!existing) {
        const known = ctx.shells.list().map((s) => s.id).join(", ");
        return {
          output: `Error: no background shell "${shellId}" in this session.${known ? ` Known: ${known}.` : " None started."}`,
          isError: true,
        };
      }
      if (existing.endedAt !== undefined) {
        return `Shell ${shellId} had already exited (code ${existing.exitCode}${existing.terminatedReason ? `, ${existing.terminatedReason}` : ""}); nothing to stop.`;
      }
      ctx.shells.stop(shellId);
      return (
        `✓ Stopped ${shellId} — ${existing.command}\n` +
        `  its process group was signalled; allow a moment for the port to be released.`
      );
    },
  },

  {
    // Phase 19: sub-agent delegation. Runs a nested, budget-limited, read-only exploration in its
    // own context and returns a distilled summary, so "find all call sites of X" costs the parent
    // one result instead of dozens of reads in the main window. The runner is supplied by the
    // owning orchestrator via the execution context — the tool itself is stateless and shared-safe.
    name: "delegate",
    description:
      "Delegate a self-contained exploration/research sub-task to a bounded sub-agent that reads " +
      "files in its own context and returns a short distilled summary (≤ 2 KB). Use it for " +
      "'find all call sites of X', 'summarize how this module works', or any investigation whose " +
      "intermediate reads would bloat the main transcript. The sub-agent cannot edit or run the shell.",
    permissionLevel: "readonly",
    isMutating: false,
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "A precise, self-contained question or exploration task for the sub-agent.",
        },
      },
      required: ["task"],
    },
    execute: async (args, ctx) => {
      if (!ctx.runSubAgent) {
        return { output: "Error: delegation is unavailable in this execution context.", isError: true };
      }
      const task = String(args.task ?? "").trim();
      if (!task) return { output: "Error: delegate requires a non-empty `task`.", isError: true };
      const summary = await ctx.runSubAgent(task);
      return `Delegated sub-task complete. Distilled result:\n\n${summary}`;
    },
  },

  GIT_TOOL,
  UPDATE_PLAN_TOOL,
  LIST_DIAGNOSTICS_TOOL,
  LIST_SYMBOLS_TOOL,
  FIND_DEFINITION_TOOL,
];

// ─── Registry Class ────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = CORE_TOOLS) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listByOrigin(origin: "core" | "mcp" | "plugin"): ToolDefinition[] {
    return this.list().filter((t) => (t.origin || "core") === origin);
  }

  /** Returns JSON schema array formatted for OpenAI/DeepSeek tool_choice */
  toOpenAIFormat(): object[] {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Returns XML tool list for Anthropic system prompt injection */
  toAnthropicSystemPromptBlock(): string {
    return this.list()
      .map((t) => {
        const props = Object.entries(t.parameters.properties)
          .map(([k, v]) => `  - ${k} (${v.type}${t.parameters.required.includes(k) ? ", required" : ""}): ${v.description}`)
          .join("\n");
        return `<tool name="${t.name}">\n${t.description}\nParameters:\n${props}\n</tool>`;
      })
      .join("\n\n");
  }
}

export async function executeTool(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const start = Date.now();
  const tool = registry.get(call.name);

  if (!tool) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: `Error: Unknown tool "${call.name}"`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }

  const parsedArgs = safeParseJsonArgs(call.args);

  try {
    const executed = await tool.execute(parsedArgs, ctx);
    const output = typeof executed === "string" ? executed : executed.output;
    const isError = typeof executed === "string" ? false : executed.isError === true;
    return {
      toolCallId: call.id,
      toolName: call.name,
      output,
      isError,
      durationMs: Date.now() - start,
      ...(typeof executed === "object" && executed.exitCode !== undefined
        ? { exitCode: executed.exitCode }
        : {}),
      // Structured payloads survive to the caller deliberately. The alternative is every
      // consumer parsing `output`, which is written for the model and gets truncated.
      ...(typeof executed === "object" && executed.plan ? { plan: executed.plan } : {}),
    };
  } catch (err: any) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: `Error: ${err?.message || String(err)}`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }
}

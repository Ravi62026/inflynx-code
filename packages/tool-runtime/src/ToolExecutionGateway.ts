import { checkRateLimit } from "@inflynx/cache";
import fs from "node:fs";
import path from "node:path";
import {
  formatPatchSafetyForUser,
  reviewPatchSafety,
  TurnCheckpointStore,
  type PatchSafetyReview,
} from "@inflynx/patch-engine";
import { CanonicalPathGuard, reviewShellCommand, appendShellAudit, validatePublicUrl, hashShellOutput, type ShellApprovalSource, type ShellCommandReview } from "@inflynx/policy-engine";
import { ToolRegistry, executeTool, createToolExecutionContextFromGuard, ShellRegistry, type ToolCall, type ToolResult, type ToolDefinition, type ToolExecutionContext, type ToolExecutionMode } from "./index.js";
import { classifyGitInvocation } from "./git-tools.js";

/** Non-string-tolerant cast for an argv array the model handed in. */
function toStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((a) => String(a)) : [];
}

export interface GatewayExecutionOptions {
  activeMode?: ToolExecutionMode;
  maxTimeoutMs?: number;
  /** Stable caller/session identity used to isolate Redis tool buckets. */
  sessionId?: string;
  toolRateLimit?: {
    limit: number;
    windowSec: number;
  };
  /**
   * Character ceiling for this call's result. Falls back to
   * `DEFAULT_MAX_TOOL_OUTPUT_CHARS` when unset.
   */
  maxOutputChars?: number;
  /**
   * How a shell command that reached this point was cleared to run, for the audit
   * log. "The rules said allow" and "a human clicked approve" are very different
   * records, and only the second one is worth re-reading after an incident.
   */
  shellApprovalSource?: ShellApprovalSource;
  /**
   * Says a human was shown a fake-fix violation and agreed to proceed anyway
   * (backlog Phase 32). Absent means the gate enforces: a patch that suppresses a
   * diagnostic or deletes tests is refused, not silently applied.
   */
  patchApprovalSource?: "user:prompt" | "user:override-patch-safety";
}

/**
 * Default ceiling for a single tool result.
 *
 * Before this existed the only size limit in the whole pipeline was `fetch_url`
 * (12k chars), so one `read_file` of a 1 MB source file — which `read_file`
 * happily allows — dropped ~250k tokens into the conversation and left them
 * there for every later turn (backlog D3).
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 25_000;

/**
 * Approval sources that mean "a person, or an explicit operator flag, agreed to this
 * exact command". `rule:allow` is deliberately not in here — the rule engine already
 * got its say, and an `ask` verdict means the rules did *not* clear it.
 *
 * Known gap: `user:prompt` covers the interactive approvers, and the server's
 * `INFLYNX_AUTO_APPROVE` launch flag currently reports through the same approval
 * handler, so it is recorded as a prompt rather than as `flag:auto-approve`. Distinguishing
 * them needs the approval source to come from the handler itself — tracked with
 * Phase 47's protocol work rather than papered over here.
 */
const SHELL_HUMAN_SOURCES: ReadonlySet<string> = new Set([
  "user:prompt",
  "user:session-rule",
  "flag:auto-approve",
]);

/**
 * Builds a fake-fix review for whichever file-mutating tool is running (Phase 32).
 *
 * Every tool states an edit differently and the enforcement must see the same thing
 * whichever way it arrives: a before/after pair for one path. `delete_path` is the odd
 * one — its "after" is emptiness, so it is reported as a deletion, which is what lets a
 * deleted test file be caught by name rather than by diff.
 *
 * Returns null for anything that is not a content edit, so unrelated mutating tools are
 * unaffected.
 */
export function reviewMutatingPatchForSafety(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  io: { readGuarded: (relPath: string) => string }
): PatchSafetyReview | null {
  const target = typeof args.path === "string" ? args.path : undefined;
  if (!target) return null;

  switch (tool.name) {
    case "patch_file": {
      const before = typeof args.target_code === "string" ? args.target_code : "";
      const after = typeof args.replacement_code === "string" ? args.replacement_code : "";
      if (!before && !after) return null;
      return reviewPatchSafety({ filePath: target, before, after });
    }
    case "write_file": {
      const after = typeof args.content === "string" ? args.content : "";
      // The whole previous file is the baseline, so an edit that quietly drops a hundred
      // assertions is caught even though this tool has no "target snippet" concept.
      return reviewPatchSafety({ filePath: target, before: io.readGuarded(target), after });
    }
    case "edit_file": {
      const edits = Array.isArray(args.edits) ? (args.edits as Array<{ oldText?: string; newText?: string }>) : [];
      if (edits.length === 0) return null;
      // Reviewed as the single resulting pair, not per edit: a fake fix spread across four
      // hunks must not look like four safe edits.
      const before = io.readGuarded(target);
      let after = before;
      for (const e of edits) {
        if (typeof e?.oldText === "string" && typeof e?.newText === "string" && after.includes(e.oldText)) {
          after = after.replace(e.oldText, e.newText);
        }
      }
      return reviewPatchSafety({ filePath: target, before, after });
    }
    case "delete_path":
      return reviewPatchSafety({
        filePath: target,
        before: io.readGuarded(target),
        after: "",
        deletesFile: true,
      });
    default:
      return null;
  }
}

/**
 * Below this size a repeat read is *not* deduplicated.
 *
 * The pointer costs a couple of hundred characters, so for a small result serving
 * it would use more tokens than the content it replaces — and withhold something
 * the model may genuinely need again. The dedupe exists to kill 20 KB file re-reads,
 * not to be clever about 30-byte ones.
 */
export const MIN_CACHED_RESULT_CHARS = 2_000;

/**
 * Keeps the head and the tail of an oversized result with an explicit, model-
 * readable marker. Head+tail is deliberate: for build/test output the failure is
 * usually at the end, and for file reads the shape of the file is at the start.
 */
export function capToolOutput(
  result: ToolResult,
  maxChars: number = DEFAULT_MAX_TOOL_OUTPUT_CHARS
): ToolResult {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return result;
  if (result.output.length <= maxChars) return result;

  const total = result.output.length;
  const headChars = Math.max(0, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(0, Math.floor(maxChars * 0.3));
  const omitted = total - headChars - tailChars;

  const capped =
    result.output.slice(0, headChars) +
    `\n\n… [Inflynx truncated this tool result: ${omitted.toLocaleString()} of ${total.toLocaleString()} ` +
    `characters omitted. Re-run with a narrower path, line range, or search pattern to retrieve exactly ` +
    `what you need.] …\n\n` +
    result.output.slice(total - tailChars);

  return { ...result, output: capped, truncated: true };
}

/**
 * @inflynx/tool-runtime — ToolExecutionGateway
 * 
 * Centralized tool execution gateway that enforces security policy,
 * canonical path boundaries, shell command rules, and mode permissions
 * before tool invocation.
 */
export class ToolExecutionGateway {
  private pathGuard: CanonicalPathGuard;

  /**
   * Identical read calls made *within one turn*, keyed on tool + resolved args.
   *
   * Scope is deliberately the narrowest thing that is provably safe:
   * - Within a turn the model has already been sent the first result, so a pointer
   *   to it is enough and the repeat payload is pure waste.
   * - Across turns it is not safe without knowing what the provider has been shown,
   *   because eviction can have dropped the original — which would leave the model
   *   with a pointer to nothing. So `beginToolTurn()` clears it, and the
   *   orchestrator calls `invalidateTurnCache()` whenever eviction empties a tool
   *   result.
   * - Any successful mutating tool clears it too, so a read after an edit can never
   *   be answered from the pre-edit snapshot.
   */
  private turnCache = new Map<string, { chars: number; at: number }>();

  /**
   * One background-shell registry per session (the gateway is per-session), so
   * `shell_stop` cannot be pointed at another workspace's process and the list a
   * session can see matches the one it started.
   */
  readonly shells: ShellRegistry;

  /**
   * One undo journal per session, recording a reverse patch per file a turn changes. The
   * orchestrator opens the turn (`beginTurn`) and closes it (`commitTurn`); the tools only
   * ever call `recordEdit`/`recordMove`, and quietly do nothing when no turn is open.
   */
  readonly checkpoints: TurnCheckpointStore;

  constructor(workspaceRoot: string = process.cwd()) {
    this.pathGuard = new CanonicalPathGuard(workspaceRoot);
    this.shells = new ShellRegistry();
    this.checkpoints = new TurnCheckpointStore(this.pathGuard);
  }

  /**
   * Terminates every background shell this session owns. Returns how many were still
   * running, so a shutdown message can say what it actually did.
   *
   * Callers must treat this as mandatory: `detached` children outlive the parent by
   * design, so a session that exits without reaping leaves a dev server holding the
   * port and a model that cannot start its own.
   */
  shutdownShells(): number {
    return this.shells.reapAll("reaped");
  }

  /**
   * Reads a workspace file *through this session's guard*, returning "" for anything it
   * would not let a tool touch. Used to build the before-side of a fake-fix review, and
   * exported rather than reimplemented by callers so there is only ever one path
   * authority — the mistake that made backlog N6 possible.
   */
  readGuardedText(relPath: string): string {
    try {
      const abs = this.pathGuard.validateAndResolve(relPath);
      return fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8") : "";
    } catch {
      return "";
    }
  }

  /** Start of a new agentic turn: nothing from the previous turn is assumed visible. */
  beginToolTurn(): void {
    this.turnCache.clear();
  }

  /** Drop cached read pointers because the results they point at may be gone. */
  invalidateTurnCache(): void {
    this.turnCache.clear();
  }

  /**
   * One line per shell execution (and per refusal) in `.inflynx/audit/shell.jsonl`.
   *
   * Best-effort by design: an audit failure warns and lets the command proceed, since
   * a logging bug must not surface as a mysterious build failure. See the module doc
   * in policy-engine/shell-audit.ts for why the pairing with the rule engine is not
   * optional.
   */
  private auditShell(
    options: GatewayExecutionOptions,
    review: ShellCommandReview,
    outcome: {
      approvedBy: ShellApprovalSource;
      exitCode?: number | null;
      durationMs?: number;
      output?: string;
      cwd?: string;
      error?: string;
    }
  ): void {
    appendShellAudit(this.pathGuard.getWorkspaceRoot(), {
      ts: Date.now(),
      sessionId: options.sessionId,
      cwd: outcome.cwd || this.pathGuard.getWorkspaceRoot(),
      command: review.command,
      decision: review.decision,
      approvedBy: outcome.approvedBy,
      verdicts: review.verdicts.map((v) => ({ text: v.text, decision: v.decision, reason: v.reason })),
      features: review.features,
      exitCode: outcome.exitCode ?? null,
      durationMs: outcome.durationMs,
      error: outcome.error,
      ...(outcome.output ? hashShellOutput(outcome.output) : {}),
    });
  }

  get cachedToolCalls(): number {
    return this.turnCache.size;
  }

  /**
   * Returns the canonical path guard associated with this gateway.
   */
  getPathGuard(): CanonicalPathGuard {
    return this.pathGuard;
  }

  /**
   * Executes a tool call through central policy validation gates.
   */
  async executeGuarded(
    registry: ToolRegistry,
    call: ToolCall,
    options: GatewayExecutionOptions = {},
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const startMs = Date.now();
    const mode = options.activeMode || "agent";
    const tool = registry.get(call.name);

    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Error: Security/Runtime Error: Unknown tool "${call.name}"`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // 1. Enforce Mode Permissions
    if (mode === "ask" && (tool.isMutating || tool.permissionLevel === "shell")) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Error: Security Policy Violation: Tool "${call.name}" is blocked in [ask] mode (read-only mode).`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // 1b. External tools are refused outside [agent]/[debug], whatever they claim to
    // be. `readOnlyHint` is supplied by the server being trusted, so it cannot be the
    // thing that grants it a free pass; and offering the tool at all is decided by
    // `filterToolsForMode`, which is a UX filter, not a control (backlog B9).
    if ((tool.origin === "mcp" || tool.origin === "plugin") && mode !== "agent" && mode !== "debug") {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output:
          `Error: Security Policy Violation: External tool "${call.name}" ` +
          `(from ${tool.origin === "mcp" ? `MCP server "${tool.serverName || "unknown"}"` : "a plugin"}) ` +
          `cannot run in [${mode}] mode. Ask the user to switch to [agent] to run third-party code.`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    if (mode === "plan" && tool.permissionLevel === "shell") {
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: `Error: Security Policy Violation: Shell tool "${call.name}" is blocked in [plan] mode.`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // Shell, network, and MCP tools are the highest-risk/highest-cost tool
    // classes. Apply a Redis-backed bucket before any external side effect.
    // The cache package fails open when Redis is unavailable, preserving the
    // local CLI fallback behavior without bypassing the check when Redis
    // is healthy.
    if (
      tool.permissionLevel === "shell" ||
      tool.origin === "mcp" ||
      tool.name === "web_search" ||
      tool.name === "fetch_url"
    ) {
      const rateLimit = options.toolRateLimit || { limit: 30, windowSec: 60 };
      const bucket = await checkRateLimit(
        `tool:${options.sessionId || "anonymous"}:${tool.name}`,
        rateLimit.limit,
        rateLimit.windowSec
      );
      if (!bucket.allowed) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          output:
            `Error: Security Policy Rate Limit: Tool "${call.name}" exceeded ` +
            `${bucket.limit} calls in ${rateLimit.windowSec}s. Retry in ${bucket.resetInSec}s.`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
    }

    // 2. Validate Path Arguments via CanonicalPathGuard
    const args = { ...call.args };
    // Every argument that *names a place* must appear here. A path-shaped arg that is
    // not in this list is never canonicalised, never checked against the workspace
    // boundary, and — worst — is invisible to the [plan] mode fence below, which only
    // inspects resolved values. Adding a tool with `from`/`to`/`source`-style args
    // without extending this list silently disables its sandboxing, so the list is
    // deliberately wide and asserted by a test.
    const pathKeys = [
      "path", "filePath", "targetFile", "target_file", "cwd", "dirPath",
      "from", "to", "source", "destination", "old_path", "new_path",
      "oldPath", "newPath", "target_path", "targetPath", "file", "dir",
    ];

    for (const key of pathKeys) {
      if (typeof args[key] === "string" && args[key]) {
        try {
          args[key] = this.pathGuard.validateAndResolve(args[key] as string);
        } catch (err: any) {
          return {
            toolCallId: call.id,
            toolName: call.name,
            output: `Error: Security Policy Violation (${key}): ${err.message}`,
            isError: true,
            durationMs: Date.now() - startMs,
          };
        }
      }
    }

    // 2b. [plan] mode may only write under .inflynx/ — enforced in code, not in
    //     prose (backlog B8). `filterToolsForMode` still exposes `write_file` in
    //     plan mode on purpose, because writing .inflynx/PLAN.md is the whole point
    //     of the mode; this fence is what makes exposing it safe.
    if (mode === "plan" && tool.isMutating) {
      // `git` is declared mutating so caches and fences treat it as able to write, but it
      // has no path argument to inspect: a path-only scan would wave `git commit` through
      // in [plan] mode and block a harmless `git status`. Grade the invocation instead.
      if (tool.name === "git") {
        const gitGrade = classifyGitInvocation(toStringArray(args.args)).grade;
        if (gitGrade !== "read-only") {
          return {
            toolCallId: call.id,
            toolName: call.name,
            output:
              `Error: [plan] mode can only inspect the repository, but \`git ${toStringArray(args.args)[0] || "?"}\` ` +
              `would change it. Ask the user to switch to [agent] mode to commit, checkout, reset or branch.`,
            isError: true,
            durationMs: Date.now() - startMs,
          };
        }
      } else {
      const planRoot = path.join(this.pathGuard.getWorkspaceRoot(), ".inflynx");
      for (const key of pathKeys) {
        const resolved = args[key];
        if (typeof resolved !== "string" || !resolved) continue;
        if (resolved === planRoot || resolved.startsWith(planRoot + path.sep)) continue;
        return {
          toolCallId: call.id,
          toolName: call.name,
          output:
            `Error: Security Policy Violation: [plan] mode can only write under .inflynx/, but "${call.args[key]}" ` +
            `resolves outside it. Ask the user to switch to [agent] mode to change source files.`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
      }
    }

    // Validate explicit network destinations as well. MCP tools and future
    // network-capable tools may expose a `url` argument even when they are not
    // one of the built-in web tools.
    if (typeof args.url === "string" && args.url) {
      try {
        args.url = (await validatePublicUrl(args.url)).toString();
      } catch (err: any) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          output: `Error: Security Policy Violation (url): ${err.message}`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
    }

    // 3. Shell policy: review, refuse denials, and record what was decided.
    //    The old control here was `validateShellCommand`, which banned shell syntax
    //    wholesale. The control is now a per-segment decision plus human approval
    //    (backlog E1/B16), and every execution leaves an audit line either way.
    const isShellTool = tool.permissionLevel === "shell" || call.name === "execute_shell";
    const shellCommand = isShellTool ? String(args.command || args.cmd || "") : "";
    const shellReview = isShellTool && shellCommand.trim() ? reviewShellCommand(shellCommand) : null;

    if (shellReview?.decision === "deny") {
      this.auditShell(options, shellReview, {
        approvedBy: "denied",
        error: shellReview.headline,
      });
      return {
        toolCallId: call.id,
        toolName: call.name,
        output:
          `Error: Command blocked by shell policy — ${shellReview.headline}.\n` +
          `${shellReview.userMessage}\n\n`
          + `This one is refused rather than offered for approval. If you are certain it is ` +
          `what the user asked for, they should run it in their own terminal.`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }
    
    // 3b. A command that needs a human may only run when the caller says a human
    //     agreed. Approval normally happens upstream in the orchestrator, so without
    //     this check any caller that invoked `executeGuarded` directly — a new UI, a
    //     test harness, a future code path — would get arbitrary command execution for
    //     free. Previously the operator ban made that unreachable, which is the one
    //     thing the ban was actually protecting.
    if (shellReview?.decision === "ask" && !SHELL_HUMAN_SOURCES.has(options.shellApprovalSource || "")) {
      this.auditShell(options, shellReview, {
        approvedBy: "denied",
        error: "approval-required-not-granted",
      });
      return {
        toolCallId: call.id,
        toolName: call.name,
        output:
          `Error: This command needs approval before it can run — ${shellReview.headline}.\n` +
          `${shellReview.userMessage}\n\n`
          + `The request was not routed through an approver. Pass a shellApprovalSource of ` +
          `"user:prompt" once a human has agreed to this exact command.`,
        isError: true,
        durationMs: Date.now() - startMs,
      };
    }

    // 3c. Anti-fake-fix enforcement (backlog Phase 32).
    //
    // Phase 31 made "done" mean the workspace's own gates passed, which created a new
    // incentive: silence the compiler, skip the test, assert `true`. That would make the
    // gate's green worth nothing, so a patch that only *hides* the problem is refused
    // here, at the same choke point as path and shell policy — not merely advised against
    // in a prompt. A human may still override, and that path is explicit and recorded.
    const safety = reviewMutatingPatchForSafety(tool, args, {
      readGuarded: (relPath: string) => this.readGuardedText(relPath),
    });
    if (safety && !safety.safe) {
      if (options.patchApprovalSource !== "user:override-patch-safety") {
        console.warn(
          `[gateway] refused a fake fix by ${call.name} on ${String(args.path || "?")}: ` +
          safety.violations.map((v) => v.rule).join(", ")
        );
        return {
          toolCallId: call.id,
          toolName: call.name,
          output:
            `Error: this edit was refused because it suppresses the problem instead of fixing it.\n\n`
            + formatPatchSafetyForUser(safety)
            + `\n\nFix the underlying defect. If you are confident the suppressed diagnostic is ` +
            `wrong (a genuine false positive), say so explicitly in your reply and ask the user to ` +
            `override — do not quietly re-attempt a variant.`,
          isError: true,
          durationMs: Date.now() - startMs,
        };
      }
      console.warn(
        `[gateway] ⚠ human overrode anti-fake-fix for ${call.name} on ${String(args.path || "?")}: ` +
        safety.violations.map((v) => v.rule).join(", ") + " — proceeding as approved"
      );
    }

    // 4. Repeat-read dedupe, on the *resolved* arguments so "src/app.ts" and
    //    "<root>/src/app.ts" are recognised as the same read.
    const cacheKey = this.cacheKeyFor(tool, args);
    if (cacheKey && args.force_refresh !== true) {
      const seen = this.turnCache.get(cacheKey);
      if (seen && seen.chars >= MIN_CACHED_RESULT_CHARS) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          output:
            `[cached] Exactly this ${call.name} call was already made earlier in this turn ` +
            `(${seen.chars.toLocaleString()} characters) and its result is still in your context, so it is ` +
            `not repeated here. Re-send the call with "force_refresh": true if you genuinely need a fresh ` +
            `copy — for example if you no longer see the original result.`,
          isError: false,
          durationMs: Date.now() - startMs,
          cached: true,
        };
      }
    }

    // 5. Delegate to tool execution with the session's single workspace authority.
    //    `this.pathGuard` is handed to the tool as-is, so a tool cannot re-resolve
    //    a path against a different root than the one validated above.
    const ctx: ToolExecutionContext = createToolExecutionContextFromGuard(this.pathGuard, {
      signal,
      sessionId: options.sessionId,
      mode,
      shells: this.shells,
      checkpoints: this.checkpoints,
    });
    const result = await executeTool(registry, { ...call, args }, ctx);

    // 6. Audit every shell execution — allowed-by-rule, approved-by-human, and failed
    //    alike. Refusals are recorded where they happen, above.
    if (shellReview) {
      this.auditShell(options, shellReview, {
        approvedBy:
          options.shellApprovalSource ||
          (shellReview.decision === "allow" ? "rule:allow" : "user:prompt"),
        exitCode: result.exitCode ?? (result.isError ? null : 0),
        durationMs: result.durationMs,
        output: result.output,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        error: result.isError ? result.output.slice(0, 400) : undefined,
      });
    }

    // An edit anywhere in the workspace invalidates every remembered read: the key
    // space is small and the wrong-direction error (stale content handed back as if
    // fresh) is exactly the kind of thing that makes an agent corrupt files.
    if (tool.isMutating && !result.isError) {
      this.turnCache.clear();
    } else if (cacheKey && !result.isError && args.force_refresh !== true) {
      // Always record: a small first read is worth remembering in case a later call
      // in the same turn is asked for after a bigger sibling made it worthwhile.
      this.turnCache.set(cacheKey, { chars: result.output.length, at: Date.now() });
    }

    // 6b. Tell the caller exactly which file this changed, so the verification gate
    //     can decide whether the turn really touched source code. Uses the already
    //     resolved args, so a plan-mode write to `.inflynx/PLAN.md` is correctly *not*
    //     a source edit while `src/../src/app.ts` is.
    if (tool.isMutating && !result.isError) {
      const planRoot = path.join(this.pathGuard.getWorkspaceRoot(), ".inflynx") + path.sep;
      for (const key of pathKeys) {
        const resolved = args[key];
        if (typeof resolved !== "string" || !resolved.startsWith("/")) continue;
        if (resolved === this.pathGuard.getWorkspaceRoot()) continue;
        result.touchedPath = resolved;
        result.touchedSourceFile = !resolved.startsWith(planRoot);
        break;
      }
    }

    // Applied centrally so every tool — core, MCP and anything added later —
    // inherits the same context-protection ceiling.
    return capToolOutput(result, options.maxOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  }

  /** Canonical dedupe key, or null when this call must always really execute. */
  private cacheKeyFor(tool: ToolDefinition, args: Record<string, unknown>): string | null {
    if (!tool.cacheable || tool.origin === "mcp" || tool.isMutating) return null;
    const significant = Object.keys(args)
      .filter((key) => key !== "force_refresh")
      .sort()
      .map((key) => `${key}=${JSON.stringify(args[key]) ?? String(args[key])}`)
      .join("&");
    return `${tool.name}|${significant}`;
  }
}

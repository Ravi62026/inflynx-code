/**
 * The `git` tool (backlog Phase 24).
 *
 * One tool taking an argument array rather than six tools taking strings: the model
 * already speaks `git`'s CLI, an argument array means no shell is ever involved, and the
 * read-only / mutating / refused decision has to be made per *invocation* anyway — which
 * is the same shape Phase 20 chose for the shell tool (classify, then gate) instead of a
 * static permission level on the tool.
 *
 * ## Why the refusals come before the allowlist
 *
 * An allowlist of subcommands is not a sandbox on its own, because git's *global* options
 * change which repository it acts on or what it executes:
 *
 * - `-C <dir>`, `--git-dir=`, `--work-tree=`, `--namespace=`, `--exec-path=` — operate
 *   outside this workspace. `git --git-dir=/someone/else/.git status` reads a repo the
 *   agent was never given.
 * - `-c key=value` — runs configuration as code. `core.fsmonitor`, `core.editor`,
 *   `sequence.editor`, `pager.cmd` and aliases all launch processes, so a "read-only"
 *   `git log -c core.pager=<attacker>` is arbitrary execution.
 * - `--output=` (`git diff`, `log`, `show`) — writes a file, bypassing every edit control,
 *   the diff preview and the undo journal.
 * - `-p` / `--patch` / `-i` / `--interactive` — wait for a terminal that will never answer,
 *   which reads as a hang rather than a refusal.
 * - `--no-verify` — skips the user's hooks; the shell rules already refuse that phrase, and
 *   the tool must not be a side door around them.
 *
 * Those are rejected for every call, allowlisted or not. What remains is graded.
 */

import { CommandPolicy } from "@inflynx/policy-engine";
import type { ToolDefinition } from "./index.js";

export type GitGrade = "read-only" | "mutating" | "refused";

export interface GitInvocationInfo {
  subcommand: string;
  grade: GitGrade;
  /** Why it was graded this way — shown to the human at approval time. */
  reason: string;
}

/** Subcommands that only read. Anything absent from this list is mutating → asks. */
const READ_ONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "describe", "rev-parse", "rev-list",
  "cat-file", "ls-files", "ls-tree", "ls-remote", "show-ref", "show-prefix",
  "abbrev-ref", "cherry", "cherry-pick", // NOTE: cherry-pick is mutating; kept out below
  "count-objects", "diff-index", "diff-tree", "for-each-ref", "grep",
  "merge-base", "name-rev", "reflog", "remote", "rerere", "shortlog", "stripspace",
  "verify-commit", "verify-pack", "verify-tag", "whatchanged",
]);
// `cherry-pick` is a genuine mutator; the list above is audited below at module init so a
// copy-paste slip cannot silently make it auto-approved.
READ_ONLY_SUBCOMMANDS.delete("cherry-pick");
READ_ONLY_SUBCOMMANDS.delete("rerere");
READ_ONLY_SUBCOMMANDS.delete("remote");

/** `remote`, `branch`, `tag`, `stash`, `config` and `worktree` read *or* write by flag. */
const MODE_DEPENDENT: Record<string, { readOnlyArgs: RegExp; note: string }> = {
  branch: { readOnlyArgs: /^(--list|-a|-r|-l|-v|--show-current|--format=|--all)$/, note: "listing branches" },
  tag: { readOnlyArgs: /^(--list|-l|--format=|--sort=)$/, note: "listing tags" },
  stash: { readOnlyArgs: /^(list|show)$/, note: "reading stashes (push/pop/drop would change them)" },
  config: { readOnlyArgs: /^(--get|--get-all|--list|-l|--show-origin|--show-scope)$/, note: "reading config" },
  worktree: { readOnlyArgs: /^list$/, note: "listing worktrees" },
  remote: { readOnlyArgs: /^(|-v|show|get-url)$/, note: "inspecting remotes" },
};

/**
 * Global options: git parses these only *before* the subcommand, and they can re-point or
 * re-configure the whole invocation — `--git-dir` to another repository, `-c` to run
 * configuration as code (`core.fsmonitor`, `core.pager`, aliases), `--work-tree` to write
 * outside the workspace. Checked against the leading option block only, because `git switch
 * -c new-branch` is a subcommand flag with the same spelling and nothing dangerous about it.
 */
const FORBIDDEN_GLOBALS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env",
]);

/**
 * Long options arrive in both `--opt value` and `--opt=value` forms, and an exact-match
 * set silently lets the second one through: `git --work-tree=/tmp commit` was graded
 * merely "mutating" and would have written outside the workspace. This is the classic
 * hole in flag denylists, so it gets one function rather than eight comparisons.
 */
function isForbiddenGlobal(arg: string): boolean {
  if (FORBIDDEN_GLOBALS.has(arg)) return true;
  const eq = arg.indexOf("=");
  return eq > 0 && FORBIDDEN_GLOBALS.has(arg.slice(0, eq));
}

/** Rejected wherever they appear: a file write, or a skipped safety hook. */
const FORBIDDEN_ANYWHERE: Array<{ match: (a: string) => boolean; why: string }> = [
  { match: (a) => a === "--output" || a.startsWith("--output="), why: "--output writes a file directly, past the diff preview, the guard and the undo journal" },
  { match: (a) => a === "--no-verify", why: "it skips your commit/merge hooks, which are a deliberate safety check" },
  { match: (a) => a === "--no-gpg-sign", why: "it disables signature checking configured for this repository" },
];

/**
 * `-p` / `-i` / `-e` mean "let a human drive this interactively" for these subcommands only.
 * For `log`/`diff`/`show`, `-p` merely means "include the patch" and refusing it would be
 * pure obstruction — the difference is exactly the line between a control and a nuisance.
 */
const INTERACTIVE_CAPABLE = new Set(["add", "apply", "checkout", "restore", "stash", "commit", "rebase", "amend"]);
const INTERACTIVE_FLAGS: Array<{ match: (a: string) => boolean; why: string }> = [
  { match: (a) => a === "-i" || a === "--interactive", why: "interactive mode waits for a terminal that will never answer" },
  { match: (a) => a === "-p" || a === "--patch" || a === "-P", why: "patch mode waits for a terminal that will never answer" },
  { match: (a) => a === "-e" || a === "--edit", why: "it opens an editor instead of finishing the call" },
];

/** Index of the subcommand: the first token that is not a global option or its value. */
function subcommandIndex(args: string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (isForbiddenGlobal(a) && !a.includes("=")) { i += 2; continue; }   // consume its value too
    if (a.startsWith("-")) { i++; continue; }
    return i;
  }
  return i;
}

/**
 * Environment for the git child. Each entry closes a specific hole rather than being
 * general hygiene:
 * - `GIT_TERMINAL_PROMPT=0` — a private remote asking for a password would otherwise hang
 *   until the timeout, which reads as a slow command rather than an unavailable one.
 * - `GIT_CONFIG_NOSYSTEM=1` — `/etc/gitconfig` is written by whoever installed git and can
 *   set `core.fsmonitor`, aliases or a pager: all of them program execution. The user's own
 *   `~/.gitconfig` is still honoured, because that one they chose.
 * - `GIT_PAGER`/`PAGER=cat`, `NO_COLOR` — no pager process is launched and no ANSI reaches
 *   the terminal the approval prompt is about to be printed on.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
  };
}

/**
 * Classifies an argument array. Pure — nothing runs here.
 */
export function classifyGitInvocation(args: string[]): GitInvocationInfo {
  const head = args.slice(0, subcommandIndex(args));
  for (const a of head) {
    if (isForbiddenGlobal(a)) {
      return {
        subcommand: args[subcommandIndex(args)] || "",
        grade: "refused",
        reason: `git's global ${a} option redirects which repository is used or runs configuration as code`,
      };
    }
  }
  for (const { match, why } of FORBIDDEN_ANYWHERE) {
    if (args.some(match)) {
      return { subcommand: args[0] || "", grade: "refused", reason: why };
    }
  }

  const sub = (args[subcommandIndex(args)] || "").trim();
  if (!sub) {
    return { subcommand: "", grade: "refused", reason: "no git subcommand was given" };
  }

  if (INTERACTIVE_CAPABLE.has(sub)) {
    for (const { match, why } of INTERACTIVE_FLAGS) {
      if (args.slice(subcommandIndex(args) + 1).some(match)) {
        return { subcommand: sub, grade: "refused", reason: why };
      }
    }
  }

  if (sub === "push") {
    const forced = args.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease");
    const targetsDefault = args.some((a) => /(^|:)(main|master|trunk)$/.test(a) || a === "HEAD");
    if (forced && targetsDefault) {
      return { subcommand: sub, grade: "refused", reason: "force-pushing a default branch can destroy shared history that others have built on" };
    }
    return { subcommand: sub, grade: "mutating", reason: forced ? "force-push to a non-default branch" : "publishes commits to a remote other people pull" };
  }

  if (READ_ONLY_SUBCOMMANDS.has(sub)) {
    return { subcommand: sub, grade: "read-only", reason: `${sub} only reads repository state` };
  }

  const modeDependent = MODE_DEPENDENT[sub];
  if (modeDependent) {
    const first = args[1] || "";
    if (modeDependent.readOnlyArgs.test(first)) {
      return { subcommand: sub, grade: "read-only", reason: `${sub} ${first} — ${modeDependent.note}` };
    }
    return { subcommand: sub, grade: "mutating", reason: `${sub} ${first || "(no argument)"} changes repository state` };
  }

  return { subcommand: sub, grade: "mutating", reason: `${sub} changes the working tree, the index or history` };
}

/** Is this argument list safe to run at all, before any cwd/path resolution? */
export function validateGitArgs(raw: unknown): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "git needs an 'args' array, e.g. [\"status\", \"--short\"]. A single command string is not accepted, because it invites shell parsing." };
  }
  const args = raw.map((a) => String(a));
  if (args.length === 0) return { ok: false, error: "git 'args' is empty — pass a subcommand, e.g. [\"status\"]." };
  if (args.some((a) => a.includes("\n") || a.includes("\0"))) {
    return { ok: false, error: "git arguments may not contain newlines or NUL bytes." };
  }
  return { ok: true, args };
}

/**
 * A short structured summary for the read-only commands the agent uses most, so it does
 * not have to re-parse `status` output to decide what to do next.
 */
function summarize(sub: string, out: string): string {
  const lines = out.split("\n").filter((l) => l.trim().length > 0);
  if (sub === "status") {
    const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, other: 0 };
    for (const l of lines) {
      const xy = l.slice(0, 2);
      if (xy === "??") counts.untracked++;
      else if (xy.includes("M")) counts.modified++;
      else if (xy.includes("A")) counts.added++;
      else if (xy.includes("D")) counts.deleted++;
      else if (xy.includes("R")) counts.renamed++;
      else counts.other++;
    }
    return `# ${counts.modified} modified, ${counts.added} added, ${counts.deleted} deleted, ` +
      `${counts.renamed} renamed, ${counts.untracked} untracked`;
  }
  if (sub === "log" || sub === "shortlog" || sub === "rev-list" || sub === "reflog") {
    return `# ${lines.length} commit line(s) shown`;
  }
  if (sub === "diff" || sub === "show") {
    // git already counts this precisely for --stat/--shortstat, so use its line rather
    // than re-deriving it from a format that does not contain patch text. An invented
    // "0 files changed" over a real diff is worse than no summary at all.
    const own = lines.find((l) => /\d+ files? changed/.test(l));
    if (own) return `# ${own.trim()}`;

    const files = new Set<string>();
    let plus = 0, minus = 0, sawPatch = false;
    for (const l of lines) {
      const f = /^diff --git a\/(.*?) b\//.exec(l);
      if (f) { files.add(f[1]); sawPatch = true; continue; }
      // `--name-only` and `--name-status` print one path per line with no `diff --git`
      // header at all, so the patch parser never fires on them. Name-mode is recognised
      // only when the output contains no patch header, which is what keeps real patch
      // text, `--stat` graph bars and `--shortstat` from being mis-read as file names.
      if (!sawPatch && !/^[ +-@]/.test(l)) {
        // `M\tpath`, and for a rename `R100\told\tnew` — two paths, one entry. Tokens are
        // filtered on looking like a path so the status score ("100") is not counted.
        for (const field of l.split("\t").slice(/^[A-Z]/.test(l) ? 1 : 0)) {
          if (field && /[/.]/.test(field)) files.add(field);
        }
        continue;
      }
      if (l.startsWith("+") && !l.startsWith("+++")) { plus++; sawPatch = true; }
      else if (l.startsWith("-") && !l.startsWith("---")) { minus++; sawPatch = true; }
    }
    // Name-mode listing, or an empty diff: report what is actually there rather than
    // claiming "0 files changed" for a listing that named files.
    if (!sawPatch) {
      return files.size > 0 ? `# ${files.size} file(s) listed` : "";
    }
    return `# ${files.size} file(s) changed, +${plus} / -${minus} line(s)`;
  }
  if (sub === "blame") return `# ${lines.length} blamed line(s)`;
  return "";
}

export const GIT_TOOL: ToolDefinition = {
  name: "git",
  description:
    "Run a git command in the workspace with an argument array (no shell is involved). " +
    "Read-only subcommands (status, diff, log, show, blame, ls-files, ...) run without " +
    "approval; anything that changes the tree, index, or history asks first. Global options " +
    "that would escape the workspace, execute config, or write files directly are always " +
    "refused, as is --no-verify. Prefer `git diff` to review your own turn and " +
    "`git checkout -- <path>` / `/undo` to take it back.",
  permissionLevel: "readwrite",
  // Declared mutating so the [plan] fence and the mutating-tool caches treat it as
  // capable of writes; the gateway narrows this per call via classifyGitInvocation.
  isMutating: true,
  cacheable: false,
  parameters: {
    type: "object",
    properties: {
      args: {
        type: "array",
        description: 'git argv without the program name, e.g. ["diff", "--stat"]',
        items: { type: "string" },
      },
      path: {
        type: "string",
        description: "Optional subdirectory of the workspace to run in (defaults to the root)",
        default: ".",
      },
    },
    required: ["args"],
  },
  execute: async (args, ctx) => {
    const validated = validateGitArgs((args as Record<string, unknown>).args);
    if (!validated.ok) return { output: `Error: ${validated.error}`, isError: true };

    const info = classifyGitInvocation(validated.args);
    if (info.grade === "refused") {
      return {
        output:
          `Error: git "${info.subcommand}" was refused: ${info.reason}\n\n` +
          `This is a policy refusal, not a git failure. Read-only inspection still works ` +
          `(status/diff/log/show/blame). For anything else, ask the user to run it in ` +
          `their own terminal.`,
        isError: true,
      };
    }

    const subPath = String((args as Record<string, unknown>).path || ".");
    let cwd: string;
    try {
      // The same guard the write path uses, so a `path` of "../../elsewhere" cannot point
      // git at a repository outside this one.
      cwd = ctx.pathGuard.validateAndResolve(subPath);
    } catch (err: any) {
      return { output: `Error: git 'path' was rejected: ${err?.message || String(err)}`, isError: true };
    }

    const run = await CommandPolicy.execProcessDirectDetailed(
      "git",
      // `--no-pager` is a genuine global option (a `--color=never` here would not be, and
      // git would answer usage error 129); color is switched off through the env instead.
      ["--no-pager", ...validated.args],
      cwd,
      // A `git log` on a huge repo is legitimate; a hung interactive prompt is not, and
      // the interactive flags are refused above for exactly that reason.
      info.grade === "read-only" ? 30_000 : 60_000,
      ctx.signal,
      gitEnvironment()
    );

    if (run.spawnError === "ABORTED") {
      return { output: "Error: git command was cancelled.", isError: true };
    }
    if (run.spawnError === "ENOENT") {
      return {
        output: "Error: git is not installed on this machine, so the git tool cannot run.",
        isError: true,
      };
    }

    const body = run.output.replace(/\s+$/, "") || "(no output)";
    const failed = run.exitCode !== 0;
    // A failed git run reports git's own words and its exit code, and gets **no**
    // summary: "# 0 modified, 0 added…" printed over `fatal: not a git repository` is
    // indistinguishable from a clean tree, which is the confident-wrong answer an agent
    // acts on. `isError` follows the exit code for the same reason — the tool must not
    // claim success because it managed to run a command that failed.
    const summary = failed ? "" : summarize(info.subcommand, body);
    const exitNote = failed ? `\n# exit code ${run.exitCode}` : "";

    // "not a git repository" and friends arrive as exit 128 with text on stderr; that
    // text is passed through rather than replaced with an invented message. Output size is
    // capped by the gateway, which also announces the truncation — capping here would say
    // "truncated" twice over the same text.
    return {
      output:
        `${body}${exitNote}${summary ? `\n${summary}` : ""}\n\n` +
        `(from \`git ${validated.args.join(" ")}\`${info.grade === "read-only" ? ", read-only" : ", a mutating git command — approved before running"})`,
      isError: failed,
    };
  },
};

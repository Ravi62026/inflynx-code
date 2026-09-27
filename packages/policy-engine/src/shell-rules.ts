/**
 * @inflynx/policy-engine — shell command review (parser + rule engine).
 *
 * Replaces the previous control, which was a regex rejecting every shell operator
 * (`[;&|<>`$()\n\r]`). That regex could not tell a dangerous command from a useful
 * one, so it made both impossible: `pnpm test 2>&1 | tail -20` was refused, while
 * `rm -rf node_modules` was quietly allowed (backlog E1, B16).
 *
 * The model here is the one every real coding agent converges on:
 *
 *   parse the command into segments → classify each segment → the whole command
 *   gets the strictest verdict → and *approval by a human* is the control, not the
 *   pattern list.
 *
 * Two properties worth stating explicitly, because they are the whole reason this is
 * better than what it replaces:
 *
 *   - Unknown means **ask**, never allow. A rule set cannot enumerate every dangerous
 *     command, so the default has to fail toward a human.
 *   - The parser is *informational*, not a sandbox. `bash -c "rm -rf /"` still runs
 *     whatever bash decides to run. Its job is to surface structure — pipelines,
 *     redirections, substitutions — so the approval prompt can show what is actually
 *     being agreed to. Treating it as a boundary would be the same mistake as the old
 *     regex, in a nicer costume.
 */

import fs from "fs";
import os from "os";
import path from "path";

export type ShellDecision = "allow" | "ask" | "deny";

export type JoinOperator = "start" | "&&" | "||" | ";" | "|" | "|&" | "newline" | "&";

export interface ShellSegment {
  /** Raw text of this one command, as written. Shown to the human, never rule-matched. */
  text: string;
  /** Best-effort argv, quotes removed. Used for rule matching only. */
  tokens: string[];
  /** How this segment attaches to the previous one. */
  precededBy: JoinOperator;
}

/** Placeholder standing in for a quoted argument during rule matching. */
const QUOTED_PLACEHOLDER = "\u0000quoted\u0000";

/**
 * Blank out quoted regions so rules match **structure, not data** (backlog N8).
 *
 * Quoted text is an argument, not a command — but the rules are regexes over a string,
 * and `echo 'please do not rm -rf . in prod'` contains a pattern that reads, to a naive
 * match, exactly like the thing it is talking about. Before this, that plain `echo` was
 * HARD-DENIED, and `grep -nEi 'exec|spawn|rm\(|unlink' file` was reported to the user as
 * "deletes or truncates files". A prompt that states a false reason is worse than no
 * prompt, because it trains the human to approve without reading.
 *
 * This does NOT weaken real detection, and the reason matters: what executes a destructive
 * payload is the *program*, so inline-code programs are escalated by identity below
 * (`sh -c "..."`, `python -c "..."`), not by reading their argument. Redacting the argument
 * of a program that treats its argument as data is precisely correct; redacting the
 * argument of a shell would not be, and that case is covered separately.
 */
export function redactQuotedArguments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      // An escaped character outside quotes is data too (\; is a literal semicolon).
      out += "\u0000esc\u0000";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (quote === '"' && text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      out += QUOTED_PLACEHOLDER;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface ShellFeatures {
  /** Targets written by `>` / `>>` / `2>` — a file write that skips every edit control. */
  writeRedirections: string[];
  /** Sources read by `<` — harmless, and deliberately not an escalation trigger. */
  readRedirections: string[];
  /** `$(...)` / backtick bodies — code that executes without appearing as a segment. */
  substitutions: string[];
  /** `$NAME` expansions the command depends on, so the prompt can name them. */
  variableReferences: string[];
  /** Leading `NAME=value` words, which set the environment for that command only. */
  envAssignments: string[];
  subshellCount: number;
  background: boolean;
}

export interface SegmentVerdict {
  text: string;
  program: string;
  decision: ShellDecision;
  rule: string;
  reason: string;
}

export interface ShellCommandReview {
  command: string;
  segments: ShellSegment[];
  verdicts: SegmentVerdict[];
  /** The strictest verdict across all segments, with deny > ask > allow. */
  decision: ShellDecision;
  features: ShellFeatures;
  needsApproval: boolean;
  /** The single most important reason, safe to show in a UI. */
  headline: string;
  /** Multi-line, human-readable explanation of what is being agreed to. */
  userMessage: string;
  /** Why a `deny` happened, when one did. */
  deniedBy?: SegmentVerdict;
}

// ─── Parsing ───────────────────────────────────────────────────────────────────

const JOINERS: Array<{ token: string; op: JoinOperator }> = [
  { token: "&&", op: "&&" },
  { token: "||", op: "||" },
  { token: "|&", op: "|&" },
  { token: ";", op: ";" },
  { token: "\n", op: "newline" },
  { token: "|", op: "|" },
];

/**
 * Splits a command line into segments on top-level control operators.
 *
 * Quote- and nesting-aware: `git commit -m "fix(a; b)"` is one segment, not three.
 * That matters because splitting inside a quoted argument would mis-report the
 * structure to a human who is about to approve it.
 */
export function parseShellSegments(command: string): { segments: ShellSegment[]; features: ShellFeatures } {
  const features: ShellFeatures = {
    writeRedirections: [],
    readRedirections: [],
    substitutions: [],
    variableReferences: [],
    envAssignments: [],
    subshellCount: 0,
    background: false,
  };

  const segments: ShellSegment[] = [];
  let current = "";
  let currentJoin: JoinOperator = "start";
  let tokenBuffer = "";
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let escaped = false;

  const flushToken = () => {
    if (tokenBuffer) {
      tokens.push(tokenBuffer);
      tokenBuffer = "";
    }
  };
  let tokens: string[] = [];

  const flushSegment = (nextJoin?: JoinOperator) => {
    flushToken();
    if (current.trim() || tokens.length) {
      segments.push({ text: current.trim(), tokens, precededBy: currentJoin });
    }
    current = "";
    tokens = [];
    if (nextJoin) currentJoin = nextJoin;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      tokenBuffer += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      current += ch;
      tokenBuffer += "\\";
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      tokenBuffer += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      tokenBuffer += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Command substitution: `$(` or a backtick. Everything until the matching close
      // is recorded as a substitution and execution continues past it.
      if (ch === "$" && command[i + 1] === "(") {
        const end = findClosingParen(command, i + 1);
        features.substitutions.push(command.slice(i + 2, end).trim());
        const raw = command.slice(i, end + 1);
        current += raw;
        tokenBuffer += raw;
        i = end;
        continue;
      }
      if (ch === "`") {
        const end = command.indexOf("`", i + 1);
        const stop = end === -1 ? command.length - 1 : end;
        features.substitutions.push(command.slice(i + 1, stop).trim());
        const raw = command.slice(i, stop + 1);
        current += raw;
        tokenBuffer += raw;
        i = stop;
        continue;
      }
      if (ch === "$" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(command.slice(i + 1, i + 2))) {
        // `$VAR` — a plain expansion, recorded so the prompt can say "uses $VAR".
        let j = i + 1;
        while (j < command.length && /[A-Za-z0-9_]/.test(command[j])) j++;
        const raw = command.slice(i, j);
        features.variableReferences.push(raw);
        current += raw;
        tokenBuffer += raw;
        i = j - 1;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
        if (parenDepth === 1) features.subshellCount++;
      }
      if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      if (ch === "{") braceDepth++;
      if (ch === "}" && braceDepth > 0) braceDepth--;

      if (parenDepth === 0 && braceDepth === 0) {
        // Redirections: `>`, `>>`, `2>`, `2>&1`, `<`. Written files are what matter —
        // a `>` is a file edit that skips the diff preview, the checkpoint and undo.
        if ((ch === ">" || ch === "<") && command[i + 1] !== "(") {
          const writing = ch === ">";
          // An fd prefix (`2>`) is part of the previous token; pull it back out.
          if (/[012]$/.test(tokenBuffer)) tokenBuffer = tokenBuffer.slice(0, -1);

          let k = i + 1;
          let append = false;
          if (command[k] === ">") {
            append = true;
            k++;
          } else if (command[k] === "&") {
            // `2>&1` / `>&2` merges descriptors; it writes nothing on its own.
            const consumed = command.slice(i, k + 1);
            current += consumed;
            i = k;
            continue;
          }

          while (k < command.length && /\s/.test(command[k])) k++;
          let target = "";
          while (k < command.length && !/[\s;|&<>]/.test(command[k])) target += command[k++];

          if (target) {
            if (writing) features.writeRedirections.push(append ? `>>${target}` : target);
            else features.readRedirections.push(target);
          }
          current += command.slice(i, k);
          tokenBuffer += ch + (append && command[i + 1] === ">" ? ">" : "") + target;
          i = k - 1;
          continue;
        }

        // Background `&` (but not `&&`).
        if (ch === "&" && command[i + 1] !== "&" && command[i - 1] !== "&") {
          features.background = true;
          current += ch;
          continue;
        }

        const joiner = JOINERS.find((c) => command.startsWith(c.token, i));
        if (joiner) {
          flushSegment(joiner.op);
          i += joiner.token.length - 1;
          continue;
        }

        if (/\s/.test(ch)) {
          flushToken();
          current += ch;
          continue;
        }
      }
    }

    current += ch;
    tokenBuffer += ch;
  }
  flushSegment();

  // Leading `VAR=value` words in a segment are environment assignments for that
  // command, not programs to match rules against.
  for (const segment of segments) {
    for (const token of segment.tokens) {
      const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) features.envAssignments.push(`${match[1]}=`);
    }
  }

  // Drop empty segments produced by trailing separators.
  return { segments: segments.filter((s) => s.text.length > 0), features };
}

function findClosingParen(command: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < command.length; i++) {
    if (command[i] === "(") depth++;
    else if (command[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return command.length - 1;
}

// ─── Rules ─────────────────────────────────────────────────────────────────────

interface Rule {
  /** Matches the segment's program or a substring of its text; documented for review. */
  program?: string;
  /** Glob-ish pattern against the whole segment text. */
  match?: RegExp;
  decision: ShellDecision;
  reason: string;
}

const DENY_RULES: Rule[] = [
  {
    match: /\|\s*(?:sudo\s+)?(?:ba|z|k|c|da)?sh\b/,
    decision: "deny",
    reason: "pipes downloaded or arbitrary output straight into a shell",
  },
  { match: /\|\s*(?:python[0-9.]*|node|perl|ruby|php)\b/, decision: "deny", reason: "pipes output into an interpreter" },
  {
    // Root, home, the current directory, its parent, and bare globs. The lookahead
    // makes the target a whole token: `rm -rf ./build` is an ordinary ask, `rm -rf .`
    // is not. Missing `.`/`*` here is the exact blind spot that made the old
    // `/rm\s+-[rR][fF]\s+[\/\~]/` pattern false assurance (backlog B16) — it caught
    // `rm -rf /` and let through the form that actually destroys a workspace.
    match: /\brm\s+(?:-\w+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~\/?|\*+|\.|\.\.)(?=\s|$)/,
    decision: "deny",
    reason: "recursive delete of the working tree, home, root or a bare glob",
  },
  { match: /^\s*sudo\b/, decision: "deny", reason: "privilege escalation, which the agent should never do on your behalf" },
  { match: /\bmkfs(\.\w+)?\b/, decision: "deny", reason: "formats a filesystem" },
  { match: /\bdd\b[^|]*\bof=\/dev\//, decision: "deny", reason: "writes raw to a block device" },
  { match: />\s*\/dev\/(sd|nvme|disk|hd)/, decision: "deny", reason: "overwrites a block device" },
  { match: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, decision: "deny", reason: "matches a fork-bomb definition" },
  { match: /\bgit\b[^|]*--no-verify\b/, decision: "deny", reason: "skips your commit hooks — a deliberate safety bypass" },
  { match: /\bchmod\s+(-R\s+)?777\s+(\/|~)/, decision: "deny", reason: "world-writable permissions on a root path" },
  { match: /\b(curl|wget)\b[^|]*\|\s*(?:bash|sh)\b/, decision: "deny", reason: "executes remote content unseen" },
];

const ASK_RULES: Rule[] = [
  {
    // A shell's `-c` argument IS code. Escalated by program identity so the rule still
    // fires once quoted arguments are redacted — otherwise this would be a bypass.
    match: /(^|[\s;&|])(?:sudo\s+)?(?:ba|z|k|da)?sh\s+(?:[-+]\S*\s+)*-c\b/,
    decision: "ask",
    reason: "runs an inline program: the -c argument is code, not data",
  },
  {
    match: /(^|[\s;&|])(?:python[0-9.]*|node|iojs|deno|tsx?|perl|ruby|php|osascript|lua|swift)\s+(?:\S+\s+)*-[ce]\b/,
    decision: "ask",
    reason: "runs an inline program: the -c/-e argument is code, not data",
  },
  { match: /\b(rm|rmdir|unlink|shred|truncate)\b/, decision: "ask", reason: "deletes or truncates files" },
  { match: /\bmv\b/, decision: "ask", reason: "moves files (no diff preview, no checkpoint)" },
  { match: /\bgit\b[^|]*\b(commit|push|reset|checkout|restore|clean|rebase|merge|stash|branch\s+-D|tag)\b/, decision: "ask", reason: "changes git state" },
  { match: /\bgit\b[^|]*push\b[^|]*(--force| -f\b)/, decision: "ask", reason: "force-push can destroy shared history" },
  { match: /\b(npm|pnpm|yarn|bun)\b[^|]*\b(install|add|remove|uninstall|update|publish|link)\b/, decision: "ask", reason: "changes dependencies or publishes packages" },
  { match: /\b(pip|pip3|uv|poetry|cargo|gem|brew|apt|apt-get|yum)\b[^|]*\b(install|uninstall|upgrade|remove|add)\b/, decision: "ask", reason: "installs software on this machine" },
  { match: /\b(docker|podman|kubectl)\b[^|]*\b(rm|rmi|down|delete|prune|apply|exec|system)\b/, decision: "ask", reason: "changes containers or clusters" },
  { match: /\bkill(all)?\b|\bpkill\b|\bkill\b/, decision: "ask", reason: "signals another process" },
  { match: /\bchmod\b|\bchown\b/, decision: "ask", reason: "changes permissions or ownership" },
  { match: /\b(crontab|launchctl|systemctl|service)\b/, decision: "ask", reason: "changes scheduled or system services" },
  { match: /\bsed\b[^|]*\s(-i|--in-place)\b/, decision: "ask", reason: "sed -i edits files in place, outside the edit tools" },
  { match: /\b(awk|gawk|mawk)\b/, decision: "ask", reason: "awk can write files and call system() from inside its program" },
  { match: /\b(echo|printf|cat|tee)\b[^|]*>/, decision: "ask", reason: "writes a file outside the edit tools" },
  { match: /\bsource\b|\b\.\s+\//, decision: "ask", reason: "executes another script in this shell" },
  { match: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|start|dev)\b/, decision: "ask", reason: "runs project code, which can do anything the tests can" },
  { match: /\bnode\b[^|]*\s(-e|--eval)\b/, decision: "ask", reason: "evaluates inline code" },
  { match: /\bxargs\b/, decision: "ask", reason: "executes a command built from the previous output" },
  { match: /\bfind\b[^|]*-(delete|exec|execdir)\b/, decision: "ask", reason: "find can delete or execute on each match" },
];

const ALLOW_RULES: Rule[] = [
  // Pure inspection. No writes, no execution of anything but the binary itself.
  { match: /^\s*(ls|ll|pwd|whoami|id|date|uname|hostname|which|whereis|type|command|cd)\b/, decision: "allow", reason: "inspection only" },
  { match: /^\s*(cat|head|tail|wc|sort|uniq|cut|tr|basename|dirname|realpath|stat|file|du|df|tree|less|more)\b/, decision: "allow", reason: "reads files, writes nothing" },
  { match: /^\s*(grep|rg|ag|fd)\b/, decision: "allow", reason: "searches, writes nothing" },
  // `jq`/`sed -n`/`awk`-free filters: `jq` cannot write a file by itself (a `>` would
  // be caught as a redirection and escalated), so it is a pure transform.
  { match: /^\s*(jq|yq)\b/, decision: "allow", reason: "transforms its input, writes nothing" },
  { match: /^\s*sed\b(?!.*\s-i)/, decision: "allow", reason: "stream editor; only -i writes, and that is asked" },
  // Plain `find` is read-only. The ASK rule for `find -delete`/`-exec` is evaluated
  // first, so reaching here means neither flag is present.
  { match: /^\s*find\b/, decision: "allow", reason: "lists matches; -delete/-exec are handled above" },
  { match: /^\s*echo\b/, decision: "allow", reason: "prints to the terminal" },
  { match: /^\s*printf\b/, decision: "allow", reason: "prints to the terminal" },
  { match: /^\s*env\b\s*$/, decision: "allow", reason: "lists environment variables" },
  { match: /^\s*(node|python3?|ruby|go|cargo|java)\s?(--version|-V|version)\b/, decision: "allow", reason: "version probe" },
  { match: /^\s*git\s+(status|diff|log|show|blame|describe|rev-parse|ls-files|ls-remote|show-current-branch|remote|config\s+--get|branch(?!.*-D))\b/, decision: "allow", reason: "git read-only" },
  { match: /^\s*(npm|pnpm|yarn)\s+(ls|list|view|outdated|why|doctor)\b/, decision: "allow", reason: "package inspection" },
  { match: /^\s*tsc\s+--noEmit\b/, decision: "allow", reason: "typecheck emits nothing with --noEmit" },
];

export interface UserShellRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/**
 * Test/embedder seam only: an in-memory rules file so the engine can be exercised
 * without a home directory. Reading happens per review, so this cannot become a
 * silent global override for real sessions.
 */
let userRuleOverride: UserShellRules | null = null;

export function setUserShellRules(rules: UserShellRules | null): void {
  userRuleOverride = rules;
}

export function getUserShellRulesPath(): string {
  return path.join(os.homedir(), ".inflynx", "shell-rules.json");
}

/**
 * User-defined rules from `~/.inflynx/shell-rules.json`, checked **before** the
 * built-in table, so an explicit allow on your own machine beats a default.
 *
 * Deliberately user-level only. A project-level rules file would be repository
 * content granting itself permission — the exact mistake the MCP trust gate closes.
 *
 * Patterns are matched case-insensitively against the segment text. Malformed rules
 * are reported and skipped; a broken rules file must not silently widen anything.
 */
export function loadUserShellRules(
  source?: UserShellRules | null
): { allow: Rule[]; ask: Rule[]; deny: Rule[]; problems: string[] } {
  const rules = source ?? userRuleOverride ?? readRulesFile();
  const problems: string[] = [];
  const out: { allow: Rule[]; ask: Rule[]; deny: Rule[] } = { allow: [], ask: [], deny: [] };

  for (const decision of ["allow", "ask", "deny"] as const) {
    for (const pattern of rules?.[decision] || []) {
      if (typeof pattern !== "string" || !pattern.trim()) {
        problems.push(`empty ${decision} pattern ignored`);
        continue;
      }
      try {
        out[decision].push({
          match: new RegExp(pattern, "i"),
          decision,
          reason: `your own rule in ~/.inflynx/shell-rules.json (${pattern})`,
        });
      } catch (err: any) {
        problems.push(`invalid ${decision} pattern "${pattern}": ${err?.message || err}`);
      }
    }
  }
  return { ...out, problems };
}

function readRulesFile(): UserShellRules | null {
  try {
    const file = getUserShellRulesPath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as UserShellRules) : null;
  } catch (err: any) {
    // Fail closed: unreadable rules means no extra allows, and the user hears about it.
    console.warn(`[policy-engine] could not read ~/.inflynx/shell-rules.json: ${err?.message || err}`);
    return null;
  }
}

const SEVERITY: Record<ShellDecision, number> = { allow: 0, ask: 1, deny: 2 };

function firstMatch(rules: Rule[], text: string): Rule | undefined {
  return rules.find((rule) => (rule.match ? rule.match.test(text) : rule.program === text));
}

/**
 * Deny patterns that only exist *across* segments.
 *
 * `curl https://x/install.sh | bash` is two perfectly ordinary programs; the danger
 * is the join between them, so it can never be found by classifying a segment on its
 * own. This whole-command pass is what makes pipe-into-interpreter a hard refusal
 * rather than "ask twice about two safe-looking commands".
 */
const CROSS_SEGMENT_DENY_RULES: Rule[] = [
  { match: /\|\s*(?:sudo\s+)?(?:ba|z|k|c|da)?sh\b/, decision: "deny", reason: "pipes output straight into a shell" },
  { match: /\|\s*(?:python[0-9.]*|node|perl|ruby|php|osascript)\b/, decision: "deny", reason: "pipes output into an interpreter" },
  { match: /\|\s*xargs\s+(?:-I\S+\s+)?(?:ba|z)?sh\b/, decision: "deny", reason: "feeds found names to a shell" },
  { match: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, decision: "deny", reason: "matches a fork-bomb definition" },
];

function classifySegment(segment: ShellSegment, userRules: ReturnType<typeof loadUserShellRules>): SegmentVerdict {
  const text = segment.text;
  const program = segment.tokens[0] || text.split(/\s+/)[0] || "";
  // Rules see structure; the human sees the original text. Matching raw `text` is what
  // made quoted words look like commands (backlog N8).
  const matchText = redactQuotedArguments(text);

  // Order is: user's explicit intent → deny → ask → allow → unknown.
  const matched =
    firstMatch(userRules.deny, matchText) ||
    firstMatch(userRules.ask, matchText) ||
    firstMatch(userRules.allow, matchText) ||
    firstMatch(DENY_RULES, matchText) ||
    firstMatch(ASK_RULES, matchText) ||
    firstMatch(ALLOW_RULES, matchText);

  if (matched) {
    return { text, program, decision: matched.decision, rule: String(matched.match || matched.program), reason: matched.reason };
  }
  return {
    text,
    program,
    decision: "ask",
    rule: "no-rule-matched",
    reason: program
      ? `"${program}" is not on the read-only list, so a human decides`
      : "this segment is not recognised, so a human decides",
  };
}

/**
 * Reviews a full command line. Pure: no execution, no filesystem writes.
 *
 * Beyond the per-segment rules it forces `ask` for structure that a segment list
 * cannot express — command substitutions (hidden executed code), redirections (a
 * file write that bypasses every edit control: no diff preview, no checkpoint, no
 * undo), subshells, and backgrounding.
 */
export function reviewShellCommand(
  command: string,
  options: { userRules?: UserShellRules | null } = {}
): ShellCommandReview {
  const trimmed = (command || "").trim();
  const userRules = loadUserShellRules("userRules" in options ? options.userRules : undefined);
  for (const problem of userRules.problems) console.warn(`[policy-engine] ${problem}`);

  if (!trimmed) {
    return {
      command: trimmed,
      segments: [],
      verdicts: [],
      decision: "deny",
      features: { writeRedirections: [], readRedirections: [], substitutions: [], variableReferences: [], envAssignments: [], subshellCount: 0, background: false },
      needsApproval: false,
      headline: "empty command",
      userMessage: "The command was empty.",
    };
  }

  if (trimmed.includes("\0")) {
    const verdict: SegmentVerdict = { text: trimmed, program: "", decision: "deny", rule: "null-byte", reason: "contains a NULL byte" };
    return {
      command: trimmed,
      segments: [],
      verdicts: [verdict],
      decision: "deny",
      features: { writeRedirections: [], readRedirections: [], substitutions: [], variableReferences: [], envAssignments: [], subshellCount: 0, background: false },
      needsApproval: false,
      headline: verdict.reason,
      userMessage: `Blocked: ${verdict.reason}.`,
      deniedBy: verdict,
    };
  }

  const { segments, features } = parseShellSegments(trimmed);

  // Hard refusals that describe a *relationship* between commands are checked against
  // the whole line first, because no individual segment contains them. Redacted the same
  // way as segments: the joiners are real syntax, quoted words are not (N8).
  const crossSegment = firstMatch(
    [...userRules.deny, ...CROSS_SEGMENT_DENY_RULES, ...DENY_RULES],
    redactQuotedArguments(trimmed)
  );
  if (crossSegment) {
    const verdict: SegmentVerdict = {
      text: trimmed,
      program: segments[0]?.tokens[0] || "",
      decision: "deny",
      rule: String(crossSegment.match),
      reason: crossSegment.reason,
    };
    const denied: Omit<ShellCommandReview, "userMessage"> = {
      command: trimmed,
      segments,
      verdicts: [verdict],
      decision: "deny",
      features,
      needsApproval: false,
      headline: `blocked: ${verdict.reason}`,
      deniedBy: verdict,
    };
    return { ...denied, userMessage: formatReviewForUser(denied, [verdict.reason]) };
  }

  const verdicts = segments.map((segment) => classifySegment(segment, userRules));

  let decision: ShellDecision = "allow";
  let deniedBy: SegmentVerdict | undefined;
  const structuralReasons: string[] = [];

  for (const verdict of verdicts) {
    if (SEVERITY[verdict.decision] > SEVERITY[decision]) decision = verdict.decision;
    if (verdict.decision === "deny" && !deniedBy) deniedBy = verdict;
  }

  // Structural escalations. These can only make a command harder, never easier.
  if (features.substitutions.length > 0 && decision !== "deny") {
    structuralReasons.push(
      `runs a hidden command via $( ): ${features.substitutions.map((s) => `"${truncate(s, 40)}"`).join(", ")}`
    );
    if (SEVERITY.ask > SEVERITY[decision]) decision = "ask";
  }
  if (features.writeRedirections.length > 0 && decision !== "deny") {
    structuralReasons.push(
      `writes ${features.writeRedirections.map((r) => `"${truncate(r, 40)}"`).join(", ")} directly — ` +
      `outside the edit tools, so there is no diff preview and no undo for it`
    );
    if (SEVERITY.ask > SEVERITY[decision]) decision = "ask";
  }
  if (features.subshellCount > 0 && decision !== "deny") {
    structuralReasons.push(`contains a subshell (…)`);
    if (SEVERITY.ask > SEVERITY[decision]) decision = "ask";
  }
  if (features.background && decision !== "deny") {
    structuralReasons.push("starts a background process (&)");
    if (SEVERITY.ask > SEVERITY[decision]) decision = "ask";
  }

  const headline =
    deniedBy
      ? `blocked: ${deniedBy.reason}`
      : decision === "allow"
        ? "read-only inspection"
        : [...verdicts.filter((v) => v.decision === "ask").map((v) => v.reason), ...structuralReasons][0] ||
          "needs your approval";

  const review: Omit<ShellCommandReview, "userMessage"> = {
    command: trimmed,
    segments,
    verdicts,
    decision,
    features,
    needsApproval: decision === "ask",
    headline,
    deniedBy,
  };

  return { ...review, userMessage: formatReviewForUser(review, structuralReasons) };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * The text a human sees before approving. Its job is to make the *structure* visible,
 * because that is precisely what the old operator ban made impossible to see: the
 * segment that deletes, the redirect that writes a file, the `$( )` that runs
 * something nobody listed.
 */
export function formatReviewForUser(
  review: Omit<ShellCommandReview, "userMessage">,
  extraReasons: string[] = []
): string {
  const lines: string[] = [];
  lines.push(`$ ${review.command}`);
  lines.push("");

  if (review.segments.length > 1) {
    lines.push(`${review.segments.length} commands chained together:`);
    for (const verdict of review.verdicts) {
      const joiner = verdict.text === review.segments[0]?.text ? "" : joinerLabel(verdict, review);
      lines.push(`  ${joiner}${verdict.text}  → ${verdict.decision} (${verdict.reason})`);
    }
  } else if (review.verdicts[0] && review.verdicts[0].decision !== "allow") {
    lines.push(`1 command → ${review.verdicts[0].decision} (${review.verdicts[0].reason})`);
  }

  const warnings = [...extraReasons];
  if (review.features.variableReferences.length > 0) {
    warnings.push(`depends on ${review.features.variableReferences.join(", ")} from your environment`);
  }
  if (review.features.envAssignments.length > 0) {
    warnings.push(`sets environment variables: ${review.features.envAssignments.join(" ")}`);
  }
  if (warnings.length > 0) {
    lines.push("");
    for (const warning of warnings) lines.push(`  ⚠ ${warning}`);
  }
  if (review.decision === "deny") {
    lines.push("");
    lines.push("Blocked outright. Run this yourself in your own terminal if you really mean it.");
  }
  return lines.join("\n");
}

function joinerLabel(verdict: SegmentVerdict, review: Omit<ShellCommandReview, "userMessage">): string {
  const index = review.segments.findIndex((s) => s.text === verdict.text);
  const op = review.segments[index]?.precededBy;
  return op && op !== "start" && op !== "newline" ? `${op} ` : "";
}

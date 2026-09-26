import { execFile, spawn } from "child_process";

/**
 * @inflynx/policy-engine — CommandPolicy
 *
 * Two execution paths, on purpose, because they answer different questions:
 *
 *   - `execProcessDirect` — argument-array, **no shell**. Used by our own internals
 *     (`rg`, `grep`) where the argument list is built by code, not by a model.
 *   - `runShellLine` — a real `bash -lc`, gated by `reviewShellCommand` and by human
 *     approval. Used for anything a human or model typed.
 *
 * The previous version had one path (`execFile`) and banned shell syntax to make up
 * for it, which made the flagship shell tool a single-binary launcher (backlog E1).
 * Safety moved to the review layer, where it can distinguish `git diff` from `rm -rf`.
 */

export interface ShellRunResult {
  /** stdout, then stderr, then a trailing status line. Always populated, even on failure. */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the byte cap cut the output; the cap is separate from the context cap. */
  outputTruncated: boolean;
  durationMs: number;
}

export interface ShellRunOptions {
  timeoutMs?: number;
  /** Hard byte ceiling on captured output. Default 1 MB — beyond that it is not useful. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}
export class CommandPolicy {
  private static DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /rm\s+-(?:[rR][fF]|[fF][rR])\s+[\/\~]/, reason: "Recursive root/home directory deletion" },
    { pattern: /sudo\s+rm/, reason: "Elevated privilege file removal" },
    { pattern: /mkfs(\.\w+)?\s+/, reason: "Filesystem formatting operation" },
    { pattern: /dd\s+if=/, reason: "Low-level disk block write" },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: "Raw disk block overwrite" },
    { pattern: /:\(\)\{\s*:\|:&\s*\};:/, reason: "Shell fork bomb pattern" },
    { pattern: /chmod\s+(?:-R\s+)?777\s+[\/\~]/, reason: "Recursive global root permission modification" },
  ];
  private static SHELL_INTERPRETATION_PATTERN = /[;&|<>`$()\n\r]/;

  /**
   * Rejects shell syntax in a command that is going to be run as an **argument
   * array**, i.e. `execProcessDirect` and MCP `command` strings.
   *
   * This is not the shell-safety control any more — `reviewShellCommand` is, and
   * `runShellLine` genuinely runs a shell. What this guards is narrower and still
   * real: a caller that meant "one program with these args" must not silently be
   * handed a different meaning by whoever changes the executor later. An operator
   * reaching here is a bug in the caller, so it is reported as one.
   *
   * @throws Error if the string contains shell metacharacters or a high-risk pattern.
   */
  static validateShellCommand(commandString: string): void {
    if (!commandString || !commandString.trim()) {
      throw new Error("Command policy violation: Command string cannot be empty.");
    }

    const trimmed = commandString.trim();
    if (trimmed.includes("\0")) {
      throw new Error("Command policy violation: Command contains a NULL byte.");
    }

    if (this.SHELL_INTERPRETATION_PATTERN.test(trimmed)) {
      throw new Error(
        `Security Policy Block: "${trimmed}" contains shell operators, but this path runs a ` +
        "single program with an argument array and would not interpret them. Use " +
        "CommandPolicy.runShellLine() for a real shell, or pass args as an array."
      );
    }

    for (const { pattern, reason } of this.DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new Error(
          `Security Policy Block: Command "${trimmed}" rejected by policy.\nReason: ${reason}.`
        );
      }
    }
  }

  /**
   * Safely splits a simple command string into executable and argument array.
   * Handles quoted strings (single and double quotes).
   */
  static parseCommandToArgs(commandString: string): { executable: string; args: string[] } {
    const trimmed = commandString.trim();
    const tokens: string[] = [];
    let currentToken = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let isEscaped = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (isEscaped) {
        currentToken += char;
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
        if (currentToken) {
          tokens.push(currentToken);
          currentToken = "";
        }
        continue;
      }

      currentToken += char;
    }

    if (inSingleQuote || inDoubleQuote || isEscaped) {
      throw new Error("Cannot parse command string: unterminated quote or escape sequence.");
    }

    if (currentToken) {
      tokens.push(currentToken);
    }

    if (tokens.length === 0) {
      throw new Error("Cannot parse empty command string.");
    }

    return {
      executable: tokens[0],
      args: tokens.slice(1),
    };
  }

  /**
   * Argument-array execution that reports the outcome instead of throwing on a
   * non-zero exit.
   *
   * `execProcessDirect` collapses "the program ran and found nothing" (exit 1), "the
   * program could not start" (ENOENT) and "the arguments were invalid" (exit 2) into
   * one thrown error, which is how `search_files` came to answer a bad regex with
   * "No matches found" — actively misleading the model into concluding the code does
   * not exist (backlog E4). Callers that need the difference use this.
   */
  static async execProcessDirectDetailed(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number = 30_000,
    signal?: AbortSignal
  ): Promise<{ output: string; exitCode: number | null; spawnError?: string; aborted: boolean }> {
    return new Promise((resolve) => {
      const proc = execFile(
        executable,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          signal?.removeEventListener("abort", onAbort);
          const spawnError =
            err && (err as NodeJS.ErrnoException).code === "ENOENT" ? "ENOENT" : undefined;
          resolve({
            output: [stdout, stderr].filter(Boolean).join("\n"),
            exitCode: err && !spawnError && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0,
            spawnError,
            aborted: false,
          });
        }
      );

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGTERM");
        resolve({ output: "", exitCode: null, spawnError: "ABORTED", aborted: true });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Executes a process directly via `execFile` without invoking a shell interpreter
   * when executable and argument list are known.
   */
  static async execProcessDirect(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number = 30000,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        executable,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          signal?.removeEventListener("abort", onAbort);
          if (err) {
            reject(new Error(stderr.trim() || err.message));
          } else {
            resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
          }
        }
      );

      // Removed in the completion callback as well as here: an abort listener that is
      // never removed accumulates one per call for the life of the process, which is
      // how hundreds of tool calls produced a MaxListenersExceededWarning (backlog E5).
      const onAbort = () => {
        proc.kill("SIGTERM");
        reject(new Error("Process execution aborted by user signal."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Runs a command line in a real shell.
   *
   * Four things this fixes over the old `execShellTimed`, which was not a shell:
   *
   *   1. **Process groups.** `detached: true` puts the child in its own group and the
   *      kill goes to `-pid`, so `pnpm test` → `node` → `jest` all die. Killing only
   *      the direct child used to leave grandchild processes running after a timeout
   *      or an abort.
   *   2. **Escalation.** SIGTERM, a grace period, then SIGKILL — a process that traps
   *      TERM can no longer hold the session open forever.
   *   3. **Exit code is data.** A failing test suite must still deliver its report.
   *      Previously `err` meant "throw away stdout and keep stderr", which is exactly
   *      backwards for build and test output. Non-zero exit is not an exception here.
   *   4. **Bounded capture.** A byte ceiling with an explicit marker, instead of a
   *      silent 10 MB buffer.
   *
   * @param command a full shell command line; already reviewed by `reviewShellCommand`
   *   at the gateway. This method does **no** policy work — it is the execution layer.
   */
  static async runShellLine(
    command: string,
    cwd: string,
    options: ShellRunOptions & { signal?: AbortSignal } = {}
  ): Promise<ShellRunResult> {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    const signal = options.signal;

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

    return await new Promise<ShellRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const child = spawn(shell, shellArgs, {
        cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so the whole tree can be signalled at once.
        detached: process.platform !== "win32",
      });

      const capture = (channel: "stdout" | "stderr") => (chunk: Buffer) => {
        if (settled) return;
        if (capturedBytes >= maxOutputBytes) {
          outputTruncated = true;
          return;
        }
        let text = chunk.toString("utf-8");
        const room = maxOutputBytes - capturedBytes;
        if (Buffer.byteLength(text, "utf-8") > room) {
          text = text.slice(0, Math.max(0, room));
          outputTruncated = true;
        }
        capturedBytes += Buffer.byteLength(text, "utf-8");
        if (channel === "stdout") stdout += text;
        else stderr += text;
      };
      child.stdout?.on("data", capture("stdout"));
      child.stderr?.on("data", capture("stderr"));

      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* already gone */
        }
      };

      const finish = (exitCode: number | null, sig: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        signal?.removeEventListener("abort", onAbort);

        const status: string[] = [];
        if (exitCode !== 0 && exitCode !== null) status.push(`[exit code ${exitCode}]`);
        if (sig) status.push(`[killed by ${sig}]`);
        if (timedOut) status.push(`[timed out after ${timeoutMs.toLocaleString()}ms]`);
        if (aborted) status.push("[cancelled by user]");
        if (outputTruncated) {
          status.push(
            `[output capped at ${maxOutputBytes.toLocaleString()} bytes — rerun with a narrower ` +
            `command, or pipe through tail/grep/head]`
          );
        }

        const body = [stdout, stderr].filter(Boolean).join("\n").replace(/\s+$/, "");
        resolve({
          output: [body, status.join(" ")].filter(Boolean).join("\n").trim() ||
            `[no output]${status.length ? ` ${status.join(" ")}` : ""}`,
          exitCode,
          signal: sig,
          timedOut,
          aborted,
          outputTruncated,
          durationMs: Date.now() - start,
        });
      };

      child.on("error", (err) => {
        // A missing shell or an unreachable cwd must come back as output, not a throw:
        // the model needs to read it and correct itself.
        stderr += `\n${err.message}`;
        finish(-1, null);
      });
      child.on("close", (code, sig) => finish(code, sig));

      // TERM → grace → KILL → unrecoverable.
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
      const termTimer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
        hardKillTimer = setTimeout(() => finish(-1, "SIGKILL"), 5_000);
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        const escalate = setTimeout(() => killGroup("SIGKILL"), 2_000);
        escalate.unref?.();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

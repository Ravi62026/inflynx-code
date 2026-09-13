import { execFile } from "child_process";

/**
 * @inflynx/policy-engine — CommandPolicy
 * 
 * Shell command execution policy and anti-injection gateway.
 * Restricts dangerous destructive shell operations and provides safe process invocation
 * without shell string interpolation hazards.
 */
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
   * Validates a raw command string against policy rules.
   * @throws Error if command matches a high-risk destructive pattern.
   */
  static validateShellCommand(commandString: string): void {
    if (!commandString || !commandString.trim()) {
      throw new Error("Command policy violation: Command string cannot be empty.");
    }

    const trimmed = commandString.trim();
    if (trimmed.includes("\0")) {
      throw new Error("Command policy violation: Command contains a NULL byte.");
    }

    // `execFile` below does not invoke a shell. Reject shell syntax anyway so
    // callers cannot accidentally regain shell semantics if the implementation
    // changes or a command is forwarded to another process.
    if (this.SHELL_INTERPRETATION_PATTERN.test(trimmed)) {
      throw new Error(
        `Security Policy Block: Command "${trimmed}" contains shell operators or substitutions. ` +
        "Use a simple executable followed by quoted arguments."
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
          if (err) {
            reject(new Error(stderr.trim() || err.message));
          } else {
            resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
          }
        }
      );

      signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        reject(new Error("Process execution aborted by user signal."));
      });
    });
  }

  /**
   * Executes a tokenized command with a timed limit and signal abort.
   * Despite the historical method name, this intentionally does not invoke a
   * shell. Shell operators are rejected by validateShellCommand().
   */
  static async execShellTimed(
    command: string,
    cwd: string,
    timeoutMs: number = 30000,
    signal?: AbortSignal
  ): Promise<string> {
    this.validateShellCommand(command);
    const { executable, args } = this.parseCommandToArgs(command);

    return new Promise((resolve, reject) => {
      const proc = execFile(
        executable,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr.trim() || err.message));
          } else {
            resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
          }
        }
      );

      signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        reject(new Error("Command execution aborted by user signal."));
      });
    });
  }
}

/**
 * @inflynx/tool-runtime — background shell registry.
 *
 * Why this exists: `execute_shell` waits, so anything that does not terminate —
 * `pnpm dev`, a database, `jest --watch`, a long install — has to be either killed
 * at the timeout or never started. Without it the agent cannot run a project it is
 * editing, cannot see its server's logs, and cannot test an endpoint it just wrote.
 *
 * The danger of background processes is not starting them, it is *leaking* them: a
 * dev server left on port 3000 after the session ends, or a runaway loop that
 * outlives the process that launched it. Three layers address that here:
 *
 *   1. `reapAll()` is wired into every shutdown path the caller controls.
 *   2. Each shell has a **hard lifetime cap**, so even a missed reap self-terminates.
 *   3. Every shell is spawned in its own process group, so stopping means signalling
 *      `-pid` and taking the whole tree with it, not just the direct child.
 *
 * Registry lifetime is per session: the gateway owns one, so shells started in one
 * workspace are invisible (and unsignallable) from another.
 */

import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import os from "os";

/** Bytes of output kept per shell, oldest dropped first. */
export const BACKGROUND_SHELL_RETENTION_BYTES = 64 * 1024;

/**
 * Hard ceiling on a background shell's life, even if nobody calls `shell_stop` and
 * the host process never reaps it. A dev server should outlive a session's turns,
 * not outlive the machine's uptime.
 */
export const BACKGROUND_SHELL_MAX_LIFETIME_MS = 30 * 60 * 1000;

/** How much output `execute_shell` echoes immediately when backgrounding. */
const PREVIEW_BYTES = 600;

export interface BackgroundShellRecord {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid?: number;
  /** Total bytes ever produced, so `since` offsets stay meaningful after truncation. */
  totalBytes: number;
  /** Offset of the first byte still retained; `since` below it is reported as lost. */
  firstRetainedOffset: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endedAt?: number;
  /** Set when the lifetime cap or a reap killed it, as distinct from exiting on its own. */
  terminatedReason?: "timeout" | "reaped" | "user-stop";
  lastError?: string;
}

export interface ShellReadResult {
  text: string;
  /** Pass this as the next `since` to continue where this read stopped. */
  nextOffset: number;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminatedReason?: string;
  /** True when the requested `since` was already dropped from the retention buffer. */
  droppedPrefix: boolean;
  droppedPrefixBytes: number;
}

export interface ShellStartResult {
  id: string;
  pid?: number;
  preview: string;
}

interface LiveShell {
  record: BackgroundShellRecord;
  child: ChildProcessByStdio<null, Readable, Readable>;
  buffer: Buffer[];
  bufferBytes: number;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export interface ShellRegistryOptions {
  retentionBytes?: number;
  maxLifetimeMs?: number;
  /** Injectable for tests; production uses the real clock. */
  now?: () => number;
}

function newShellId(): string {
  return `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class ShellRegistry {
  private shells = new Map<string, LiveShell>();
  private readonly retentionBytes: number;
  private readonly maxLifetimeMs: number;

  constructor(options: ShellRegistryOptions = {}) {
    this.retentionBytes = options.retentionBytes ?? BACKGROUND_SHELL_RETENTION_BYTES;
    this.maxLifetimeMs = options.maxLifetimeMs ?? BACKGROUND_SHELL_MAX_LIFETIME_MS;
  }

  get size(): number {
    return this.shells.size;
  }

  /**
   * Starts `command` detached from the caller's turn. No policy is evaluated here —
   * the caller has already been through `reviewShellCommand` and the approval gate,
   * because a backgrounded command is the same command with a longer leash, not a
   * less-reviewed one.
   */
  start(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): ShellStartResult {
    const shell = os.platform() === "win32" ? "cmd.exe" : "/bin/bash";
    const args = os.platform() === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

    const child = spawn(shell, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so `stop` can take the whole tree down (nodemon → node →
      // esbuild, or `docker compose up`'s children) instead of orphaning them.
      detached: os.platform() !== "win32",
    });

    const record: BackgroundShellRecord = {
      id: newShellId(),
      command,
      cwd,
      startedAt: Date.now(),
      pid: child.pid,
      totalBytes: 0,
      firstRetainedOffset: 0,
      exitCode: null,
      signal: null,
    };
    const live: LiveShell = { record, child, buffer: [], bufferBytes: 0 };
    this.shells.set(record.id, live);

    // stdout and stderr are merged on purpose: for a dev server the interleaving *is*
    // the log, and separating them loses which error followed which request.
    child.stdout?.on("data", (chunk: Buffer) => this.append(live, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.append(live, chunk));

    child.on("error", (err) => {
      this.append(live, Buffer.from(`\n[spawn error] ${err.message}\n`, "utf-8"));
      this.finish(live, -1, null, undefined);
    });
    child.on("close", (code, signal) => this.finish(live, code, signal, undefined));

    const timer = setTimeout(() => {
      // The leak guard. Reported into the shell's own output so a later
      // `shell_output` sees why the server stopped answering.
      this.append(live, Buffer.from(`\n[inflynx] background shell killed after ${this.maxLifetimeMs.toLocaleString()}ms lifetime cap\n`, "utf-8"));
      this.terminate(live, "timeout");
    }, this.maxLifetimeMs);
    timer.unref?.();
    live.lifetimeTimer = timer;

    return {
      id: record.id,
      pid: record.pid,
      preview: this.snapshot(live).slice(0, PREVIEW_BYTES),
    };
  }

  /** Reads output from `since`, without ever resending what the caller already has. */
  read(id: string, since = 0): ShellReadResult | undefined {
    const live = this.shells.get(id);
    if (!live) return undefined;
    const start = Math.max(0, since);
    const from = Math.max(start, live.record.firstRetainedOffset);
    const data = Buffer.concat(live.buffer).subarray(Math.max(0, from - live.record.firstRetainedOffset));
    // How much of what the caller asked for had already been dropped. Written as
    // `firstRetained - since`: the obvious-looking `min(...) - firstRetained` form is
    // always negative and clamps to zero, which reports "0 bytes were dropped" while
    // simultaneously saying some were.
    const droppedPrefixBytes =
      start < live.record.firstRetainedOffset ? live.record.firstRetainedOffset - start : 0;

    return {
      text: data.toString("utf-8"),
      nextOffset: live.record.totalBytes,
      running: live.record.endedAt === undefined,
      exitCode: live.record.exitCode,
      signal: live.record.signal,
      terminatedReason: live.record.terminatedReason,
      droppedPrefix: start < live.record.firstRetainedOffset,
      droppedPrefixBytes,
    };
  }

  list(): BackgroundShellRecord[] {
    return [...this.shells.values()]
      .map((live) => ({ ...live.record }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): BackgroundShellRecord | undefined {
    return this.shells.get(id)?.record;
  }

  /** Stops one shell (and its process group). Returns false when the id is unknown. */
  stop(id: string): boolean {
    const live = this.shells.get(id);
    if (!live) return false;
    if (live.record.endedAt !== undefined) return true; // already gone; idempotent
    this.terminate(live, "user-stop");
    return true;
  }

  /**
   * Stops everything. Returns the count of shells that were still running, so a
   * shutdown message can be truthful about whether it had to kill anything.
   */
  reapAll(reason: "reaped" | "user-stop" = "reaped"): number {
    let killed = 0;
    for (const live of [...this.shells.values()]) {
      if (live.record.endedAt === undefined) {
        this.terminate(live, reason);
        killed++;
      }
    }
    return killed;
  }

  private append(live: LiveShell, chunk: Buffer): void {
    live.buffer.push(chunk);
    live.bufferBytes += chunk.length;
    live.record.totalBytes += chunk.length;
    // Drop whole chunks from the front until back inside retention.
    while (live.bufferBytes > this.retentionBytes && live.buffer.length > 1) {
      const dropped = live.buffer.shift()!;
      live.bufferBytes -= dropped.length;
      live.record.firstRetainedOffset += dropped.length;
    }
  }

  private snapshot(live: LiveShell): string {
    return Buffer.concat(live.buffer).toString("utf-8");
  }

  private terminate(live: LiveShell, reason: "timeout" | "reaped" | "user-stop"): void {
    const { child, record } = live;
    record.terminatedReason = reason;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (os.platform() !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    killGroup("SIGTERM");
    const escalation = setTimeout(() => {
      if (record.endedAt === undefined) killGroup("SIGKILL");
    }, 2_000);
    escalation.unref?.();
    if (record.endedAt === undefined) this.finish(live, null, "SIGTERM", reason);
  }

  private finish(
    live: LiveShell,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    reasonOverride?: "timeout" | "reaped" | "user-stop"
  ): void {
    if (live.record.endedAt !== undefined) return;
    live.record.endedAt = Date.now();
    live.record.exitCode = exitCode;
    live.record.signal = signal;
    if (reasonOverride) live.record.terminatedReason = reasonOverride;
    if (live.lifetimeTimer) clearTimeout(live.lifetimeTimer);
    try {
      live.child.stdout?.removeAllListeners("data");
      live.child.stderr?.removeAllListeners("data");
    } catch {
      /* stream already torn down */
    }
  }
}

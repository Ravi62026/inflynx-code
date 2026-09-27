/**
 * Temp-directory cleanup for the test suites.
 *
 * Backlog M10 caught tests writing into the developer's repo, and the fix was "use a temp
 * dir". That is only half of it: a suite that creates `/tmp/inflynx-plan-XXXXXX` and never
 * removes it has simply moved the litter somewhere it does not show up in `git status`.
 * 48 such directories had accumulated from one suite alone.
 *
 * `finally` is not enough here, because several older suites report failure with
 * `process.exit(1)` — which skips pending `finally` blocks. The `exit` hook does run on
 * `process.exit`, so cleanup registered here covers the passing path *and* the failing one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pending = new Set<string>();

process.on("exit", () => {
  for (const dir of pending) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A cleanup failure must not change a test's verdict, and at exit nothing can be
      // awaited. The path stays in the report below so the leak is still visible.
      console.error(`[tests] could not remove temp dir on exit: ${dir}`);
    }
  }
  pending.clear();
});

/** Removes `dir` when the process exits, however it exits. Returns it for chaining. */
export function cleanupOnExit(dir: string): string {
  pending.add(dir);
  return dir;
}

/** `fs.mkdtempSync(os.tmpdir()/prefix)` plus guaranteed removal. */
export function makeTempRoot(prefix: string): string {
  return cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** How many temp roots this process created and has not yet released. */
export function pendingCleanupCount(): number {
  return pending.size;
}

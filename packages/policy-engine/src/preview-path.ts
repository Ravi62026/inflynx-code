/**
 * Preview-path policy (backlog N6).
 *
 * A diff preview is rendered *before* anything is approved, which makes it a read that no
 * tool call authorised. The CLI used to resolve the proposed path itself —
 * `path.isAbsolute(p) ? p : join(root, p)` — and then `readFileSync`, so a proposal naming
 * `/Users/me/.ssh/id_rsa` printed that file's contents into the approval screen even though
 * the write was correctly refused a moment later. Two path authorities, one of them
 * unguarded, is exactly the failure this repo has been removing everywhere else.
 *
 * Lives next to `CanonicalPathGuard` rather than in the CLI so every surface that renders a
 * preview (terminal, extension webview, anything added later) answers the same question with
 * the same function.
 */

import fs from "fs";
import path from "path";
import { CanonicalPathGuard } from "./path-guard.js";

/** A preview is not a reason to load a huge file into memory before anything is approved. */
export const PREVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024;

export type PreviewResolution =
  | { ok: true; absPath: string; /** Relative to the workspace root, for display. */ displayName: string }
  | { ok: false; reason: string };

/**
 * Decide whether a *proposed* path may be read for preview, using the same guard the
 * gateway will use when it executes.
 *
 * Returning a reason rather than throwing is deliberate: the caller has to show the human
 * why there is no diff, in the place where the diff would have been.
 */
export function resolvePreviewPath(
  guard: CanonicalPathGuard | null | undefined,
  rawPath: string,
  maxBytes = PREVIEW_MAX_FILE_BYTES
): PreviewResolution {
  if (!guard) return { ok: false, reason: "no active session — nothing to resolve the path against" };
  if (!rawPath || !rawPath.trim()) return { ok: false, reason: "the proposal carries no path, so there is nothing to preview" };

  const root = guard.getWorkspaceRoot();
  let absPath: string;
  try {
    absPath = guard.validateAndResolve(rawPath);
  } catch (err: any) {
    return { ok: false, reason: `"${rawPath}" was rejected by the path guard: ${err?.message || String(err)}` };
  }

  // The guard resolves symlinks and blocks traversal; this check is the belt to that
  // braces, and it is what a reviewer of this function should be able to see at a glance.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    return { ok: false, reason: `"${rawPath}" resolves outside this workspace, so it will not be read` };
  }

  if (fs.existsSync(absPath)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (err: any) {
      return { ok: false, reason: `"${rawPath}" could not be inspected: ${err?.message || String(err)}` };
    }
    if (stat.isDirectory()) return { ok: false, reason: `"${rawPath}" is a directory — there is no file to diff` };
    if (!stat.isFile()) return { ok: false, reason: `"${rawPath}" is not a regular file` };
    if (stat.size > maxBytes) {
      return {
        ok: false,
        reason:
          `"${rawPath}" is ${(stat.size / 1048576).toFixed(1)} MB, above the ` +
          `${(maxBytes / 1048576).toFixed(0)} MB a preview will read — approve or deny without one`,
      };
    }
  }

  const displayName = path.relative(root, absPath) || ".";
  return { ok: true, absPath, displayName };
}

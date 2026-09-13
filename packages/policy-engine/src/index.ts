/**
 * @inflynx/policy-engine
 * Sandbox execution profiles, canonical symlink-safe path guards, and command policies.
 */

export { CanonicalPathGuard } from "./path-guard.js";
export { CommandPolicy } from "./command-policy.js";
export { validatePublicUrl } from "./ssrf-guard.js";

export type SandboxProfile = "read-only" | "workspace-write" | "full-access";

export interface PolicyRule {
  name: string;
  sandboxProfile: SandboxProfile;
  allowedPaths: string[];
  blockedCommands: RegExp[];
  requireConfirmationOnWrite: boolean;
}

/**
 * Symlink-safe workspace boundary validator (backward compatible interface).
 * Uses realpath resolution under the hood.
 */
export function validateWorkspaceBoundary(targetPath: string, workspaceRoot: string): boolean {
  try {
    const { CanonicalPathGuard } = require("./path-guard.js");
    const guard = new CanonicalPathGuard(workspaceRoot);
    guard.validateAndResolve(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @inflynx/policy-engine
 * Sandbox execution profiles & permission guards.
 */

export type SandboxProfile = "read-only" | "workspace-write" | "full-access";

export interface PolicyRule {
  name: string;
  sandboxProfile: SandboxProfile;
  allowedPaths: string[];
  blockedCommands: RegExp[];
  requireConfirmationOnWrite: boolean;
}

export function validateWorkspaceBoundary(targetPath: string, workspaceRoot: string): boolean {
  return targetPath.startsWith(workspaceRoot) && !targetPath.includes("..");
}

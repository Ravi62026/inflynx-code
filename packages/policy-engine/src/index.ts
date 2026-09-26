/**
 * @inflynx/policy-engine
 * Canonical symlink-safe path guards, shell command review, and execution audit.
 */

export { CanonicalPathGuard } from "./path-guard.js";
export { CommandPolicy } from "./command-policy.js";
export { validatePublicUrl } from "./ssrf-guard.js";

export {
  auditFieldsFromReview,
  appendShellAudit,
  getShellAuditPath,
  hashShellOutput,
  readShellAudit,
  SHELL_AUDIT_RELATIVE_PATH,
  type ShellApprovalSource,
  type ShellAuditEntry,
  type ShellAuditRecord,
} from "./shell-audit.js";

export {
  formatReviewForUser,
  getUserShellRulesPath,
  loadUserShellRules,
  parseShellSegments,
  reviewShellCommand,
  setUserShellRules,
  type JoinOperator,
  type SegmentVerdict,
  type ShellCommandReview,
  type ShellDecision,
  type ShellFeatures,
  type ShellSegment,
  type UserShellRules,
} from "./shell-rules.js";

// NOTE: this file used to export `validateWorkspaceBoundary()` and the
// `SandboxProfile` / `PolicyRule` types. Nothing called them, the function used
// `require()` inside an ES module (so it would have thrown the first time anyone did),
// and the types described an OS-sandbox feature the product does not have — which is
// the worst kind of dead code, because it advertises a security boundary that is not
// there. The real boundaries are `CanonicalPathGuard` (paths), `reviewShellCommand`
// (commands) and the approval flow (intent). Backlog Phase 20.

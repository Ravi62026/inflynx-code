import { AgentEventBus } from "@inflynx/protocol";
import { reviewPatchSafety } from "@inflynx/patch-engine";
import type { DiagnosticError } from "./FailureParser.js";

export interface RepairSafetyCheckResult {
  isSafe: boolean;
  violationReason?: string;
  /** Every rule that fired, not just the first — a human deciding an override sees all of them. */
  violations?: string[];
}

/**
 * The repair-loop telemetry and the (thin) safety façade.
 *
 * The fake-fix rules themselves deliberately do **not** live here. They used to, in a
 * private table of five patterns that no product path ever called — which is how
 * backlog C13 stayed half-open: the check existed, looked authoritative, and enforced
 * nothing. They now live in `@inflynx/patch-engine`'s `patch-safety.ts`, next to the
 * gateway step that enforces them, so the enforcement path and this compatibility
 * wrapper cannot drift into disagreeing about what a fake fix is.
 */
export class RepairLoop {
  constructor(
    private sessionId: string,
    private eventBus?: AgentEventBus
  ) {}

  /**
   * Evaluates proposed repair replacement code for anti-patterns: suppressed
   * diagnostics, skipped or deleted tests, assertions that cannot fail.
   */
  validatePatchSafety(targetCode: string, replacementCode: string): RepairSafetyCheckResult {
    const review = reviewPatchSafety({ before: targetCode, after: replacementCode });
    if (review.safe) return { isSafe: true };
    return {
      isSafe: false,
      violationReason: review.violations.map((v) => v.reason).join(" "),
      violations: review.violations.map((v) => v.rule),
    };
  }

  /**
   * Emits repair attempt telemetry event.
   */
  notifyRepairAttempt(attemptNumber: number, maxRetries: number, errors: DiagnosticError[]): void {
    this.eventBus?.emit("repair.attempted", this.sessionId, {
      attemptNumber,
      maxRetries,
      errorCount: errors.length,
      topError: errors[0]?.message || "Unknown error",
    });
  }
}

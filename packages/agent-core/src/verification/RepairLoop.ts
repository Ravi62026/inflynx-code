import { AgentEventBus } from "@inflynx/protocol";
import type { DiagnosticError } from "./FailureParser.js";

export interface RepairSafetyCheckResult {
  isSafe: boolean;
  violationReason?: string;
}

export class RepairLoop {
  private static FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\/\/\s*@ts-ignore/, reason: "Addition of @ts-ignore directive to suppress compiler errors" },
    { pattern: /\/\/\s*@ts-expect-error/, reason: "Addition of @ts-expect-error directive to bypass type checking" },
    { pattern: /\/\*\s*eslint-disable/, reason: "Addition of eslint-disable comment block to bypass linter rules" },
    { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, reason: "Empty catch block swallowing errors silently without handling" },
    { pattern: /(?:it|test)\.skip\(/, reason: "Skipping failing test cases (.skip) instead of fixing underlying defect" },
  ];

  constructor(
    private sessionId: string,
    private eventBus?: AgentEventBus
  ) {}

  /**
   * Evaluates proposed repair replacement code for anti-patterns.
   * Rejects fake fixes like disabling tests, suppressing type errors, or empty catch blocks.
   */
  validatePatchSafety(targetCode: string, replacementCode: string): RepairSafetyCheckResult {
    // 1. Check for forbidden comment directives / empty catch blocks
    for (const { pattern, reason } of RepairLoop.FORBIDDEN_PATTERNS) {
      if (pattern.test(replacementCode) && !pattern.test(targetCode)) {
        return {
          isSafe: false,
          violationReason: `Anti-Pattern Rejected: ${reason}. Fix the root cause instead of suppressing diagnostics.`,
        };
      }
    }

    // 2. Check for assertion deletion: count expect/assert statements in target vs replacement
    const targetAsserts = (targetCode.match(/(?:expect|assert)\s*\(/g) || []).length;
    const replacementAsserts = (replacementCode.match(/(?:expect|assert)\s*\(/g) || []).length;

    if (targetAsserts > 0 && replacementAsserts < targetAsserts) {
      return {
        isSafe: false,
        violationReason: `Anti-Pattern Rejected: Patch deletes ${targetAsserts - replacementAsserts} test assertion(s). Tests cannot be removed to pass verification.`,
      };
    }

    return { isSafe: true };
  }

  /**
   * Emits repair attempt telemetry event.
   */
  notifyRepairAttempt(attemptNumber: number, maxRetries: number, errors: DiagnosticError[]): void {
    this.eventBus?.emit("repair.attempted" as any, this.sessionId, {
      attemptNumber,
      maxRetries,
      errorCount: errors.length,
      topError: errors[0]?.message || "Unknown error",
    });
  }
}

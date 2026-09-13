import fs from "fs";
import path from "path";
import { CommandPolicy } from "@inflynx/policy-engine";
import { AgentEventBus } from "@inflynx/protocol";
import { FailureParser, type DiagnosticError } from "./FailureParser.js";

export interface VerificationCheck {
  id: string;
  name: string;
  type: "typecheck" | "test" | "lint" | "build" | "custom";
  command: string;
  args: string[];
  timeoutMs: number;
  isGate: boolean;
}

export interface VerificationResult {
  checkId: string;
  checkName: string;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsedErrors: DiagnosticError[];
}

export interface SuiteSummary {
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  results: VerificationResult[];
  summaryMessage: string;
}

export class VerificationEngine {
  constructor(
    private sessionId: string,
    private eventBus?: AgentEventBus
  ) {}

  /**
   * Auto-discovers project verification check commands from package.json metadata.
   */
  discoverWorkspaceChecks(workspaceRoot: string): VerificationCheck[] {
    const checks: VerificationCheck[] = [];
    const pkgPath = path.join(workspaceRoot, "package.json");

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};

        if (scripts.typecheck) {
          checks.push({
            id: "typecheck",
            name: "TypeScript Typecheck",
            type: "typecheck",
            command: "pnpm",
            args: ["typecheck"],
            timeoutMs: 45_000,
            isGate: true,
          });
        }

        if (scripts.build) {
          checks.push({
            id: "build",
            name: "Project Build",
            type: "build",
            command: "pnpm",
            args: ["build"],
            timeoutMs: 60_000,
            isGate: true,
          });
        }

        if (scripts.test) {
          checks.push({
            id: "test",
            name: "Unit & Integration Tests",
            type: "test",
            command: "pnpm",
            args: ["test"],
            timeoutMs: 90_000,
            isGate: true,
          });
        }

        if (scripts.lint) {
          checks.push({
            id: "lint",
            name: "ESLint Linter",
            type: "lint",
            command: "pnpm",
            args: ["lint"],
            timeoutMs: 30_000,
            isGate: false,
          });
        }
      } catch { /* ignore package.json read error */ }
    }

    // Default fallback: TypeScript compiler check if tsconfig.json exists
    if (checks.length === 0 && fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
      checks.push({
        id: "tsc_check",
        name: "TypeScript Compiler Check",
        type: "typecheck",
        command: "npx",
        args: ["tsc", "--noEmit"],
        timeoutMs: 45_000,
        isGate: true,
      });
    }

    return checks;
  }

  /**
   * Executes a single verification check with diagnostic error parsing.
   */
  async runCheck(
    check: VerificationCheck,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<VerificationResult> {
    const startMs = Date.now();
    let stdout = "";
    let stderr = "";
    let passed = false;

    try {
      stdout = await CommandPolicy.execProcessDirect(
        check.command,
        check.args,
        workspaceRoot,
        check.timeoutMs,
        signal
      );
      passed = true;
    } catch (err: any) {
      passed = false;
      stderr = err.message || String(err);
    }

    const durationMs = Date.now() - startMs;
    const parsedErrors = FailureParser.parseOutput(stdout, stderr);

    return {
      checkId: check.id,
      checkName: check.name,
      passed,
      durationMs,
      stdout,
      stderr,
      parsedErrors,
    };
  }

  /**
   * Executes all discovered verification gates in the workspace.
   */
  async runAllChecks(
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<SuiteSummary> {
    const checks = this.discoverWorkspaceChecks(workspaceRoot);
    const results: VerificationResult[] = [];

    this.eventBus?.emit("verification.started", this.sessionId, { totalChecks: checks.length });

    let suitePassed = true;
    let passedCount = 0;
    let failedCount = 0;

    for (const check of checks) {
      const res = await this.runCheck(check, workspaceRoot, signal);
      results.push(res);

      if (res.passed) {
        passedCount++;
      } else {
        failedCount++;
        if (check.isGate) {
          suitePassed = false;
        }
      }
    }

    const summaryMessage = suitePassed
      ? `✓ Verification Passed: ${passedCount}/${checks.length} checks succeeded.`
      : `❌ Verification Failed: ${failedCount}/${checks.length} checks failed.`;

    this.eventBus?.emit("verification.finished", this.sessionId, {
      passed: suitePassed,
      totalChecks: checks.length,
      passedCount,
      failedCount,
      summaryMessage,
    });

    return {
      passed: suitePassed,
      totalChecks: checks.length,
      passedChecks: passedCount,
      failedChecks: failedCount,
      results,
      summaryMessage,
    };
  }
}

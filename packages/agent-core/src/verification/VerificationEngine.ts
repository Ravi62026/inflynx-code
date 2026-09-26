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
  /**
   * Whether a failure here should fail the turn. `lint` is deliberately not a gate in
   * most repos — treating style as a blocker turns the repair loop into the agent
   * chasing warnings instead of fixing what it broke.
   */
  isGate: boolean;
}

export interface VerificationResult {
  checkId: string;
  checkName: string;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the check was cut off by its own timeout, not by a real failure. */
  timedOut: boolean;
  parsedErrors: DiagnosticError[];
}

export interface SuiteSummary {
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  results: VerificationResult[];
  summaryMessage: string;
  /**
   * The distinction that stops a false green: zero checks means **nothing was
   * verified**, which is not the same as everything passing. Without it a project
   * with no scripts reports `passed: true` and the agent reports "verified".
   */
  noChecksDiscovered: boolean;
  /** Which package manager was used, and how it was chosen. */
  packageManager: PackageManagerResolution;
}

export type VerificationDepth = "basic" | "standard" | "deep";

export interface PackageManagerResolution {
  /** `npm` | `pnpm` | `yarn` | `bun` */
  manager: string;
  /** Why: `packageManager field`, `pnpm-lock.yaml`, `no lockfile found`, … */
  reason: string;
}

export interface VerificationEngineOptions {
  depth?: VerificationDepth;
  /** Run the repo's full suite, or a faster subset when one is declared. */
  runFullRegressionSuite?: boolean;
  /** Multiplier on every default timeout, for slow machines or CI. */
  timeoutScale?: number;
  /** Override the auto-detected package manager (tests, or a monorepo root that lies). */
  packageManager?: string;
}

/** How thorough a check is, ordered so a cheaper depth never runs a deeper one. */
const DEPTH_RANK: Record<VerificationDepth, number> = { basic: 0, standard: 1, deep: 2 };

/** Default ceilings per check type. A gate that times out is not a passed gate. */
const DEFAULT_TIMEOUTS: Record<VerificationCheck["type"], number> = {
  typecheck: 180_000,
  build: 300_000,
  test: 600_000,
  lint: 120_000,
  custom: 180_000,
};

const LOCKFILE_TO_MANAGER: Array<{ file: string; manager: string }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

/**
 * Which runner owns this project's scripts.
 *
 * Was hard-coded to `pnpm`, which silently broke the gate in any repo using npm,
 * yarn or bun: `pnpm build` in a yarn project fails for a reason that has nothing to
 * do with the agent's edits, and the repair loop then "fixes" a phantom problem.
 * Order is deliberate — the `packageManager` field (corepack) outranks lockfile
 * sniffing because a stray lockfile is common in a converted repo.
 */
export function resolvePackageManager(workspaceRoot: string, override?: string): PackageManagerResolution {
  if (override) return { manager: override, reason: "explicitly configured" };

  const pkgPath = path.join(workspaceRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const declared = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
      const match = declared.match(/^(npm|pnpm|yarn|bun)(@|:|$)/);
      if (match) return { manager: match[1], reason: `"packageManager": "${declared}" in package.json` };
    } catch {
      /* unreadable package.json falls through to lockfile detection */
    }
  }

  for (const { file, manager } of LOCKFILE_TO_MANAGER) {
    if (fs.existsSync(path.join(workspaceRoot, file))) {
      return { manager, reason: `${file} present` };
    }
  }
  return { manager: "npm", reason: "no packageManager field and no lockfile found" };
}

export class VerificationEngine {
  private readonly options: Required<Pick<VerificationEngineOptions, "depth" | "runFullRegressionSuite" | "timeoutScale">> &
    VerificationEngineOptions;

  constructor(
    private sessionId: string,
    private eventBus?: AgentEventBus,
    options: VerificationEngineOptions = {}
  ) {
    this.options = {
      depth: options.depth ?? "standard",
      runFullRegressionSuite: options.runFullRegressionSuite ?? true,
      timeoutScale: options.timeoutScale ?? 1,
      packageManager: options.packageManager,
    };
  }

  /**
   * Discovers this workspace's verification checks from `package.json` scripts.
   *
   * Driven by the effort profile's `verificationDepth` rather than always running
   * everything: `basic` is a typecheck, `standard` adds the build, `deep` adds the
   * test suite and lint. The repair loop then gets the cheapest useful signal first.
   */
  discoverWorkspaceChecks(workspaceRoot: string): VerificationCheck[] {
    const checks: VerificationCheck[] = [];
    const pkgPath = path.join(workspaceRoot, "package.json");
    const { manager } = resolvePackageManager(workspaceRoot, this.options.packageManager);
    const scale = this.options.timeoutScale;
    const depth = this.options.depth;

    let scripts: Record<string, string> = {};
    if (fs.existsSync(pkgPath)) {
      try {
        scripts = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).scripts || {};
      } catch { /* a malformed package.json simply yields no scripted checks */ }
    }

    const add = (
      id: string,
      name: string,
      type: VerificationCheck["type"],
      args: string[],
      isGate: boolean,
      minDepth: VerificationDepth
    ) => {
      if (DEPTH_RANK[minDepth] > DEPTH_RANK[depth]) return;
      // Respect the repo's own choice of script name (`typecheck`, `check-types`, …).
      if (!scripts[id]) return;
      checks.push({
        id,
        name,
        type,
        command: manager,
        args,
        timeoutMs: Math.round(DEFAULT_TIMEOUTS[type] * scale),
        isGate,
      });
    };

    add("typecheck", "TypeScript Typecheck", "typecheck", ["run", "typecheck"], true, "basic");
    add("check-types", "TypeScript Typecheck", "typecheck", ["run", "check-types"], true, "basic");
    add("build", "Project Build", "build", ["run", "build"], true, "standard");

    // The regression suite: prefer a fast subset when the effort profile says the
    // full one is not warranted. This repo's own `test` runs every suite (minutes),
    // while `test:unit` is the sub-minute signal the repair loop should iterate on.
    if (DEPTH_RANK.deep <= DEPTH_RANK[depth]) {
      const fast = this.options.runFullRegressionSuite
        ? undefined
        : ["test:unit", "test-unit", "test:fast"].find((s) => scripts[s]);
      const scriptId = fast || (scripts.test ? "test" : "");
      if (scriptId) {
        add(scriptId, fast ? "Unit Tests (fast subset)" : "Unit & Integration Tests", "test", ["run", scriptId], true, "deep");
      }
    }

    add("lint", "ESLint Linter", "lint", ["run", "lint"], false, "deep");

    // Bare `tsc --noEmit` for a TypeScript project with no scripted checks at all.
    if (checks.length === 0 && fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
      checks.push({
        id: "tsc_check",
        name: "TypeScript Compiler Check",
        type: "typecheck",
        command: manager === "pnpm" ? "pnpm" : "npx",
        args: manager === "pnpm" ? ["exec", "tsc", "--noEmit"] : ["tsc", "--noEmit"],
        timeoutMs: Math.round(DEFAULT_TIMEOUTS.typecheck * scale),
        isGate: true,
      });
    }

    return checks;
  }

  /**
   * Runs one check. Non-zero exit is a *result*, not an exception: the previous
   * version let `execProcessDirect` throw and kept only `stderr`, which threw away
   * the test report — the one thing the repair loop needs. Output that arrives on
   * stdout with exit 1 (every test runner ever written) became an empty failure.
   */
  async runCheck(
    check: VerificationCheck,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<VerificationResult> {
    const startMs = Date.now();
    const outcome = await CommandPolicy.execProcessDirectDetailed(
      check.command,
      check.args,
      workspaceRoot,
      check.timeoutMs,
      signal
    );
    const durationMs = Date.now() - startMs;
    const stdout = outcome.output;
    const passed = outcome.exitCode === 0;
    // A timeout and a genuine failure must not look identical, or the agent is sent
    // to "fix" code that was fine and the real problem stays invisible.
    const timedOut = outcome.exitCode !== 0 && durationMs >= check.timeoutMs - 250;

    const stderr = passed
      ? ""
      : [
        timedOut
          ? `[timed out after ${check.timeoutMs.toLocaleString()}ms — this is not a code failure; raise the budget or narrow the check]`
          : "",
        outcome.spawnError === "ENOENT" ? `["${check.command}" is not installed on this machine]` : "",
        outcome.aborted ? "[cancelled by user]" : "",
      ].filter(Boolean).join("\n");

    return {
      checkId: check.id,
      checkName: check.name,
      passed,
      durationMs,
      stdout,
      stderr,
      exitCode: outcome.exitCode,
      timedOut,
      parsedErrors: FailureParser.parseOutput(stdout, stderr),
    };
  }

  /**
   * Executes every discovered verification gate in the workspace.
   */
  async runAllChecks(
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<SuiteSummary> {
    const checks = this.discoverWorkspaceChecks(workspaceRoot);
    const packageManager = resolvePackageManager(workspaceRoot, this.options.packageManager);
    const results: VerificationResult[] = [];

    this.eventBus?.emit("verification.started", this.sessionId, {
      totalChecks: checks.length,
      depth: this.options.depth,
      packageManager: packageManager.manager,
      checks: checks.map((c) => ({ id: c.id, name: c.name, command: `${c.command} ${c.args.join(" ")}`, isGate: c.isGate })),
    });

    let suitePassed = checks.length > 0;
    let passedCount = 0;
    let failedCount = 0;

    for (const check of checks) {
      const res = await this.runCheck(check, workspaceRoot, signal);
      results.push(res);

      if (res.passed) passedCount++;
      else {
        failedCount++;
        if (check.isGate) suitePassed = false;
      }

      this.eventBus?.emit("verification.finished", this.sessionId, {
        checkId: res.checkId,
        checkName: res.checkName,
        passed: res.passed,
        durationMs: res.durationMs,
        errorCount: res.parsedErrors.length,
        topErrors: res.parsedErrors.slice(0, 5).map((e) => e.rawOutput || e.message),
        partial: true,
      });

      // Stop at the first failing gate. A broken typecheck makes the build and the
      // test output mostly noise, and the repair loop wants one clear problem.
      if (!res.passed && check.isGate) break;
    }

    const summaryMessage = checks.length === 0
      ? "⚠ No verification checks configured in this workspace — nothing was verified. This is not a pass."
      : suitePassed
        ? `✓ Verification passed: ${passedCount}/${checks.length} checks succeeded (${packageManager.manager} · ${this.options.depth}).`
        : `❌ Verification failed: ${failedCount} of ${checks.length} checks did not pass.`;

    this.eventBus?.emit("verification.finished", this.sessionId, {
      passed: suitePassed,
      totalChecks: checks.length,
      passedCount,
      failedCount,
      noChecksDiscovered: checks.length === 0,
      packageManager: packageManager.manager,
      depth: this.options.depth,
      summaryMessage,
      results: results.map((r) => ({
        checkId: r.checkId,
        passed: r.passed,
        durationMs: r.durationMs,
        exitCode: r.exitCode,
        errorCount: r.parsedErrors.length,
      })),
    });

    return {
      passed: suitePassed,
      totalChecks: checks.length,
      passedChecks: passedCount,
      failedChecks: failedCount,
      results,
      summaryMessage,
      noChecksDiscovered: checks.length === 0,
      packageManager,
    };
  }
}

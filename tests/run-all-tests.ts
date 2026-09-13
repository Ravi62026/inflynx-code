/**
 * Master Test Runner — Inflynx Code Monorepo Test & Security Evaluation Suite
 *
 * Supports:
 *   --unit         Run only offline unit, security, and benchmark suites
 *   --integration  Run only PostgreSQL & Redis integration suites (requires services up)
 *   --all          Run all suites unconditionally (fails if services offline)
 *   (default)      Runs all unit suites, probes Postgres/Redis, and runs integration
 *                  suites if services are available (skips gracefully if offline)
 */

import { execSync } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");

const unitTestFiles = [
  "tests/unit/policy-engine.test.ts",
  "tests/unit/model-gateway.test.ts",
  "tests/unit/orchestrator.test.ts",
  "tests/unit/orchestrator-gateway.test.ts",
  "tests/unit/phase3-hardening.test.ts",
  "tests/unit/verification.test.ts",
  "tests/unit/debug-finding.test.ts",
  "tests/unit/planning-context.test.ts",
  "tests/unit/patch-engine.test.ts",
  "tests/unit/session-store.test.ts",
  "tests/unit/session-recovery.test.ts",
  "tests/unit/gateway-bypass.test.ts",
  "tests/unit/load-stress.test.ts",
  "tests/unit/vector-store.test.ts",
  "tests/security/security-fixtures.test.ts",
  "tests/evals/bug-eval.test.ts",
  "apps/vscode/tests/index.ts",
];

const integrationTestFiles = [
  "tests/unit/postgres-store.test.ts",
  "tests/integration/concurrency-postgres.test.ts",
  "tests/e2e/live-e2e-demo.test.ts",
];

function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = (open: boolean) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(open);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => cleanup(true));
    socket.once("timeout", () => cleanup(false));
    socket.once("error", () => cleanup(false));
    socket.connect(port, host);
  });
}

function resolveTsxCommand(testFile: string): string {
  const fullTestPath = path.resolve(workspaceRoot, testFile);
  const localTsx = path.resolve(workspaceRoot, "apps/cli/node_modules/.bin/tsx");
  if (fs.existsSync(localTsx)) {
    return `"${localTsx}" "${fullTestPath}"`;
  }
  return `pnpm --filter inflynx-agent exec tsx "${fullTestPath}"`;
}

async function runMasterSuite() {
  const args = process.argv.slice(2);
  const onlyUnit = args.includes("--unit");
  const onlyIntegration = args.includes("--integration");
  const forceAll = args.includes("--all");

  console.log("==================================================================");
  console.log("🚀 STARTING INFLYNX CODE MASTER TEST & SECURITY EVALUATION SUITE");
  console.log("==================================================================\n");

  const pgHost = process.env.POSTGRES_HOST || "localhost";
  const pgPort = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
  const pgAvailable = await isPortOpen(pgHost, pgPort);

  let suitesToRun: string[] = [];
  let skippedIntegration = false;

  if (onlyUnit) {
    suitesToRun = [...unitTestFiles];
  } else if (onlyIntegration) {
    if (!pgAvailable && !forceAll) {
      console.error(`❌ Cannot run integration tests: PostgreSQL is not reachable at ${pgHost}:${pgPort}.`);
      console.error("   Run 'pnpm docker:up' first to bring up the Docker Postgres & Redis containers.\n");
      process.exit(1);
    }
    suitesToRun = [...integrationTestFiles];
  } else if (forceAll) {
    suitesToRun = [...unitTestFiles, ...integrationTestFiles];
  } else {
    // Default mode: always run unit suites; auto-detect integration suites
    suitesToRun = [...unitTestFiles];
    if (pgAvailable) {
      console.log(`🐘 PostgreSQL detected at ${pgHost}:${pgPort} — including integration suites.`);
      suitesToRun.push(...integrationTestFiles);
    } else {
      skippedIntegration = true;
    }
  }

  let passed = 0;
  let failed = 0;

  for (const testFile of suitesToRun) {
    const fullTestPath = path.resolve(workspaceRoot, testFile);
    if (!fs.existsSync(fullTestPath)) continue;

    console.log(`\n================================================================`);
    console.log(`Running Suite: ${testFile}`);
    console.log(`================================================================`);

    try {
      const command = resolveTsxCommand(testFile);
      execSync(command, { stdio: "inherit", cwd: workspaceRoot, env: process.env });
      passed++;
    } catch {
      failed++;
      console.error(`❌ Suite Failed: ${testFile}`);
    }
  }

  console.log(`\n================================================================`);
  console.log(`MASTER TEST SUITE SUMMARY`);
  console.log(`================================================================`);
  console.log(`Total Suites Executed: ${passed + failed}`);
  console.log(`Passed Suites:         ${passed}`);
  console.log(`Failed Suites:         ${failed}`);

  if (skippedIntegration) {
    console.log(`\nℹ️  Note: ${integrationTestFiles.length} integration suites were skipped (PostgreSQL offline).`);
    console.log(`   Run 'pnpm docker:up && pnpm test:integration' to run the Docker integration suite.`);
  }

  if (failed === 0) {
    console.log(`\n🎉 ALL ${passed} RUNNING TEST SUITES PASSED 100% GREEN!`);
    process.exit(0);
  } else {
    console.error(`\n❌ ${failed} TEST SUITE(S) FAILED.`);
    process.exit(1);
  }
}

runMasterSuite().catch((err) => {
  console.error("Master test runner encountered an unhandled error:", err);
  process.exit(1);
});

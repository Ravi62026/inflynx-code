/**
 * Integration Test for Phase 4 — Verification Engine & Repair Loop Anti-Pattern Guards
 */

import { FailureParser } from "../../packages/agent-core/src/verification/FailureParser.js";
import { VerificationEngine } from "../../packages/agent-core/src/verification/VerificationEngine.js";
import { RepairLoop } from "../../packages/agent-core/src/verification/RepairLoop.js";

async function runPhase4Tests() {
  console.log("🧪 Running Phase 4 Verification Engine & Anti-Pattern Repair Loop Tests...\n");

  // Test 1: FailureParser — TypeScript Error Output
  const rawTscOutput = `
src/index.ts(15,22): error TS2307: Cannot find module '@inflynx/policy-engine' or its corresponding type declarations.
src/utils.ts(45,10): error TS2322: Type 'string' is not assignable to type 'number'.
  `;
  const tsErrors = FailureParser.parseTypeScriptErrors(rawTscOutput);

  if (tsErrors.length === 2 && tsErrors[0].code === "TS2307" && tsErrors[0].line === 15 && tsErrors[0].column === 22) {
    console.log("✓ Test 1 Passed: FailureParser extracted TypeScript diagnostics correctly ->", tsErrors.length, "errors");
  } else {
    console.error("❌ Test 1 Failed: Unexpected TypeScript parsing output:", tsErrors);
    process.exit(1);
  }

  // Test 2: FailureParser — Test Runner Output
  const rawTestOutput = `
FAIL tests/unit/policy-engine.test.ts
  ✕ Test 4: Destructive shell command was not blocked!
  AssertionError: expected command to throw
  `;
  const testErrors = FailureParser.parseTestRunnerErrors(rawTestOutput);

  if (testErrors.length > 0 && testErrors.some((e) => e.message.includes("FAIL"))) {
    console.log("✓ Test 2 Passed: FailureParser extracted test runner failure diagnostic ->", testErrors[0].message);
  } else {
    console.error("❌ Test 2 Failed: Unexpected test runner parsing output:", testErrors);
    process.exit(1);
  }

  // Test 3: VerificationEngine — Auto Discovery of Monorepo Package Checks
  const engine = new VerificationEngine("sess_verify_1");
  const checks = engine.discoverWorkspaceChecks(process.cwd());

  if (checks.length > 0 && checks.some((c) => c.id === "build" || c.id === "typecheck" || c.id === "test" || c.id === "tsc_check")) {
    console.log(`✓ Test 3 Passed: VerificationEngine discovered ${checks.length} workspace checks:`, checks.map((c) => c.name).join(", "));
  } else {
    console.error("❌ Test 3 Failed: Verification checks discovery failed!", checks);
    process.exit(1);
  }

  // Test 4: RepairLoop — Anti-Pattern Safety Guard (Reject @ts-ignore)
  const repairLoop = new RepairLoop("sess_repair_1");
  const dangerousPatch1 = repairLoop.validatePatchSafety(
    'const x: number = "hello";',
    '// @ts-ignore\nconst x: number = "hello";'
  );

  if (!dangerousPatch1.isSafe && dangerousPatch1.violationReason?.includes("Anti-Pattern Rejected")) {
    console.log("✓ Test 4 Passed: RepairLoop rejected @ts-ignore anti-pattern ->", dangerousPatch1.violationReason);
  } else {
    console.error("❌ Test 4 Failed: Anti-pattern @ts-ignore was not rejected!", dangerousPatch1);
    process.exit(1);
  }

  // Test 5: RepairLoop — Anti-Pattern Safety Guard (Reject Assertion Deletion)
  const dangerousPatch2 = repairLoop.validatePatchSafety(
    'it("tests foo", () => { expect(foo()).toBe(true); expect(bar()).toBe(true); });',
    'it("tests foo", () => { });'
  );

  if (!dangerousPatch2.isSafe && dangerousPatch2.violationReason?.includes("deletes 2 test assertion(s)")) {
    console.log("✓ Test 5 Passed: RepairLoop rejected test assertion deletion anti-pattern ->", dangerousPatch2.violationReason);
  } else {
    console.error("❌ Test 5 Failed: Assertion deletion was not rejected!", dangerousPatch2);
    process.exit(1);
  }

  console.log("\n🎉 All Phase 4 Verification Engine Tests Passed Successfully!");
}

runPhase4Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

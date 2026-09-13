/**
 * Integration Test for Phase 5 — FindingEngine & Evidence-First Debugging
 */

import { FindingEngine, type BugFinding } from "../../packages/agent-core/src/debug/FindingEngine.js";

async function runPhase5Tests() {
  console.log("🧪 Running Phase 5 Evidence-First Debugging & Finding Engine Tests...\n");

  const engine = new FindingEngine();

  // Test 1: Verified Defect Registration (Confidence >= 0.70 with evidence)
  const finding1 = engine.addFinding({
    severity: "critical",
    category: "security",
    title: "Path Traversal via Symlink Escape",
    targetFile: "packages/policy-engine/src/index.ts",
    lineStart: 16,
    evidence: {
      reproductionCommand: "npx tsx tests/security/symlink-escape.ts",
      stackTrace: "Security Policy Violation: Path resolves outside workspace",
    },
    impact: "Arbitrary file read access outside workspace root",
    rootCause: "validateWorkspaceBoundary uses string prefix matching without fs.realpathSync resolution",
    confidenceScore: 0.95,
    verificationStatus: "reproduced",
    suggestedFix: "Use CanonicalPathGuard with fs.realpathSync",
  });

  if (finding1.verificationStatus === "reproduced" && finding1.confidenceScore === 0.95) {
    console.log("✓ Test 1 Passed: Verified finding registered cleanly with reproduction evidence.");
  } else {
    console.error("❌ Test 1 Failed: Finding status or confidence corrupted:", finding1);
    process.exit(1);
  }

  // Test 2: Unverified Defect Conversion to Hypothesis (Missing evidence or low confidence)
  const finding2 = engine.addFinding({
    severity: "high",
    category: "race_condition",
    title: "Possible Cache Invalidation Race Condition",
    targetFile: "packages/tool-runtime/src/index.ts",
    evidence: {}, // NO reproduction evidence attached!
    impact: "Stale search results",
    rootCause: "Concurrent tool call state updates",
    confidenceScore: 0.85,
    verificationStatus: "reproduced",
  });

  if (finding2.verificationStatus === "hypothesis" && finding2.confidenceScore === 0.65) {
    console.log("✓ Test 2 Passed: Finding without evidence automatically downgraded to 'hypothesis'.");
  } else {
    console.error("❌ Test 2 Failed: Lack of evidence was not enforced!", finding2);
    process.exit(1);
  }

  // Test 3: Health Score Calculation
  const healthScore = engine.calculateHealthScore();
  // Critical (-25), High/Security (-15) -> 100 - 25 - 15 = 60
  if (healthScore === 60) {
    console.log(`✓ Test 3 Passed: Codebase health score calculated correctly -> ${healthScore}/100`);
  } else {
    console.error(`❌ Test 3 Failed: Health score expected 60, got ${healthScore}`);
    process.exit(1);
  }

  // Test 4: CodeRabbit-Style Markdown Report Generation
  const reportMd = engine.generateMarkdownReport("Security & Boundary Audit");
  if (reportMd.includes("# 🐞 Debug & Code Review Report") && reportMd.includes("Path Traversal via Symlink Escape")) {
    console.log("✓ Test 4 Passed: CodeRabbit-style markdown report generated successfully.");
  } else {
    console.error("❌ Test 4 Failed: Markdown report output invalid:", reportMd);
    process.exit(1);
  }

  console.log("\n🎉 All Phase 5 Evidence-First Debugging Tests Passed Successfully!");
}

runPhase5Tests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

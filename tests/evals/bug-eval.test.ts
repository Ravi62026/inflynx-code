/**
 * Bug Finding Benchmark Evaluation Suite
 */

import { FindingEngine, type BugFinding } from "../../packages/agent-core/src/debug/FindingEngine.js";

async function runBugEvalSuite() {
  console.log("📊 Running Bug Finding Benchmark Evaluation Suite...\n");

  const engine = new FindingEngine();

  // Benchmark Defect Case 1: Null Pointer Dereference in Streaming Message Format
  const defect1 = engine.addFinding({
    severity: "high",
    category: "correctness",
    title: "Null Dereference in Message Stream Parser",
    targetFile: "packages/model-gateway/src/index.ts",
    lineStart: 104,
    evidence: {
      reproductionCommand: "pnpm --filter inflynx-agent exec tsx ../../tests/unit/model-gateway.test.ts",
      stackTrace: "TypeError: Cannot read properties of undefined (reading 'type')",
      codeSnippet: "if (parsed.content_block.type === 'tool_use')",
    },
    impact: "Agent stream crash when receiving unformatted SSE delta chunk",
    rootCause: "Unchecked optional chaining on parsed.content_block property",
    confidenceScore: 0.90,
    verificationStatus: "reproduced",
    suggestedFix: "Use optional chaining: parsed.content_block?.type",
  });

  // Benchmark Defect Case 2: Race Condition in Concurrent File Edit Lock
  const defect2 = engine.addFinding({
    severity: "medium",
    category: "race_condition",
    title: "Un-gated Concurrent Patch Transaction",
    targetFile: "packages/patch-engine/src/index.ts",
    evidence: {
      reproductionCommand: "pnpm --filter inflynx-agent exec tsx ../../tests/unit/patch-engine.test.ts",
      stackTrace: "Error: File content changed during transaction commit",
    },
    impact: "Overwriting concurrent manual edits during 2-phase commit",
    rootCause: "Target file hash check missing before renameSync",
    confidenceScore: 0.85,
    verificationStatus: "reproduced",
  });

  const findings = engine.getFindings();
  const healthScore = engine.calculateHealthScore();

  if (findings.length === 2 && healthScore === 77) {
    console.log(`✓ Benchmark Suite Passed: Benchmark evaluation findings processed accurately (Health Score: ${healthScore}/100).`);
  } else {
    console.error("❌ Benchmark Suite Failed: Unexpected evaluation results!", findings);
    process.exit(1);
  }

  console.log("\n🎉 All Bug Finding Evaluation Benchmark Tests Passed 100%!");
}

runBugEvalSuite().catch((err) => {
  console.error("Bug eval test failed:", err);
  process.exit(1);
});

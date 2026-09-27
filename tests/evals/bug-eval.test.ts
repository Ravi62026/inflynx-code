/**
 * Bug Finding Benchmark — Phase 45.
 *
 * Used to be a tautology: add two findings, assert `getFindings().length === 2` and a
 * hardcoded health score of `77`. That reads back what it wrote and pins a magic number — it
 * can never go red when scoring changes. The real detector eval now lives in
 * `detector-eval.test.ts`; what remains here is a *property* test of the finding store: the
 * health score must move with severity, must release a fixed finding, and must floor at zero
 * — computed from the rule, not compared to a constant.
 */

import assert from "node:assert/strict";
import { FindingEngine, type BugFinding } from "../../packages/agent-core/src/debug/FindingEngine.js";

function finding(over: Partial<BugFinding>): BugFinding {
  return {
    id: "",
    severity: "medium", category: "correctness", title: "t", targetFile: "a.ts",
    evidence: { stackTrace: "repro" }, impact: "", rootCause: "", confidenceScore: 0.9,
    verificationStatus: "reproduced", ...over,
  } as BugFinding;
}

async function runBugEvalSuite(): Promise<void> {
  console.log("📊 Running Bug Finding Benchmark (property-based scoring)...\n");

  // Empty → 100.
  assert.equal(new FindingEngine().calculateHealthScore(), 100);

  // A finding strictly lowers the score; a more severe one lowers it further.
  const low = new FindingEngine(); low.addFinding(finding({ severity: "low" }));
  const crit = new FindingEngine(); crit.addFinding(finding({ severity: "critical" }));
  assert.ok(crit.calculateHealthScore() < low.calculateHealthScore(),
    "a critical finding did not hurt the score more than a low one");

  // "fixed" is excluded from scoring — a finding added as fixed leaves the score at 100,
  // while the same finding open drops it. (addFinding always mints a new id; there is no
  // upsert, so the exclusion is tested at add-time, not by mutating a stored finding.)
  const e = new FindingEngine();
  e.addFinding(finding({ severity: "high", verificationStatus: "fixed" }));
  assert.equal(e.calculateHealthScore(), 100, "a fixed finding was still counted against the score");
  e.addFinding(finding({ severity: "high", verificationStatus: "reproduced" }));
  assert.ok(e.calculateHealthScore() < 100, "an open high finding did not lower the score");

  // Floor: a pile of criticals can never go below zero.
  const pile = new FindingEngine();
  for (let i = 0; i < 20; i++) pile.addFinding(finding({ severity: "critical" }));
  assert.ok(pile.calculateHealthScore() >= 0, "the health score went negative");

  // Report numbers are derived from the findings, not asserted against constants.
  const report = new FindingEngine();
  report.addFinding(finding({ severity: "critical", category: "security" }));
  report.addFinding(finding({ severity: "low" }));
  const md = report.generateMarkdownReport("audit");
  assert.match(md, /Health Score/i);
  assert.ok(md.includes("Critical"), "the report omitted the critical count");

  console.log("✓ Scoring is monotone in severity, releases fixed findings, and floors at 0 — no magic constant.\n");
  console.log("🎉 All Bug Finding Benchmark tests passed.");
}

runBugEvalSuite().catch((err) => { console.error("Bug eval test failed:", err); process.exit(1); });

/**
 * Integration Test for @inflynx/patch-engine — Surgical Patch & Atomic Transactions
 */

import fs from "fs";
import path from "path";
import { applySurgicalPatch, computeUnifiedDiff, EditTransactionManager } from "../../packages/patch-engine/src/index.js";

async function runPatchEngineTests() {
  console.log("🧪 Running @inflynx/patch-engine Unit & Transaction Tests...\n");

  const originalContent = `function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n`;
  const targetSnippet = `return items.reduce((a, b) => a + b, 0);`;
  const replacementSnippet = `return items.reduce((acc, curr) => acc + curr, 0);`;

  // Test 1: Surgical Patch Application
  const patchResult = applySurgicalPatch(originalContent, targetSnippet, replacementSnippet);
  if (patchResult.applied && patchResult.patchedContent.includes("acc + curr")) {
    console.log("✓ Test 1 Passed: Surgical patch applied successfully.");
  } else {
    console.error("❌ Test 1 Failed: Patch application failed!", patchResult);
    process.exit(1);
  }

  // Test 2: Unified Diff Generator
  const diff = computeUnifiedDiff("math.ts", originalContent, patchResult.patchedContent);
  if (diff.includes("math.ts") && diff.includes("return items.reduce")) {
    console.log("✓ Test 2 Passed: Unified diff generated correctly.");
  } else {
    console.error("❌ Test 2 Failed: Unified diff invalid:", diff);
    process.exit(1);
  }

  // Test 3: EditTransactionManager 2-Phase Atomic Commit & Rollback
  const tmpDir = path.join(process.cwd(), ".tmp_test_tx");
  fs.mkdirSync(tmpDir, { recursive: true });

  const file1 = path.join(tmpDir, "file1.txt");
  const file2 = path.join(tmpDir, "file2.txt");

  fs.writeFileSync(file1, "Original File 1", "utf-8");
  fs.writeFileSync(file2, "Original File 2", "utf-8");

  const txManager = new EditTransactionManager();
  txManager.stageFileWrite(file1, "Modified File 1");
  txManager.stageFileWrite(file2, "Modified File 2");

  txManager.commit();
  if (fs.readFileSync(file1, "utf-8") === "Modified File 1" && fs.readFileSync(file2, "utf-8") === "Modified File 2") {
    console.log("✓ Test 3 Passed: 2-Phase atomic transaction committed all files cleanly.");
  } else {
    console.error("❌ Test 3 Failed: Atomic commit failed!");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Test 4: Rollback Staged Patches
  txManager.stageFileWrite(file1, "Uncommitted Edit 1");
  txManager.rollback();
  if (fs.readFileSync(file1, "utf-8") === "Modified File 1") {
    console.log("✓ Test 4 Passed: Staged patches rolled back cleanly.");
  } else {
    console.error("❌ Test 4 Failed: Rollback failed!");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n🎉 All Patch Engine Tests Passed Successfully!");
}

runPatchEngineTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

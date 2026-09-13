/**
 * Unit Test for @inflynx/vector-store
 */

import fs from "fs";
import path from "path";
import { HnswVectorStore, cosineSimilarity, type VectorChunk } from "../../packages/vector-store/src/index.js";

async function runVectorStoreTests() {
  console.log("📐 Running Phase 8 Vector Store & Cosine Similarity Tests...\n");

  // Test 1: Cosine Similarity
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];

  const simIdentical = cosineSimilarity(v1, v2);
  const simOrthogonal = cosineSimilarity(v1, v3);

  if (simIdentical === 1 && simOrthogonal === 0) {
    console.log("✓ Test 1 Passed: Cosine similarity calculation accurate.");
  } else {
    console.error("❌ Test 1 Failed: Similarity calculation invalid!", { simIdentical, simOrthogonal });
    process.exit(1);
  }

  // Test 2: HnswVectorStore Chunk Indexing & Retrieval
  const tmpWorkspace = path.join(process.cwd(), ".tmp_vector_test");
  fs.mkdirSync(tmpWorkspace, { recursive: true });

  const store = new HnswVectorStore(tmpWorkspace);

  const chunk1: VectorChunk = {
    id: "chunk_1",
    filePath: "packages/policy-engine/src/path-guard.ts",
    chunkType: "function",
    symbolName: "validateAndResolve",
    content: "Canonical path guard symlink checks",
    embedding: [0.9, 0.1, 0.0],
  };

  const chunk2: VectorChunk = {
    id: "chunk_2",
    filePath: "packages/policy-engine/src/command-policy.ts",
    chunkType: "function",
    symbolName: "validateShellCommand",
    content: "Command policy shell injection filter",
    embedding: [0.1, 0.9, 0.0],
  };

  store.addChunk(chunk1);
  store.addChunk(chunk2);

  const searchRes = store.searchSimilar([0.85, 0.15, 0.0], 1);
  if (searchRes.length === 1 && searchRes[0].chunk.id === "chunk_1") {
    console.log("✓ Test 2 Passed: Vector search similarity top-K matching succeeded ->", searchRes[0].chunk.symbolName);
  } else {
    console.error("❌ Test 2 Failed: Top-K search mismatch!", searchRes);
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    process.exit(1);
  }

  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  console.log("\n🎉 All Vector Store Tests Passed 100%!");
}

runVectorStoreTests().catch((err) => {
  console.error("Vector store test failed:", err);
  process.exit(1);
});

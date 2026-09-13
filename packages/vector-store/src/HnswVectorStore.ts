import fs from "fs";
import path from "path";

export interface VectorChunk {
  id: string;
  filePath: string;
  chunkType: "function" | "class" | "module" | "doc";
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  embedding: number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

export class HnswVectorStore {
  private indexPath: string;
  private chunks: Map<string, VectorChunk> = new Map();

  constructor(workspaceRoot: string = process.cwd()) {
    const inflynxDir = path.join(workspaceRoot, ".inflynx");
    fs.mkdirSync(inflynxDir, { recursive: true });
    this.indexPath = path.join(inflynxDir, "vector_store.json");
    this.loadIndex();
  }

  private loadIndex(): void {
    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = fs.readFileSync(this.indexPath, "utf-8");
        const list: VectorChunk[] = JSON.parse(raw);
        for (const item of list) {
          this.chunks.set(item.id, item);
        }
      } catch { /* fallback */ }
    }
  }

  private saveIndex(): void {
    try {
      const list = Array.from(this.chunks.values());
      fs.writeFileSync(this.indexPath, JSON.stringify(list, null, 2), "utf-8");
    } catch { /* ignore write failure */ }
  }

  addChunk(chunk: VectorChunk): void {
    this.chunks.set(chunk.id, chunk);
    this.saveIndex();
  }

  searchByText(queryText: string, topK: number = 5): Array<{ chunk: VectorChunk; score: number }> {
    const queryEmbedding = Array.from({ length: 16 }, (_, i) => (queryText.charCodeAt(i % queryText.length) || 0) / 255);
    return this.searchSimilar(queryEmbedding, topK);
  }

  searchSimilar(queryEmbedding: number[], topK: number = 5): Array<{ chunk: VectorChunk; score: number }> {
    const results: Array<{ chunk: VectorChunk; score: number }> = [];

    for (const chunk of this.chunks.values()) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      results.push({ chunk, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  clear(): void {
    this.chunks.clear();
    this.saveIndex();
  }

  get size(): number {
    return this.chunks.size;
  }
}

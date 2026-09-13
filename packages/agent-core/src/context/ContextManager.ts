export interface ContextItem {
  id: string;
  content: string;
  priority: "pinned" | "high" | "medium" | "low" | "ephemeral";
  category: "system" | "user" | "tool_result" | "file_content" | "error" | "plan";
  tokens: number;
  timestamp: number;
  sourcePath?: string;
}

/**
 * @inflynx/agent-core — ContextManager
 * 
 * Token-aware context selection, priority-based compaction, and deduplication engine.
 * Ensures model requests stay strictly within model context window limits.
 */
export class ContextManager {
  private items: ContextItem[] = [];
  private itemCounter = 1;

  constructor(private maxTokenLimit: number = 32000) {}

  getMaxTokenLimit(): number {
    return this.maxTokenLimit;
  }

  setMaxTokenLimit(limit: number): void {
    this.maxTokenLimit = limit;
  }

  /**
   * Estimates token count for a text snippet (~4 chars per token).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Adds a new item to the context manager, deduplicating identical source paths or content.
   */
  addItem(raw: Omit<ContextItem, "id" | "timestamp" | "tokens">): ContextItem {
    // Deduplicate existing item with identical sourcePath if present
    if (raw.sourcePath) {
      this.items = this.items.filter((item) => item.sourcePath !== raw.sourcePath);
    }

    const tokens = this.estimateTokens(raw.content);
    const item: ContextItem = {
      ...raw,
      id: `ctx_${this.itemCounter++}`,
      tokens,
      timestamp: Date.now(),
    };

    this.items.push(item);
    return item;
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }


  /**
   * Compacts context items to fit within `maxTokenLimit`.
   * Retains `pinned` and `high` priority items first, dropping `ephemeral` and `low` priority items as needed.
   */
  compactContext(): ContextItem[] {
    if (this.getTotalTokens() <= this.maxTokenLimit) {
      return [...this.items];
    }

    const priorityWeight: Record<ContextItem["priority"], number> = {
      pinned: 5,
      high: 4,
      medium: 3,
      low: 2,
      ephemeral: 1,
    };

    // Sort items by priority descending, then timestamp descending (recency)
    const sorted = [...this.items].sort((a, b) => {
      const pDiff = priorityWeight[b.priority] - priorityWeight[a.priority];
      if (pDiff !== 0) return pDiff;
      return b.timestamp - a.timestamp;
    });

    const retained: ContextItem[] = [];
    let currentTokens = 0;

    for (const item of sorted) {
      if (item.priority === "pinned" || currentTokens + item.tokens <= this.maxTokenLimit) {
        retained.push(item);
        currentTokens += item.tokens;
      }
    }

    // Re-sort retained items back into chronological order
    this.items = retained.sort((a, b) => a.timestamp - b.timestamp);
    return [...this.items];
  }

  /**
   * Formats all retained context items into a structured prompt block.
   */
  formatContextPrompt(): string {
    const activeItems = this.compactContext();
    return activeItems
      .map((item) => {
        const header = item.sourcePath ? `[Context: ${item.sourcePath}]` : `[Context: ${item.category}]`;
        return `${header}\n${item.content}`;
      })
      .join("\n\n");
  }

  clear(): void {
    this.items = [];
    this.itemCounter = 1;
  }
}

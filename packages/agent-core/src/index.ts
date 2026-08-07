/**
 * @inflynx/agent-core
 * State machine, turn orchestrator, and quantitative context ranker.
 */

export type AgentState =
  | "idle"
  | "planning"
  | "exploring"
  | "implementing"
  | "verifying"
  | "debugging"
  | "reviewing"
  | "completed"
  | "waiting_for_approval"
  | "cancelled"
  | "failed";

export interface TaskStep {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  targetFile?: string;
  verificationCmd?: string;
}

export interface TaskPlan {
  taskId: string;
  goal: string;
  status: AgentState;
  steps: TaskStep[];
}

export interface ContextItem {
  id: string;
  content: string;
  priority: "pinned" | "high" | "medium" | "low" | "ephemeral";
  category: "system" | "user" | "tool_result" | "file_content" | "error" | "plan";
  tokens: number;
  timestamp: number;
  dependencyDistance?: number;
}

export function computeRelevanceScore(
  importance: number,
  recency: number,
  similarity: number,
  dependencyDistance: number = 0
): number {
  return (importance * recency * similarity) / (dependencyDistance + 1);
}

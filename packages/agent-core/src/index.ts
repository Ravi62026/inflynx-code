/**
 * @inflynx/agent-core
 * State machine, turn orchestrator, and quantitative context ranker.
 */

// ─── Execution Mode Types ─────────────────────────────────────────────────────

/** Active execution mode for the agent session */
export type AgentMode = "ask" | "plan" | "agent" | "debug";

/** Tool permission levels allowed per mode */
export const MODE_TOOL_PERMISSIONS: Record<AgentMode, string[]> = {
  ask: ["readonly"],                          // READ ONLY — no mutations
  plan: ["readonly", "readwrite-plan-only"],  // Reads + write to .inflynx/PLAN.md only
  agent: ["readonly", "readwrite", "shell"],  // ALL TOOLS — full autonomous execution
  debug: ["readonly", "readwrite", "shell"],  // ALL TOOLS — CodeRabbit review & debug loop
};

/** Mode metadata used for UI badge and system prompt loading */
export interface ModeConfig {
  mode: AgentMode;
  label: string;
  color: "blue" | "yellow" | "cyan" | "red";
  systemPromptFile: string;
  allowMutating: boolean;
  allowShell: boolean;
  allowPlanWrite: boolean;
}

export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  ask: {
    mode: "ask",
    label: "ask",
    color: "blue",
    systemPromptFile: "prompts/modes/ask.txt",
    allowMutating: false,
    allowShell: false,
    allowPlanWrite: false,
  },
  plan: {
    mode: "plan",
    label: "plan",
    color: "yellow",
    systemPromptFile: "prompts/modes/plan.txt",
    allowMutating: false,
    allowShell: false,
    allowPlanWrite: true,   // Can write .inflynx/PLAN.md only
  },
  agent: {
    mode: "agent",
    label: "agent",
    color: "cyan",
    systemPromptFile: "prompts/modes/agent.txt",
    allowMutating: true,
    allowShell: true,
    allowPlanWrite: true,
  },
  debug: {
    mode: "debug",
    label: "debug",
    color: "red",
    systemPromptFile: "prompts/modes/debug.txt",
    allowMutating: true,
    allowShell: true,
    allowPlanWrite: true,
  },
};

/**
 * Filters tool definitions based on the active execution mode.
 * Returns only the tools allowed for the given mode.
 */
export function filterToolsForMode(
  tools: Array<{ name: string; permissionLevel: string; isMutating?: boolean }>,
  mode: AgentMode
): Array<{ name: string; permissionLevel: string; isMutating?: boolean }> {
  const config = MODE_CONFIGS[mode];

  return tools.filter((tool) => {
    // Shell tools blocked in ask and plan modes
    if (tool.permissionLevel === "shell" && !config.allowShell) return false;

    // Mutating tools blocked in ask mode entirely
    if (tool.isMutating && !config.allowMutating && !config.allowPlanWrite) return false;

    // In plan mode, write_file is allowed but only for plan files
    // The tool itself handles the path restriction via the system prompt
    if (tool.isMutating && config.allowPlanWrite && !config.allowMutating) {
      // Allow write_file in plan mode (system prompt restricts it to .inflynx/PLAN.md)
      if (tool.name === "write_file") return true;
      return false; // Block patch_file, execute_shell, etc.
    }

    return true;
  });
}

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

// ─── Planning Engine ──────────────────────────────────────────────────────────
export { PlanEngine } from "./planning/PlanEngine.js";
export type { ActivePlan, PlanStep, PlanStatus } from "./planning/PlanEngine.js";

// ─── Debug & Review Engine ───────────────────────────────────────────────────
export { DebugEngine } from "./debug/DebugEngine.js";
export type { DebugReportSummary } from "./debug/DebugEngine.js";

// ─── Codebase Graph & Mindmap Engine ─────────────────────────────────────────
export { GraphEngine } from "./graph/GraphEngine.js";



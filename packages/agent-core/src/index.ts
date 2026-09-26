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
  tools: Array<{ name: string; permissionLevel: string; isMutating?: boolean; origin?: string }>,
  mode: AgentMode
): Array<{ name: string; permissionLevel: string; isMutating?: boolean; origin?: string }> {
  const config = MODE_CONFIGS[mode];

  return tools.filter((tool) => {
    // Shell tools blocked in ask and plan modes
    if (tool.permissionLevel === "shell" && !config.allowShell) return false;

    // External tools (MCP servers, plugins) are not offered in ask/plan at all.
    // `ask` promises "read-only, nothing happens" and `plan` promises "only
    // .inflynx/PLAN.md changes" — a third-party process breaks both however harmless
    // its self-declared `readOnlyHint` is, since that hint comes from the very party
    // being trusted (backlog B9). Gated on `allowMutating`, i.e. only the modes that
    // genuinely mean "go and do things".
    const external = tool.origin === "mcp" || tool.origin === "plugin";
    if (external && !config.allowMutating) return false;

    // Mutating tools blocked in ask mode entirely
    if (tool.isMutating && !config.allowMutating && !config.allowPlanWrite) return false;

    // In plan mode the model still needs `write_file`, because producing
    // .inflynx/PLAN.md is the entire purpose of the mode. The restriction to
    // `.inflynx/**` is enforced by `ToolExecutionGateway` (backlog B8), NOT by an
    // instruction in the system prompt — model instructions are not security
    // boundaries, as this project's own maturity plan puts it.
    if (tool.isMutating && config.allowPlanWrite && !config.allowMutating) {
      if (tool.name === "write_file") return true;
      return false; // Block patch_file, execute_shell, etc.
    }

    return true;
  });
}

/**
 * `AgentState` has exactly one definition — the one the StateMachine enforces
 * (see `orchestrator/StateMachine.ts`). This file used to declare a second,
 * different `AgentState` union alongside it, so `TurnResult.state` and the type
 * exported from the barrel disagreed (backlog C8). The dead `TaskPlan`/`TaskStep`
 * interfaces that consumed the duplicate are removed with it; `PlanEngine`'s
 * `ActivePlan`/`PlanStep` are the real, used types.
 */


export function computeRelevanceScore(
  importance: number,
  recency: number,
  similarity: number,
  dependencyDistance: number = 0
): number {
  return (importance * recency * similarity) / (dependencyDistance + 1);
}

// ─── Shared Orchestrator & State Machine ──────────────────────────────────────
export {
  AgentOrchestrator,
  type TurnResult,
  type VerificationReport,
  type VerificationOutcome,
} from "./orchestrator/AgentOrchestrator.js";
export { StateMachine, LEGAL_STATE_TRANSITIONS, type AgentState } from "./orchestrator/StateMachine.js";
export {
  BudgetManager,
  DEFAULT_EFFORT_PROFILES,
  type AgentBudgetLevel,
  type EffortLevel,
  type EffortProfile,
  type BudgetState,
} from "./orchestrator/BudgetManager.js";
export {
  ExecutionContext,
  type ExecutionOptions,
  type ContextStrategy,
  type CompactionPlan,
} from "./orchestrator/ExecutionContext.js";
export { ApprovalProvider, type ToolApprovalRequest, type ApprovalHandler } from "./orchestrator/ApprovalProvider.js";

// ─── Planning Engine ─────────────────────────────────────────────────────────
export { PlanEngine } from "./planning/PlanEngine.js";
export type { ActivePlan, PlanStep, PlanStatus } from "./planning/PlanEngine.js";
export { TaskClassifier, type TaskCategory, type TaskClassificationResult } from "./planning/TaskClassifier.js";
// NOTE: `ContextManager`/`ContextItem` were retired here (backlog Phase 15). It kept a
// separate `ContextItem[]` bag that nothing in the agent ever fed, while real window
// management lives in `ExecutionContext` (eviction + compaction) and `BudgetManager`
// (occupancy). Two competing "context managers" was the bug, not the design.
export { StructuredPlanEngine, type StructuredStepSpec, type StructuredPlanSpec } from "./planning/StructuredPlan.js";

// ─── Debug & Review Engine ───────────────────────────────────────────────────
export { DebugEngine } from "./debug/DebugEngine.js";
export type { DebugReportSummary } from "./debug/DebugEngine.js";
export { FindingEngine, type BugFinding, type FindingSeverity, type FindingCategory, type FindingEvidence } from "./debug/FindingEngine.js";

// ─── Verification Engine & Failure Repair Loop ────────────────────────────────
export {
  VerificationEngine,
  resolvePackageManager,
  type VerificationCheck,
  type VerificationResult,
  type VerificationDepth,
  type VerificationEngineOptions,
  type PackageManagerResolution,
  type SuiteSummary,
} from "./verification/VerificationEngine.js";
export { FailureParser, type DiagnosticError } from "./verification/FailureParser.js";
export { RepairLoop, type RepairSafetyCheckResult } from "./verification/RepairLoop.js";

// ─── Codebase Graph & Mindmap Engine ─────────────────────────────────────────
export { GraphEngine } from "./graph/GraphEngine.js";



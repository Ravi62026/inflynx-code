import type { AgentMode } from "../index.js";
import type { AgentBudgetLevel } from "../orchestrator/BudgetManager.js";

export type TaskCategory =
  | "question"          // Read-only question / code explanation
  | "implementation"    // New feature or architectural change
  | "bug_fix"           // Targeted bug or failure repair
  | "security_audit"    // Security vulnerability assessment
  | "performance";      // Performance & benchmark optimization

export interface TaskClassificationResult {
  category: TaskCategory;
  recommendedMode: AgentMode;
  recommendedEffort: AgentBudgetLevel;
  requiresPlanning: boolean;
  explanation: string;
}

/**
 * @inflynx/agent-core — TaskClassifier
 * 
 * Classifies user tasks into categories and recommends optimal agent execution modes,
 * effort profiles, and structured planning requirements.
 */
export class TaskClassifier {
  /**
   * Analyzes prompt keywords and structure to classify task intent.
   */
  static classify(prompt: string): TaskClassificationResult {
    const pLower = prompt.toLowerCase().trim();

    // 1. Security Audit Task
    if (
      pLower.includes("security") ||
      pLower.includes("audit") ||
      pLower.includes("vulnerability") ||
      pLower.includes("injection") ||
      pLower.includes("traversal") ||
      pLower.includes("coderabbit")
    ) {
      return {
        category: "security_audit",
        recommendedMode: "debug",
        recommendedEffort: "high",
        requiresPlanning: true,
        explanation: "Security audit requested: Recommending [debug] mode with high effort profile for deep vulnerability scanning.",
      };
    }

    // 2. Bug Fix & Failure Repair Task
    if (
      pLower.includes("fix") ||
      pLower.includes("bug") ||
      pLower.includes("error") ||
      pLower.includes("fail") ||
      pLower.includes("crash") ||
      pLower.includes("debug") ||
      pLower.includes("issue")
    ) {
      return {
        category: "bug_fix",
        recommendedMode: "debug",
        recommendedEffort: "medium",
        requiresPlanning: pLower.includes("refactor") || pLower.length > 100,
        explanation: "Bug fix or defect repair task: Recommending [debug] mode with standard repair verification.",
      };
    }

    // 3. Question / Read-Only Advisory Task
    if (
      pLower.startsWith("explain") ||
      pLower.startsWith("what is") ||
      pLower.startsWith("how does") ||
      pLower.startsWith("where is") ||
      pLower.includes("read only") ||
      (pLower.includes("how do i") && !pLower.includes("build") && !pLower.includes("create"))
    ) {
      return {
        category: "question",
        recommendedMode: "ask",
        recommendedEffort: "low",
        requiresPlanning: false,
        explanation: "Read-only advisory question: Recommending [ask] mode for non-mutating explanation.",
      };
    }

    // 4. Large Implementation or Architectural Feature
    if (
      pLower.includes("plan") ||
      pLower.includes("implement") ||
      pLower.includes("architect") ||
      pLower.includes("create feature") ||
      pLower.includes("refactor") ||
      pLower.split(/\s+/).length > 25
    ) {
      return {
        category: "implementation",
        recommendedMode: "plan",
        recommendedEffort: "high",
        requiresPlanning: true,
        explanation: "Complex implementation or architectural task: Recommending [plan] mode to build structured step dependencies before code mutation.",
      };
    }

    // 5. Default General Agent Task
    return {
      category: "implementation",
      recommendedMode: "agent",
      recommendedEffort: "medium",
      requiresPlanning: false,
      explanation: "Standard coding task: Recommending autonomous [agent] execution mode.",
    };
  }
}

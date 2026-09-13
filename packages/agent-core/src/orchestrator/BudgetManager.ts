import { checkRateLimit, type RateLimitResult } from "@inflynx/cache";
import type { ReasoningEffort } from "@inflynx/config";
import { AgentEventBus } from "@inflynx/protocol";

/**
 * Model effort is a provider-normalized request setting. It is deliberately
 * independent of the agent's local safety/cost budget below.
 */
export type EffortLevel = ReasoningEffort;
export type AgentBudgetLevel = "low" | "medium" | "high" | "max";

export interface EffortProfile {
  level: AgentBudgetLevel;
  thinkingBudgetTokens: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxRetries: number;
  maxVerificationRuns: number;
  maxWallClockMs: number;
  maxTotalReasoningTokens: number;
  verificationDepth: "basic" | "standard" | "deep";
  runFullRegressionSuite: boolean;
}

export const DEFAULT_EFFORT_PROFILES: Record<AgentBudgetLevel, EffortProfile> = {
  low: {
    level: "low",
    thinkingBudgetTokens: 3072,
    maxModelTurns: 15,
    maxToolCalls: 30,
    maxRetries: 3,
    maxVerificationRuns: 6,
    maxWallClockMs: 6 * 60 * 1000,
    maxTotalReasoningTokens: 24576,
    verificationDepth: "basic",
    runFullRegressionSuite: false,
  },
  medium: {
    level: "medium",
    thinkingBudgetTokens: 12288,
    maxModelTurns: 45,
    maxToolCalls: 90,
    maxRetries: 9,
    maxVerificationRuns: 15,
    maxWallClockMs: 25 * 60 * 1000,
    maxTotalReasoningTokens: 98304,
    verificationDepth: "standard",
    runFullRegressionSuite: true,
  },
  high: {
    level: "high",
    thinkingBudgetTokens: 24576,
    maxModelTurns: 90,
    maxToolCalls: 225,
    maxRetries: 15,
    maxVerificationRuns: 30,
    maxWallClockMs: 60 * 60 * 1000,
    maxTotalReasoningTokens: 393216,
    verificationDepth: "deep",
    runFullRegressionSuite: true,
  },
  max: {
    level: "max",
    thinkingBudgetTokens: 32768,
    maxModelTurns: 150,
    maxToolCalls: 350,
    maxRetries: 25,
    maxVerificationRuns: 50,
    maxWallClockMs: 120 * 60 * 1000,
    maxTotalReasoningTokens: 1000000,
    verificationDepth: "deep",
    runFullRegressionSuite: true,
  },
};

export interface BudgetState {
  level: AgentBudgetLevel;
  startedAt: number;
  modelTurns: number;
  toolCalls: number;
  readonlyToolCalls: number;
  mutatingToolCalls: number;
  shellCalls: number;
  retries: number;
  verificationRuns: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
}

export class BudgetManager {
  private profile: EffortProfile;
  private state: BudgetState;
  private warnedPercentages = new Set<number>();

  constructor(
    effortLevel: AgentBudgetLevel = "medium",
    private sessionId: string,
    private eventBus: AgentEventBus
  ) {
    this.profile = DEFAULT_EFFORT_PROFILES[effortLevel];
    this.state = {
      level: effortLevel,
      startedAt: Date.now(),
      modelTurns: 0,
      toolCalls: 0,
      readonlyToolCalls: 0,
      mutatingToolCalls: 0,
      shellCalls: 0,
      retries: 0,
      verificationRuns: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  getEffortProfile(): EffortProfile {
    return this.profile;
  }

  getBudgetState(): Readonly<BudgetState> {
    return { ...this.state };
  }

  setBudgetLevel(level: AgentBudgetLevel): void {
    this.profile = DEFAULT_EFFORT_PROFILES[level];
    this.state.level = level;
  }

  recordTurn(): void {
    this.state.modelTurns++;
    this.checkWarningThresholds();
  }

  recordToolCall(permissionLevel: "readonly" | "readwrite" | "shell"): void {
    this.state.toolCalls++;
    if (permissionLevel === "readonly") this.state.readonlyToolCalls++;
    else if (permissionLevel === "readwrite") this.state.mutatingToolCalls++;
    else if (permissionLevel === "shell") this.state.shellCalls++;

    this.checkWarningThresholds();
  }

  recordUsage(usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number; estimatedCostUsd?: number }): void {
    this.state.promptTokens += usage.promptTokens;
    this.state.completionTokens += usage.completionTokens;
    if (usage.reasoningTokens) {
      this.state.reasoningTokens += usage.reasoningTokens;
    }
    if (usage.estimatedCostUsd) {
      this.state.estimatedCostUsd += usage.estimatedCostUsd;
    }
    this.checkWarningThresholds();
  }

  recordRetry(): void {
    this.state.retries++;
  }

  recordVerification(): void {
    this.state.verificationRuns++;
  }

  /**
   * Applies a Redis-backed per-session model-call bucket. Redis is optional
   * and `checkRateLimit()` fails open when it is not configured or unavailable.
   */
  async checkModelRateLimit(): Promise<RateLimitResult> {
    return checkRateLimit(
      `model:${this.sessionId}`,
      this.profile.maxModelTurns,
      60
    );
  }

  /**
   * Checks if any hard limits have been exceeded.
   */
  checkLimits(): { isExhausted: boolean; reason?: string } {
    const elapsedMs = Date.now() - this.state.startedAt;

    if (this.state.modelTurns >= this.profile.maxModelTurns) {
      return { isExhausted: true, reason: `Max model turns reached (${this.state.modelTurns}/${this.profile.maxModelTurns})` };
    }

    if (this.state.toolCalls >= this.profile.maxToolCalls) {
      return { isExhausted: true, reason: `Max tool calls reached (${this.state.toolCalls}/${this.profile.maxToolCalls})` };
    }

    if (elapsedMs >= this.profile.maxWallClockMs) {
      return { isExhausted: true, reason: `Max wall-clock time reached (${Math.round(elapsedMs / 1000)}s/${Math.round(this.profile.maxWallClockMs / 1000)}s)` };
    }

    if (this.state.reasoningTokens >= this.profile.maxTotalReasoningTokens) {
      return { isExhausted: true, reason: `Max reasoning token budget reached (${this.state.reasoningTokens}/${this.profile.maxTotalReasoningTokens})` };
    }

    return { isExhausted: false };
  }

  private checkWarningThresholds(): void {
    const turnRatio = this.state.modelTurns / this.profile.maxModelTurns;
    const toolRatio = this.state.toolCalls / this.profile.maxToolCalls;
    const maxRatio = Math.max(turnRatio, toolRatio);

    const thresholds = [70, 85, 100];
    for (const t of thresholds) {
      if (maxRatio * 100 >= t && !this.warnedPercentages.has(t)) {
        this.warnedPercentages.add(t);
        this.eventBus.emit("budget.warning", this.sessionId, {
          thresholdPercent: t,
          currentTurns: this.state.modelTurns,
          maxTurns: this.profile.maxModelTurns,
          currentToolCalls: this.state.toolCalls,
          maxToolCalls: this.profile.maxToolCalls,
        });
      }
    }
  }
}

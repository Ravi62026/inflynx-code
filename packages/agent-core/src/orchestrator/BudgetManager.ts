import { checkRateLimit, type RateLimitResult } from "@inflynx/cache";
import type { ReasoningEffort } from "@inflynx/config";
import type { Message } from "@inflynx/model-gateway";
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
  /**
   * Occupancy of the *model's window* for the next request, which is not the same
   * thing as the cumulative `promptTokens` above (that sum grows every turn and can
   * never answer "how full is the context?"). 0 when the window is unknown.
   */
  contextUtilizationPercent: number;
  contextWindow: number;
  projectedContextTokens: number;
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
      contextUtilizationPercent: 0,
      contextWindow: 0,
      projectedContextTokens: 0,
    };
  }

  // ─── Context-window accounting ──────────────────────────────────────────────
  private contextWindow = 0;
  private outputTokenCeiling = 0;
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  private messagesAtLastRequest = 0;
  private lastProjectedTokens = 0;

  /** Called by the orchestrator at construction and whenever the model changes. */
  setModelWindow(contextWindow: number, maxOutputTokens: number): void {
    this.contextWindow = Math.max(0, Math.floor(contextWindow || 0));
    this.outputTokenCeiling = Math.max(0, Math.floor(maxOutputTokens || 0));
  }

  get windowKnown(): boolean {
    return this.contextWindow > 0;
  }

  get contextWindowTokens(): number {
    return this.contextWindow;
  }

  get outputLimit(): number {
    return this.outputTokenCeiling;
  }

  /** Records how long the history was when the request went out. */
  noteRequestSent(messageCount: number): void {
    this.messagesAtLastRequest = messageCount;
  }

  /**
   * Projected size of the next request.
   *
   * Anchored on the provider's own `prompt_tokens` for the previous call — the
   * ground truth the gateway already parses and used to discard — and then only the
   * messages appended since are estimated with the crude chars/4 heuristic. The new
   * assistant reply is counted twice (inside `lastCompletionTokens` and in the tail);
   * over-estimating errs towards evicting early, which is the safe direction.
   */
  projectedContextTokens(history: readonly Message[]): number {
    const tail = history.slice(Math.max(0, this.messagesAtLastRequest));
    let chars = 0;
    for (const message of tail) {
      chars += (message.content?.length || 0) + (message.reasoning_content?.length || 0);
      for (const call of message.tool_calls || []) {
        chars += (call.function?.arguments?.length || 0) + 16;
      }
    }
    const projected = Math.max(
      this.lastPromptTokens + this.lastCompletionTokens + Math.ceil(chars / 4),
      Math.ceil((history.reduce((sum, m) => sum + (m.content?.length || 0), 0)) / 4)
    );
    this.lastProjectedTokens = projected;
    return projected;
  }

  /**
   * Lower the anchor after the caller drops content from history.
   *
   * Without this the projection is permanently stuck at whatever the last request
   * measured, so evicting 50k characters would not reduce utilization at all and
   * the loop above would spin without making progress.
   */
  accountForEviction(charsFreed: number): void {
    if (charsFreed <= 0) return;
    this.lastPromptTokens = Math.max(0, this.lastPromptTokens - Math.ceil(charsFreed / 4));
  }

  /**
   * Call after history has been *rewritten* (a compaction spliced messages out),
   * which is different from eviction: `messagesAtLastRequest` is an index into a
   * history that no longer has that shape, so the anchor and the tail boundary are
   * both stale and would under-count what survives.
   *
   * Rather than guess, this falls back to a plain chars/4 estimate of the whole
   * history and re-anchors on the provider's real number at the next response.
   */
  reanchorAfterRewrite(history: readonly Message[]): void {
    const chars = history.reduce(
      (sum, m) => sum + (m.content?.length || 0) + (m.reasoning_content?.length || 0),
      0
    );
    this.lastPromptTokens = Math.ceil(chars / 4);
    this.lastCompletionTokens = 0;
    this.messagesAtLastRequest = history.length;
  }

  /** 0 when the window is unknown, so callers never divide by zero or act on a guess. */
  contextUtilization(history: readonly Message[]): number {
    if (!this.windowKnown) return 0;
    return this.projectedContextTokens(history) / this.contextWindow;
  }

  getEffortProfile(): EffortProfile {
    return this.profile;
  }

  getBudgetState(history?: readonly Message[]): Readonly<BudgetState> {
    const headroom = this.windowKnown ? Math.max(this.outputTokenCeiling, 0) : 0;
    // Pass the live history and the snapshot reports *now*, not whenever the last
    // projection happened to run. Without this, a UI reading `budget` after a
    // compaction still showed the pre-compaction number (backlog Phase 15).
    const projected = history ? this.projectedContextTokens(history) : this.lastProjectedTokens;
    return {
      ...this.state,
      contextWindow: this.contextWindow,
      projectedContextTokens: projected,
      contextUtilizationPercent: this.windowKnown
        ? Math.min(100, Math.round(((projected + headroom) / this.contextWindow) * 100))
        : 0,
    };
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
    // Per-call values, kept separately from the cumulative sums above: these are
    // what context projection is anchored on.
    if (usage.promptTokens > 0) this.lastPromptTokens = usage.promptTokens;
    if (usage.completionTokens > 0) this.lastCompletionTokens = usage.completionTokens;
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

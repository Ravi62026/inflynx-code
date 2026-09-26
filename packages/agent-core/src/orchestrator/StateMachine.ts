import { AgentEventBus } from "@inflynx/protocol";

export type AgentState =
  | "idle"
  | "classifying"
  | "planning"
  | "exploring"
  | "hypothesizing"
  | "implementing"
  | "verifying"
  | "repairing"
  | "reviewing"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const LEGAL_STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["classifying", "planning", "exploring"],
  classifying: ["planning", "exploring", "failed"],
  planning: ["exploring", "waiting_for_approval", "implementing", "failed", "cancelled"],
  // A turn that only reads and answers is a legitimate way to finish: without
  // "completed"/"reviewing" here, every read-only turn ended stranded in
  // "exploring" and reported `isCompleted: false` (surfaced by the loud
  // transition-refusal diagnostic added in Phase 7).
  exploring: ["planning", "hypothesizing", "implementing", "verifying", "reviewing", "completed", "failed", "cancelled"],
  hypothesizing: ["exploring", "implementing", "verifying", "failed", "cancelled"],
  implementing: ["verifying", "failed", "cancelled"],
  verifying: ["reviewing", "repairing", "completed", "failed", "cancelled"],
  repairing: ["implementing", "verifying", "failed", "cancelled"],
  reviewing: ["completed", "failed", "cancelled"],
  waiting_for_approval: ["implementing", "cancelled", "planning", "exploring", "failed"],
  // Terminal states are re-enterable: one session runs many turns. Without these
  // edges the machine froze in `completed` after the first turn and every later
  // transition was silently refused (backlog C7).
  completed: ["idle", "classifying", "planning", "exploring"],
  failed: ["idle", "classifying", "planning", "exploring"],
  cancelled: ["idle", "classifying", "planning", "exploring"],
};

export class StateMachine {
  private currentState: AgentState = "idle";

  constructor(
    private sessionId: string,
    private eventBus: AgentEventBus
  ) {}

  get state(): AgentState {
    return this.currentState;
  }

  /**
   * Checks whether a transition to `nextState` is allowed.
   */
  canTransitionTo(nextState: AgentState): boolean {
    const allowed = LEGAL_STATE_TRANSITIONS[this.currentState];
    return allowed ? allowed.includes(nextState) : false;
  }

  /**
   * Non-throwing variant used by the orchestrator: it reports a refusal instead of
   * swallowing it, which is what allowed the frozen-state bug to stay invisible.
   */
  tryTransitionTo(nextState: AgentState, reason?: string): boolean {
    if (this.currentState === nextState) return true;
    if (!this.canTransitionTo(nextState)) return false;
    this.transitionTo(nextState, reason);
    return true;
  }

  /**
   * Transitions to `nextState` and emits `state.changed` event.
   * Throws Error if transition is illegal.
   */
  transitionTo(nextState: AgentState, reason?: string): void {
    if (this.currentState === nextState) return;

    if (!this.canTransitionTo(nextState)) {
      throw new Error(
        `Illegal State Transition: Cannot transition from "${this.currentState}" to "${nextState}". ` +
        `Allowed transitions: [${(LEGAL_STATE_TRANSITIONS[this.currentState] || []).join(", ")}]`
      );
    }

    const previousState = this.currentState;
    this.currentState = nextState;

    this.eventBus.emit("state.changed", this.sessionId, {
      previousState,
      currentState: nextState,
      reason: reason || `Transitioned to ${nextState}`,
    });
  }

  reset(): void {
    this.currentState = "idle";
  }
}

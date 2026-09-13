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
  exploring: ["planning", "hypothesizing", "implementing", "failed", "cancelled"],
  hypothesizing: ["exploring", "implementing", "verifying", "failed", "cancelled"],
  implementing: ["verifying", "failed", "cancelled"],
  verifying: ["reviewing", "repairing", "completed", "failed", "cancelled"],
  repairing: ["implementing", "verifying", "failed", "cancelled"],
  reviewing: ["completed", "failed", "cancelled"],
  waiting_for_approval: ["implementing", "cancelled", "planning"],
  completed: ["idle"],
  failed: ["idle"],
  cancelled: ["idle"],
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

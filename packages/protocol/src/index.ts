/**
 * @inflynx/protocol
 * Public event protocol, typed event bus, and schema definitions.
 */

export type AgentEventType =
  | "session.started"
  | "session.completed"
  | "session.failed"
  | "state.changed"
  | "plan.updated"
  | "turn.started"
  | "model.started"
  | "model.thought_delta"
  | "model.text_delta"
  | "tool.proposed"
  | "tool.approval_required"
  | "tool.approved"
  | "tool.started"
  | "tool.output"
  | "file.changed"
  | "verification.started"
  | "verification.finished"
  | "budget.warning"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled";

export interface PublicAgentEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: AgentEventType;
  sessionId: string;
  timestamp: number;
  payload: TPayload;
}

export type EventListener<T = Record<string, unknown>> = (event: PublicAgentEvent<T>) => void | Promise<void>;

/**
 * Event Bus for broadcasting agent runtime events to frontends (CLI, Desktop, Web).
 */
export class AgentEventBus {
  private listeners = new Map<AgentEventType | "*", Set<EventListener>>();

  /**
   * Subscribe to a specific event type or "*" for all events.
   */
  on<T = Record<string, unknown>>(type: AgentEventType | "*", listener: EventListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as EventListener);

    return () => {
      this.listeners.get(type)?.delete(listener as EventListener);
    };
  }

  /**
   * Emit an event to all subscribed listeners.
   */
  emit<T = Record<string, unknown>>(type: AgentEventType, sessionId: string, payload: T): PublicAgentEvent<T> {
    const event: PublicAgentEvent<T> = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      sessionId,
      timestamp: Date.now(),
      payload,
    };

    // Specific listeners
    const specific = this.listeners.get(type);
    if (specific) {
      for (const listener of specific) {
        try { listener(event as any); } catch { /* ignore listener errors */ }
      }
    }

    // Global wildcard listeners
    const wildcard = this.listeners.get("*");
    if (wildcard) {
      for (const listener of wildcard) {
        try { listener(event as any); } catch { /* ignore listener errors */ }
      }
    }

    return event;
  }

  /**
   * Remove all event listeners.
   */
  clear(): void {
    this.listeners.clear();
  }
}

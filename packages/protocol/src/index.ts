/**
 * @inflynx/protocol
 * Public event protocol and JSON-RPC schema definitions.
 */

export type AgentEventType =
  | "session.started"
  | "turn.started"
  | "plan.updated"
  | "model.started"
  | "model.delta"
  | "tool.started"
  | "tool.output"
  | "file.changed"
  | "verification.started"
  | "verification.finished"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled";

export interface PublicAgentEvent {
  id: string;
  type: AgentEventType;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

/**
 * Core type definitions for Inflynx Code VS Code Extension
 */

export type AgentMode = "ask" | "plan" | "agent" | "debug";
export type AgentBudgetLevel = "low" | "medium" | "high" | "max";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  description?: string;
  tier?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  envKey: string;
  defaultModel: string;
}

export interface ModelsResponse {
  catalog: ModelInfo[];
  providers: ProviderInfo[];
  supportedEfforts: ReasoningEffort[];
}

export interface ServerHealthResponse {
  status: "ok" | "degraded";
  server: string;
  version: string;
  postgres: boolean;
  redis: boolean;
  uptimeSeconds: number;
  timestamp: string;
}

export interface SessionRecord {
  sessionId: string;
  providerId: string;
  model: string;
  activeMode: AgentMode;
  budgetLevel: AgentBudgetLevel;
  state?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoredMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  thought?: string;
  tool_call_id?: string;
  timestamp?: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface SessionHydration {
  session: SessionRecord;
  messages: StoredMessage[];
  toolExecutions?: Array<{
    toolCallId: string;
    toolName: string;
    argsJson: string;
    output: string;
    isError: boolean;
    durationMs: number;
  }>;
}

export interface ToolApprovalRequestPayload {
  toolCallId: string;
  toolName: string;
  permissionLevel: "readonly" | "readwrite" | "shell";
  args: Record<string, unknown>;
}

export interface BudgetStatePayload {
  level: AgentBudgetLevel;
  turnsUsed: number;
  maxTurns: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  tokensUsed: number;
  maxTokens: number;
  exhausted: boolean;
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  durationMs: number;
}

export interface TurnCompletedPayload {
  finalText: string;
  toolResults: ToolResultPayload[];
  budgetState?: BudgetStatePayload;
  isCompleted: boolean;
}

// ─── Webview ↔ Extension Host Protocol ──────────────────────────────────────

export type ToWebviewMessage =
  | { type: "session.loaded"; payload: SessionHydration }
  | { type: "session.list"; payload: SessionRecord[] }
  | { type: "server.status"; payload: { connected: boolean; url: string; health?: ServerHealthResponse } }
  | { type: "models.loaded"; payload: ModelsResponse }
  | { type: "turn.started"; payload: { prompt: string } }
  | { type: "model.thought_delta"; payload: { delta: string } }
  | { type: "model.text_delta"; payload: { delta: string } }
  | { type: "tool.proposed"; payload: ToolApprovalRequestPayload }
  | { type: "tool.approval_required"; payload: ToolApprovalRequestPayload }
  | { type: "tool.approved"; payload: { toolCallId: string; toolName: string } }
  | { type: "tool.started"; payload: { toolCallId: string; toolName: string } }
  | { type: "tool.output"; payload: { toolCallId: string; toolName: string; outputSnippet: string; isError?: boolean; durationMs?: number } }
  | { type: "turn.completed"; payload: TurnCompletedPayload }
  | { type: "turn.failed"; payload: { error: string } }
  | { type: "turn.cancelled" }
  | { type: "budget.updated"; payload: BudgetStatePayload }
  | { type: "mode.changed"; payload: { mode: AgentMode } }
  | { type: "model.changed"; payload: { model: string; provider: string } }
  | { type: "config.updated"; payload: { autoApproveReadonly: boolean; autoApproveAll: boolean; showThinking: boolean; theme: string } };

export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "send.prompt"; payload: { prompt: string; attachedFiles?: string[] } }
  | { type: "abort.turn" }
  | { type: "create.session"; payload?: { mode?: AgentMode; model?: string; provider?: string; budget?: AgentBudgetLevel } }
  | { type: "resume.session"; payload: { sessionId: string } }
  | { type: "approve.tool"; payload: { toolCallId: string; approved: boolean } }
  | { type: "set.mode"; payload: { mode: AgentMode } }
  | { type: "set.model"; payload: { model: string; provider?: string } }
  | { type: "set.budget"; payload: { budget: AgentBudgetLevel } }
  | { type: "open.file"; payload: { filePath: string; line?: number } }
  | { type: "copy.clipboard"; payload: { text: string } }
  | { type: "apply.patch"; payload: { filePath: string; patch: string } }
  | { type: "request.models" }
  | { type: "request.sessions" };

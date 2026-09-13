import { EventEmitter } from "node:events";
import type {
  AgentBudgetLevel,
  AgentMode,
  BudgetStatePayload,
  ModelsResponse,
  ReasoningEffort,
  ServerHealthResponse,
  SessionHydration,
  SessionRecord,
  ToolApprovalRequestPayload,
  TurnCompletedPayload,
} from "./types.js";

export interface ServiceEvents {
  "connected": (health: ServerHealthResponse) => void;
  "disconnected": () => void;
  "session.started": (session: SessionRecord) => void;
  "session.hydrated": (hydration: SessionHydration) => void;
  "turn.started": (prompt: string) => void;
  "model.thought_delta": (delta: string) => void;
  "model.text_delta": (delta: string) => void;
  "tool.proposed": (payload: ToolApprovalRequestPayload) => void;
  "tool.approval_required": (payload: ToolApprovalRequestPayload) => void;
  "tool.approved": (payload: { toolCallId: string; toolName: string }) => void;
  "tool.started": (payload: { toolCallId: string; toolName: string }) => void;
  "tool.output": (payload: { toolCallId: string; toolName: string; outputSnippet: string; isError?: boolean; durationMs?: number }) => void;
  "turn.completed": (payload: TurnCompletedPayload) => void;
  "turn.failed": (error: string) => void;
  "budget.warning": (payload: BudgetStatePayload) => void;
  "budget.updated": (payload: BudgetStatePayload) => void;
}

export class InflynxService extends EventEmitter {
  private serverUrl: string;
  private currentSessionId: string | null = null;
  private currentMode: AgentMode = "agent";
  private currentModel: string = "openai/gpt-5.6-luna";
  private currentProvider: string = "openrouter";
  private currentBudget: AgentBudgetLevel = "medium";
  private activeAbortController: AbortController | null = null;
  private isConnected = false;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(serverUrl = "http://127.0.0.1:4000") {
    super();
    this.serverUrl = serverUrl.replace("://localhost:", "://127.0.0.1:").replace(/\/+$/, "");
  }

  setServerUrl(url: string): void {
    this.serverUrl = url.replace("://localhost:", "://127.0.0.1:").replace(/\/+$/, "");
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getCurrentMode(): AgentMode {
    return this.currentMode;
  }

  setCurrentMode(mode: AgentMode): void {
    this.currentMode = mode;
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  setCurrentModel(model: string, provider = "openrouter"): void {
    this.currentModel = model;
    this.currentProvider = provider;
  }

  getCurrentBudget(): AgentBudgetLevel {
    return this.currentBudget;
  }

  setCurrentBudget(budget: AgentBudgetLevel): void {
    this.currentBudget = budget;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  // ─── Health & Connection ──────────────────────────────────────────────────

  async checkHealth(): Promise<ServerHealthResponse | null> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        if (this.isConnected) {
          this.isConnected = false;
          this.emit("disconnected");
        }
        return null;
      }

      const health = (await res.json()) as ServerHealthResponse;
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit("connected", health);
      }
      return health;
    } catch {
      if (this.isConnected) {
        this.isConnected = false;
        this.emit("disconnected");
      }
      return null;
    }
  }

  startHealthPolling(intervalMs = 5000): void {
    this.stopHealthPolling();
    this.checkHealth().catch(() => {});
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, intervalMs);
  }

  stopHealthPolling(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ─── Models & Providers ───────────────────────────────────────────────────

  async getModels(): Promise<ModelsResponse> {
    const res = await fetch(`${this.serverUrl}/api/models`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch models catalog: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ModelsResponse;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    const res = await fetch(`${this.serverUrl}/api/sessions?limit=${limit}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to list sessions: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return (data.sessions || []) as SessionRecord[];
  }

  async getSessionHydration(sessionId: string): Promise<SessionHydration> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to hydrate session "${sessionId}": ${res.status}`);
    }
    const data = await res.json();
    const hydration = data.session as SessionHydration;
    this.currentSessionId = sessionId;
    if (hydration?.session) {
      this.currentMode = hydration.session.activeMode || this.currentMode;
      this.currentBudget = hydration.session.budgetLevel || this.currentBudget;
      this.currentModel = hydration.session.model || this.currentModel;
      this.currentProvider = hydration.session.providerId || this.currentProvider;
    }
    this.emit("session.hydrated", hydration);
    return hydration;
  }

  async createSession(options?: {
    mode?: AgentMode;
    model?: string;
    providerId?: string;
    budgetLevel?: AgentBudgetLevel;
    reasoningEffort?: ReasoningEffort;
    workspaceRoot?: string;
    autoApprove?: boolean;
  }): Promise<SessionRecord> {
    const body = {
      activeMode: options?.mode || this.currentMode,
      model: options?.model || this.currentModel,
      providerId: options?.providerId || this.currentProvider,
      budgetLevel: options?.budgetLevel || this.currentBudget,
      reasoningEffort: options?.reasoningEffort,
      workspaceRoot: options?.workspaceRoot,
      autoApprove: options?.autoApprove,
    };

    const res = await fetch(`${this.serverUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create session: ${res.status} - ${errText}`);
    }

    const session = (await res.json()) as SessionRecord;
    this.currentSessionId = session.sessionId;
    this.currentMode = session.activeMode || this.currentMode;
    this.currentBudget = session.budgetLevel || this.currentBudget;
    this.currentModel = session.model || this.currentModel;
    this.emit("session.started", session);
    return session;
  }

  // ─── Turn Execution & SSE Stream ──────────────────────────────────────────

  async sendPrompt(
    prompt: string,
    options?: {
      sessionId?: string;
      attachedContext?: string;
      autoApprove?: boolean;
    }
  ): Promise<TurnCompletedPayload> {
    let sessionId = options?.sessionId || this.currentSessionId;
    if (!sessionId) {
      try {
        const newSession = await this.createSession();
        sessionId = newSession.sessionId;
      } catch (err: any) {
        const msg = `⚠️ Unable to connect to Inflynx backend server at ${this.serverUrl}.\n\nPlease ensure the server is running. You can start it via:\n- **Command Palette**: \`Cmd+Shift+P\` → \`Inflynx: Start Backend Server\`\n- **Terminal**: \`pnpm --filter inflynx-server run dev\``;
        this.emit("turn.failed", msg);
        throw new Error(msg);
      }
    }

    this.emit("turn.started", prompt);

    this.activeAbortController = new AbortController();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    if (options?.autoApprove) {
      headers["X-Auto-Approve"] = "true";
    }

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt,
          attachedContext: options?.attachedContext,
        }),
        signal: this.activeAbortController.signal,
      });
    } catch (err: any) {
      const msg = `⚠️ Connection to Inflynx server (${this.serverUrl}) failed: ${err?.message || String(err)}.\n\nPlease ensure the server is running.`;
      this.emit("turn.failed", msg);
      throw new Error(msg);
    }

    if (!res.ok) {
      const err = await res.text();
      const msg = `Server error ${res.status}: ${err}`;
      this.emit("turn.failed", msg);
      throw new Error(msg);
    }

    if (!res.body) {
      const msg = "Empty SSE response body from Inflynx server";
      this.emit("turn.failed", msg);
      throw new Error(msg);
    }

    return new Promise<TurnCompletedPayload>((resolve, reject) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedResult: TurnCompletedPayload | null = null;

      const processLine = (line: string) => {
        // SSE parsing
        if (line.startsWith("event: ")) {
          // Event type line - parsed with next data line
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const rawData = line.slice(6).trim();
          if (rawData === "[DONE]") {
            return;
          }
          try {
            const parsedData = JSON.parse(rawData);
            this.handleSSEEvent(currentEventType, parsedData);
            if (currentEventType === "turn.completed") {
              completedResult = parsedData as TurnCompletedPayload;
            }
          } catch {
            // raw string delta fallback
            if (currentEventType === "model.text_delta") {
              this.emit("model.text_delta", rawData);
            }
          }
        }
      };

      let currentEventType = "message";

      const read = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                processLine(trimmed);
              }
            }
          }

          if (completedResult) {
            resolve(completedResult);
          } else {
            resolve({
              finalText: "",
              toolResults: [],
              isCompleted: true,
            });
          }
        } catch (err: any) {
          if (err.name === "AbortError") {
            this.emit("turn.failed", "Turn cancelled by user.");
            reject(new Error("Turn aborted"));
          } else {
            this.emit("turn.failed", err.message || String(err));
            reject(err);
          }
        } finally {
          this.activeAbortController = null;
        }
      };

      read();
    });
  }

  private handleSSEEvent(eventType: string, data: any): void {
    switch (eventType) {
      case "model.thought_delta":
        this.emit("model.thought_delta", data.thought || data.delta || data.text || "");
        break;
      case "model.text_delta":
        this.emit("model.text_delta", data.delta || data.text || "");
        break;
      case "tool.proposed":
        this.emit("tool.proposed", data);
        break;
      case "tool.approval_required":
        this.emit("tool.approval_required", data);
        break;
      case "tool.approved":
        this.emit("tool.approved", data);
        break;
      case "tool.started":
        this.emit("tool.started", data);
        break;
      case "tool.output":
        this.emit("tool.output", data);
        break;
      case "turn.completed":
        this.emit("turn.completed", data);
        if (data.budgetState) {
          this.emit("budget.updated", data.budgetState);
        }
        break;
      case "turn.failed":
        this.emit("turn.failed", data.error || "Turn failed");
        break;
      case "budget.warning":
        this.emit("budget.warning", data);
        this.emit("budget.updated", data);
        break;
      default:
        // Other custom events
        break;
    }
  }

  // ─── Tool Approvals ───────────────────────────────────────────────────────

  async approveToolCall(sessionId: string, toolCallId: string, approved: boolean): Promise<boolean> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ toolCallId, approved }),
    });

    return res.ok;
  }

  // ─── Turn Abort ───────────────────────────────────────────────────────────

  async abortTurn(sessionId?: string): Promise<boolean> {
    const targetSessionId = sessionId || this.currentSessionId;
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    if (!targetSessionId) return true;

    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(targetSessionId)}/abort`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.stopHealthPolling();
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this.removeAllListeners();
  }
}

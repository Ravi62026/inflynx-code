import type { CustomModelCapabilities, Message, ModelAdapter, ReasoningEffort } from "@inflynx/model-gateway";
import { generateSessionId } from "@inflynx/session-store";
import type { AgentMode } from "../index.js";

export interface ExecutionOptions {
  sessionId?: string;
  workspaceRoot: string;
  activeMode?: AgentMode;
  providerId: string;
  model: string;
  apiKey: string;
  credentialProfileId?: string;
  baseURL?: string;
  modelAdapter?: ModelAdapter | "openai-chat";
  reasoningEffort?: ReasoningEffort;
  actualModel?: string;
  allowUnauthenticated?: boolean;
  allowLocalEndpoint?: boolean;
  customCapabilities?: CustomModelCapabilities;
  systemPrompt?: string;
  maxTokens?: number;
}

export class ExecutionContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  activeMode: AgentMode;
  providerId: string;
  model: string;
  apiKey: string;
  credentialProfileId?: string;
  baseURL?: string;
  modelAdapter?: ModelAdapter | "openai-chat";
  reasoningEffort?: ReasoningEffort;
  actualModel?: string;
  allowUnauthenticated?: boolean;
  allowLocalEndpoint?: boolean;
  customCapabilities?: CustomModelCapabilities;
  maxTokens?: number;
  private conversationHistory: Message[] = [];
  private abortController: AbortController;

  constructor(options: ExecutionOptions) {
    this.sessionId = options.sessionId || generateSessionId();
    this.workspaceRoot = options.workspaceRoot;
    this.activeMode = options.activeMode || "agent";
    this.providerId = options.providerId;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.credentialProfileId = options.credentialProfileId;
    this.baseURL = options.baseURL;
    this.modelAdapter = options.modelAdapter;
    this.reasoningEffort = options.reasoningEffort;
    this.actualModel = options.actualModel;
    this.allowUnauthenticated = options.allowUnauthenticated;
    this.allowLocalEndpoint = options.allowLocalEndpoint;
    this.customCapabilities = options.customCapabilities;
    this.maxTokens = options.maxTokens;
    this.abortController = new AbortController();

    if (options.systemPrompt) {
      this.conversationHistory.push({ role: "system", content: options.systemPrompt });
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get history(): Message[] {
    return this.conversationHistory;
  }

  setSystemPrompt(prompt: string): void {
    if (this.conversationHistory.length > 0 && this.conversationHistory[0].role === "system") {
      this.conversationHistory[0] = { role: "system", content: prompt };
    } else {
      this.conversationHistory.unshift({ role: "system", content: prompt });
    }
  }

  addMessage(message: Message): void {
    this.conversationHistory.push(message);
  }

  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Sanitizes history to ensure every tool call has a corresponding tool response,
   * preventing DeepSeek/OpenAI API 400 crashes on interrupted loops.
   */
  ensureHistoryIntegrity(): void {
    const respondedIds = new Set(
      this.conversationHistory.filter((m) => m.role === "tool").map((m) => m.tool_call_id)
    );

    const lastAssistantMsg = [...this.conversationHistory].reverse().find((m) => m.role === "assistant");
    if (lastAssistantMsg?.tool_calls) {
      for (const tc of lastAssistantMsg.tool_calls) {
        if (!respondedIds.has(tc.id)) {
          this.conversationHistory.push({
            role: "tool",
            content: `Error: Tool execution was interrupted or failed.`,
            tool_call_id: tc.id,
          });
        }
      }
    }
  }
}

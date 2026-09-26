import type { CustomModelCapabilities, Message, ModelAdapter, ReasoningEffort } from "@inflynx/model-gateway";
import { resolveContextStrategy, type ContextStrategy } from "@inflynx/config";
import { generateSessionId } from "@inflynx/session-store";
import type { AgentMode } from "../index.js";

// One definition, in `@inflynx/config` — the same rule `ReasoningEffort` follows, and
// the reason this project had two incompatible `AgentState` unions before (backlog C8).
export type { ContextStrategy } from "@inflynx/config";

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
  /**
   * How far the orchestrator may go to stay inside the model's window: `off` does
   * nothing, `evict` drops stale tool output (free), `compact` also summarizes old
   * turns with one extra model call. Defaults to `INFLYNX_CONTEXT_STRATEGY`, then to
   * `evict` — summarization is opt-in because it changes what the model can see, so
   * it needs measuring before it can be the default (backlog risk register).
   */
  contextStrategy?: ContextStrategy;
}

/**
 * A contiguous slice of history that is safe to replace with one summary.
 * Produced by {@link ExecutionContext.compactionPlan} and consumed by
 * {@link ExecutionContext.applyCompaction} — the boundary rules live in exactly
 * one place so the caller cannot summarize a half-finished tool round.
 */
export interface CompactionPlan {
  /** First message to be folded into the summary (never the system prompt). */
  start: number;
  /** One past the last message to be folded. `messages` is `history[start,end]`. */
  end: number;
  messages: Message[];
  chars: number;
  /** True when the task statement at the head of history was kept out of the fold. */
  keptFirstRequest: boolean;
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
  readonly contextStrategy: ContextStrategy;
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
    this.contextStrategy = options.contextStrategy ?? resolveContextStrategy();
    this.abortController = new AbortController();

    if (options.systemPrompt) {
      this.conversationHistory.push({ role: "system", content: options.systemPrompt });
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Output ceiling in force for this session. `maxTokens` is optional, and each
   * adapter substitutes its own default when it is absent — 4096 for the
   * OpenAI-compatible adapter, 8192 for Anthropic/Responses/Gemini — so this
   * mirrors the *effective* value. Phase 12 replaces the guess with the model's
   * published `maxOutputTokens`.
   */
  get maxOutputTokens(): number {
    return this.maxTokens ?? 4096;
  }

  /**
   * Doubles the output ceiling, capped, so a truncated response can be retried
   * with room to finish. Returns false when it can no longer grow.
   */
  raiseOutputTokenBudget(cap = 32_768): boolean {
    const current = this.maxOutputTokens;
    const next = Math.min(cap, Math.max(current * 2, 8_192));
    if (next <= current) return false;
    this.maxTokens = next;
    return true;
  }

  /**
   * Starts a new cancellation generation and returns its signal. Every agentic
   * turn must call this once and hold the returned signal for its whole lifetime.
   *
   * Previously `abort()` replaced the controller immediately, so a turn that kept
   * reading `context.signal` after an abort saw a fresh, *un-aborted* signal and
   * went on executing the remaining tool calls (backlog C12).
   */
  beginGeneration(): AbortSignal {
    this.abortController = new AbortController();
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

  /**
   * Tiered context relief: drop the *content* of the oldest tool results, newest
   * last, keeping a protected window of recent messages untouched.
   *
   * Tool output is chosen first because the model has already read it and acted on
   * it; user text, assistant conclusions and the pinned system prompt are never
   * touched. The message itself stays in place (so every `tool_call_id` still has a
   * matching response and providers stay happy) and is replaced by a tombstone that
   * tells the model what was lost and how to get it back.
   */
  evictStaleToolResults(options: { protectRecentMessages?: number } = {}): { dropped: number; charsFreed: number } {
    const protect = Math.max(2, options.protectRecentMessages ?? 12);
    const cutoff = Math.max(0, this.conversationHistory.length - protect);
    let dropped = 0;
    let charsFreed = 0;

    for (let index = 0; index < cutoff; index++) {
      const message = this.conversationHistory[index];
      if (message.role !== "tool") continue;
      const content = message.content || "";
      if (content.length < 400 || content.startsWith("[context evicted")) continue;

      const note =
        `[context evicted: ${content.length.toLocaleString()} characters of output for ` +
        `${message.tool_call_id || "a tool call"} were dropped to stay inside the model's window. ` +
        `Re-run the tool call if you still need this.]`;
      charsFreed += content.length - note.length;
      message.content = note;
      dropped++;
    }

    return { dropped, charsFreed };
  }

  /**
   * Decides which slice of history can be folded into a summary, or `null` when
   * there is nothing worth folding.
   *
   * Three rules, all of them about not breaking what providers accept:
   *   - the system prompt and the **original task statement** stay verbatim. Losing
   *     "what was I asked to do" is worse than losing any amount of tool output.
   *   - the most recent `keepRecentMessages` stay verbatim — that is the working set.
   *   - a fold boundary never splits a tool round. An assistant `tool_calls` message
   *     and its `tool` results move together, or the provider rejects the request
   *     (a `tool` message whose `tool_call_id` has no surviving call is invalid, and
   *     so is a call with no answer).
   */
  compactionPlan(options: { keepRecentMessages?: number } = {}): CompactionPlan | null {
    const history = this.conversationHistory;
    const keep = Math.max(4, options.keepRecentMessages ?? 8);
    if (history.length <= keep + 2) return null;

    let start = history[0]?.role === "system" ? 1 : 0;
    // Keep the first user message: it is the task, not conversation debris. It also
    // sits at `start` in the overwhelmingly common case, so this is `>=` — using `>`
    // there folded the user's original request into its own summary.
    const firstUser = history.findIndex((m, index) => index >= start && m.role === "user");
    let keptFirstRequest = false;
    if (firstUser >= start) {
      start = firstUser + 1;
      keptFirstRequest = true;
    }

    let end = history.length - keep;
    // Push the boundary past any tool result whose call is inside the fold.
    while (end > start && history[end]?.role === "tool") end++;
    // Pull it back if it would cut an assistant call away from the recent side.
    while (end > start + 1 && history[end - 1]?.role === "assistant" && history[end - 1].tool_calls?.length) {
      end--;
    }

    const messages = history.slice(start, end);
    if (messages.length < 3) return null;
    const chars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    // Summarizing three short exchanges costs a model call and saves nothing; the
    // eviction pass is the right tool for that. Only fold when content is heavy.
    if (chars < 2_000) return null;

    return { start, end, messages, chars, keptFirstRequest };
  }

  /**
   * Replaces a planned slice with one summary message and returns what it saved.
   * The originals are removed from **context only** — `SessionStore` still holds the
   * full transcript, which is the whole point of keeping context and transcript as
   * two different things (backlog D6's resume path reads the transcript, not this).
   */
  applyCompaction(plan: CompactionPlan, summaryText: string): { dropped: number; charsFreed: number } {
    const summary: Message = {
      role: "user",
      content:
        `[Earlier conversation summarized to stay inside the model's window. The full ` +
        `transcript is unchanged in the session store.]\n\n` +
        summaryText.trim(),
    };
    const droppedChars = plan.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    this.conversationHistory.splice(plan.start, plan.end - plan.start, summary);
    return { dropped: plan.messages.length, charsFreed: Math.max(0, droppedChars - summary.content.length) };
  }

  /** Cancels the generation in flight. Deliberately does NOT replace the controller. */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Sanitizes history so every assistant `tool_call` has a corresponding tool
   * response, preventing DeepSeek/OpenAI/Anthropic 400s after an interrupted or
   * failed loop.
   *
   * Each stub is inserted at the end of the contiguous run of tool results that
   * follows its own assistant message — never before a result that already exists,
   * and never at the very end of history where it would be grouped with a later
   * round. The previous version appended globally and only inspected the last
   * assistant message, which (a) missed earlier rounds and (b) could strand a
   * `tool_result` away from the `tool_use` turn Anthropic wants them adjacent to.
   * Idempotent — safe to call at both the start and end of a turn.
   *
   * @returns the synthesized messages (empty when history was already consistent),
   *   so callers can persist them and keep the stored transcript replayable.
   */
  ensureHistoryIntegrity(): Message[] {
    const responded = new Set(
      this.conversationHistory.filter((m) => m.role === "tool").map((m) => m.tool_call_id)
    );

    const synthesized: Message[] = [];
    const rebuilt: Message[] = [];
    let cursor = 0;

    while (cursor < this.conversationHistory.length) {
      const message = this.conversationHistory[cursor++];
      rebuilt.push(message);
      if (message.role !== "assistant" || !message.tool_calls?.length) continue;

      // Consume this round's existing tool results first, so synthesized stubs
      // land after them rather than displacing real output.
      while (cursor < this.conversationHistory.length && this.conversationHistory[cursor].role === "tool") {
        rebuilt.push(this.conversationHistory[cursor++]);
      }

      for (const toolCall of message.tool_calls) {
        if (responded.has(toolCall.id)) continue;
        responded.add(toolCall.id);
        const stub: Message = {
          role: "tool",
          content: "Error: Tool execution was interrupted or failed before a result was produced.",
          tool_call_id: toolCall.id,
          is_error: true,
        };
        rebuilt.push(stub);
        synthesized.push(stub);
      }
    }

    if (synthesized.length > 0) {
      this.conversationHistory = rebuilt;
    }
    return synthesized;
  }
}

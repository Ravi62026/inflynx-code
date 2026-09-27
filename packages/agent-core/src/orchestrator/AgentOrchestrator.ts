import path from "node:path";
import { AgentEventBus, type PublicAgentEvent } from "@inflynx/protocol";
import { streamModel, toProviderError, type FinishReason, type Message, type ModelEvent, type ReasoningEffort, type TokenUsage } from "@inflynx/model-gateway";
import {
  assertSupportedReasoningEffort,
  getCredentialProfile,
  getProvider,
  redactSecrets,
  resolveContextLimits,
  resolveCredentialSecret,
} from "@inflynx/config";
import { ToolRegistry, safeParseJsonArgs, reviewMutatingPatchForSafety, classifyGitInvocation, type ToolCall, type ToolResult } from "@inflynx/tool-runtime";
import { ToolExecutionGateway } from "@inflynx/tool-runtime";
import type { PatchSafetyReview, PatchSafetyViolation } from "@inflynx/patch-engine";
import { reviewShellCommand, type CanonicalPathGuard } from "@inflynx/policy-engine";
import { createSessionStore, generateSessionId, type SessionStore } from "@inflynx/session-store";
import { StateMachine, LEGAL_STATE_TRANSITIONS, type AgentState } from "./StateMachine.js";
import { BudgetManager, type AgentBudgetLevel, type BudgetState } from "./BudgetManager.js";
import { ExecutionContext, type ContextStrategy, type ExecutionOptions } from "./ExecutionContext.js";
import { ApprovalProvider, type ApprovalHandler } from "./ApprovalProvider.js";
import {
  VerificationEngine,
  type SuiteSummary,
  type VerificationCheck,
} from "../verification/VerificationEngine.js";
import { RepairLoop } from "../verification/RepairLoop.js";
import type { DiagnosticError } from "../verification/FailureParser.js";
import { filterToolsForMode, type AgentMode } from "../index.js";

/** How many times one turn may double its output ceiling after a truncation. */
const MAX_TRUNCATION_RETRIES = 2;

/** Utilization above which stale tool results start getting dropped. */
const CONTEXT_SOFT_LIMIT = 0.85;

/**
 * Utilization above which eviction alone is not enough and a summarization pass is
 * worth its own model call. Deliberately above `CONTEXT_SOFT_LIMIT` so the free
 * tier always gets first refusal.
 */
const CONTEXT_COMPACT_LIMIT = 0.92;

/**
 * Protected-window ladder for eviction. A single fixed floor made eviction
 * unreachable in short sessions that carry very large tool output — exactly when it
 * was needed — so the protected tail shrinks until something can be dropped.
 */
const CONTEXT_PROTECTION_LADDER = [12, 6, 2];

/**
 * Instructions for the compaction pass. It is a *memory* request, not a chat: the
 * things listed here are the ones a model cannot reconstruct and will otherwise
 * repeat or contradict after its earlier turns are gone.
 */
const SUMMARIZER_SYSTEM_PROMPT =
  "You are compacting an AI coding agent's conversation history so it fits a smaller " +
  "context window. Write dense notes, not a narrative. Another model will act on these " +
  "notes believing they are its own earlier work, so preserve verbatim: " +
  "1) the user's original request, 2) every file path read or edited and what was learned " +
  "about it, 3) decisions taken and rejected, 4) commands run and their results, " +
  "5) unresolved errors, failing tests and open questions, 6) the current task state. " +
  "Drop pleasantries, restated explanations and tool output that was already acted upon. " +
  "Answer with the notes only.";

/**
 * Renders a history slice for the summarizer. Bounded on purpose: feeding a 300k
 * character prefix to a model with a 32k window in order to *fit* a 32k window is
 * how compaction gets itself rejected, so the excerpt is capped and the excess is
 * represented by a marker rather than silently dropped.
 */
function serializeForSummary(messages: Message[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const message of messages) {
    const body = message.content || "";
    const calls = (message.tool_calls || [])
      .map((call) => `${call.function?.name}(${(call.function?.arguments || "").slice(0, 160)})`)
      .join(", ");
    const line = `[${message.role}]${calls ? ` calls: ${calls}` : ""} ${body}`;
    if (used + line.length > maxChars) {
      parts.push(`[... ${messages.length - parts.length} older message(s) omitted from this excerpt ...]`);
      break;
    }
    used += line.length;
    parts.push(line.length > 2_400 ? line.slice(0, 2_400) + " […truncated]" : line);
  }
  return parts.join("\n");
}

// Overflow detection used to live here as a message regex shared by the retry path.
// It is now `classifyProviderError`/`toProviderError` in @inflynx/model-gateway, so
// the wording is matched once, in the layer that knows which provider said it.

export interface TurnResult {
  sessionId: string;
  finalText: string;
  finalReasoning?: string;
  state: AgentState;
  toolResults: ToolResult[];
  budgetState: BudgetState;
  isCompleted: boolean;
  /**
   * The verification gate's verdict, when one applied. Absent means "this turn
   * changed no source files"; present-but-failed means the turn is *not* done in
   * the sense the user cares about, and `finalText` alone would hide that.
   */
  verification?: VerificationReport;
  /** Identifies this turn in the undo journal; `/undo` lists it before reverting. */
  turnId: string;
  /** Files this turn's checkpoint can put back, or `[]` when nothing was written. */
  checkpointFiles?: string[];
}

export type VerificationOutcome =
  /** Every discovered gate passed. */
  | "passed"
  /** A gate failed and the repair budget is gone. */
  | "failed"
  /** Source files changed but the workspace declares no checks — honestly "unverified", not a pass. */
  | "no-gates-configured"
  /** The turn ended early (abort, budget, provider error) before the gate could run. */
  | "not-run"
  /** The gate ran while the user was interrupting, so its result is meaningless. */
  | "cancelled";

export interface VerificationReport {
  outcome: VerificationOutcome;
  /** Files that triggered the gate. Empty when `outcome` is `not-run`. */
  sourceFilesChanged: string[];
  checksRun: number;
  failedChecks: string[];
  /** Which runner and depth were used, so a failure can be read in context. */
  packageManager?: string;
  depth?: string;
  repairAttempts: number;
  /** The line to show the user — never an empty "✓ done" when nothing ran. */
  summaryMessage: string;
}

export class AgentOrchestrator {
  private context: ExecutionContext;
  private stateMachine: StateMachine;
  private budgetManager: BudgetManager;
  private registry: ToolRegistry;
  private gateway: ToolExecutionGateway;
  private eventBus: AgentEventBus;
  private approvalProvider: ApprovalProvider;
  private sessionStore: SessionStore;
  private readonly approvalHandler?: ApprovalHandler;

  /**
   * Direct constructor — does NOT create a row in the session store.
   *
   * This is intentional: session-row creation is inherently async (a DB
   * round-trip), while a constructor cannot be. Previously this constructor
   * fired an un-awaited `sessionStore.createSession(...)` call that generated
   * its OWN random session ID — completely disconnected from
   * `ExecutionContext.sessionId` (the ID every `saveMessage`/
   * `saveToolExecution`/`updateTokenTelemetry` call actually uses). On
   * Postgres that produced a guaranteed foreign-key-violation crash on the
   * first save; on the local JSON store it silently orphaned all persisted
   * data under an ID with no matching session record, making it permanently
   * unhydratable via `getSessionHydration()`.
   *
   * Use `AgentOrchestrator.start(...)` to create a brand-new, fully-persisted
   * session (it awaits row creation before any turn can run), or
   * `AgentOrchestrator.resumeSession(...)` to resume an existing one. Call
   * this constructor directly only for ephemeral/test orchestrators that
   * don't need `runTurn()`'s persistence calls to succeed against a real store.
   */
  constructor(
    options: ExecutionOptions,
    registry: ToolRegistry,
    eventBus?: AgentEventBus,
    approvalHandler?: ApprovalHandler,
    budgetLevel: AgentBudgetLevel = "medium",
    sessionStore?: SessionStore
  ) {
    this.context = new ExecutionContext(options);
    this.eventBus = eventBus || new AgentEventBus();
    this.stateMachine = new StateMachine(this.context.sessionId, this.eventBus);
    this.budgetManager = new BudgetManager(budgetLevel, this.context.sessionId, this.eventBus);
    this.registry = registry;
    this.gateway = new ToolExecutionGateway(this.context.workspaceRoot);
    this.approvalProvider = new ApprovalProvider(approvalHandler);
    this.approvalHandler = approvalHandler;
    this.sessionStore = sessionStore || createSessionStore(this.context.workspaceRoot);
    this.applyModelWindow();

    this.eventBus.emit("session.started", this.context.sessionId, {
      workspaceRoot: this.context.workspaceRoot,
      providerId: this.context.providerId,
      model: this.context.model,
      mode: this.context.activeMode,
      budgetLevel,
      reasoningEffort: this.context.reasoningEffort || "none",
    });
  }

  /**
   * Creates a brand-new, fully-persisted agent session: the session row is
   * created in the store FIRST (awaited), and the returned `sessionId` is
   * what `ExecutionContext` uses for the rest of the orchestrator's life —
   * guaranteeing every subsequent persistence call references a real row.
   *
   * This is the correct entry point for new sessions in CLI; use
   * `resumeSession()` to reattach to an existing one instead.
   */
  static async start(
    options: ExecutionOptions,
    registry: ToolRegistry,
    eventBus?: AgentEventBus,
    approvalHandler?: ApprovalHandler,
    budgetLevel: AgentBudgetLevel = "medium",
    sessionStore?: SessionStore
  ): Promise<AgentOrchestrator> {
    AgentOrchestrator.assertModelSelection(options);
    const store = sessionStore || createSessionStore(options.workspaceRoot);
    const sessionId = options.sessionId || generateSessionId();

    // Create the row FIRST, explicitly with this ID, and await it — this is
    // the fix: no orchestrator instance exists yet, so nothing can call
    // saveMessage()/saveToolExecution() before the row exists.
    const record = await store.createSession(
      options.workspaceRoot,
      options.providerId,
      options.model,
      options.activeMode || "agent",
      budgetLevel,
      undefined,
      sessionId,
      {
        credentialProfileId: options.credentialProfileId,
        baseUrl: options.baseURL,
        reasoningEffort: options.reasoningEffort,
      }
    );

    return new AgentOrchestrator(
      { ...options, sessionId: record.sessionId },
      registry,
      eventBus,
      approvalHandler,
      budgetLevel,
      store
    );
  }

  get state(): AgentState {
    return this.stateMachine.state;
  }

  get sessionId(): string {
    return this.context.sessionId;
  }

  get bus(): AgentEventBus {
    return this.eventBus;
  }

  get budget(): BudgetState {
    // History is passed in so the context numbers describe the *current* window.
    return this.budgetManager.getBudgetState(this.context.history);
  }

  /** The execution mode currently in force. Needed to compare before changing it. */
  get activeMode(): AgentMode {
    return this.context.activeMode;
  }

  /** How hard this session will work to stay inside its window. Read-only policy. */
  get contextStrategy(): ContextStrategy {
    return this.context.contextStrategy;
  }

  get store(): SessionStore {
    return this.sessionStore;
  }

  get modelConfiguration(): Readonly<{
    providerId: string;
    model: string;
    actualModel?: string;
    credentialProfileId?: string;
    reasoningEffort: ReasoningEffort;
    budgetLevel: AgentBudgetLevel;
  }> {
    return {
      providerId: this.context.providerId,
      model: this.context.model,
      actualModel: this.context.actualModel,
      credentialProfileId: this.context.credentialProfileId,
      reasoningEffort: this.context.reasoningEffort || "none",
      budgetLevel: this.budgetManager.getBudgetState().level,
    };
  }

  setMode(mode: ExecutionOptions["activeMode"]): void {
    if (mode) {
      this.context.activeMode = mode;
    }
  }

  setBudgetLevel(level: AgentBudgetLevel): void {
    this.budgetManager.setBudgetLevel(level);
  }

  /**
   * Changes provider thinking/reasoning effort without changing the local
   * safety budget. Unsupported effort is rejected before a request is sent.
   */
  async setReasoningEffort(level: ReasoningEffort): Promise<void> {
    if (this.context.providerId !== "custom-openai-compatible") {
      assertSupportedReasoningEffort(this.context.providerId, this.context.model, level);
    } else if (!this.context.customCapabilities?.supportedEfforts.includes(level)) {
      throw new Error(`Custom model "${this.context.model}" does not support effort "${level}".`);
    }
    this.context.reasoningEffort = level;
    await this.sessionStore.updateSessionModelConfig(this.context.sessionId, this.currentSessionModelConfig());
  }

  /** Replaces (or inserts) the system prompt message at the head of conversation history. */
  setSystemPrompt(prompt: string): void {
    this.context.setSystemPrompt(prompt);
  }

  /**
   * Creates a new persisted session for a provider/model switch. Provider
   * continuation state is vendor-specific (reasoning items/signatures/tool
   * structures), so carrying old history into a new vendor/model is unsafe.
   */
  async switchModel(config: Partial<ExecutionOptions>): Promise<AgentOrchestrator> {
    const nextProvider = config.providerId || this.context.providerId;
    const nextModel = config.model || this.context.model;
    const providerChanged = nextProvider !== this.context.providerId;
    const modelChanged = nextModel !== this.context.model;
    if (!providerChanged && !modelChanged) {
      if (config.apiKey !== undefined) this.context.apiKey = config.apiKey;
      if (config.credentialProfileId !== undefined) this.context.credentialProfileId = config.credentialProfileId;
      if (config.baseURL !== undefined) this.context.baseURL = config.baseURL;
      if (config.modelAdapter !== undefined) this.context.modelAdapter = config.modelAdapter;
      if (config.reasoningEffort !== undefined) await this.setReasoningEffort(config.reasoningEffort);
      return this;
    }

    const nextOptions: ExecutionOptions = {
      workspaceRoot: this.context.workspaceRoot,
      activeMode: this.context.activeMode,
      systemPrompt: this.context.history.find((message) => message.role === "system")?.content,
      providerId: nextProvider,
      model: nextModel,
      apiKey: config.apiKey ?? this.context.apiKey,
      credentialProfileId: config.credentialProfileId,
      baseURL: config.baseURL,
      modelAdapter: config.modelAdapter,
      reasoningEffort: config.reasoningEffort ?? this.context.reasoningEffort,
      allowUnauthenticated: config.allowUnauthenticated,
      allowLocalEndpoint: config.allowLocalEndpoint,
      customCapabilities: config.customCapabilities,
    };
    AgentOrchestrator.assertModelSelection(nextOptions);

    return AgentOrchestrator.start(
      nextOptions,
      this.registry,
      this.eventBus,
      this.approvalHandler,
      this.budgetManager.getBudgetState().level,
      this.sessionStore
    );
  }

  /** @deprecated Use `switchModel()` so provider continuation state remains safe. */
  async updateModelConfig(config: Partial<ExecutionOptions>): Promise<AgentOrchestrator> {
    return this.switchModel(config);
  }

  abort(): void {
    this.context.abort();
    if (this.stateMachine.canTransitionTo("cancelled")) {
      this.stateMachine.transitionTo("cancelled", "User signal abort");
    }
  }

  /**
   * Ends this session's turn and terminates everything it left running.
   *
   * Background shells are spawned in their own process group so they can be killed
   * cleanly — which also means they happily outlive a parent that exits without
   * asking. Every shutdown path (CLI `/exit`, Ctrl+C, server session delete,
   * extension deactivate) must call this, or the leftover `pnpm dev` holds the port
   * the next session needs. Reports what it actually stopped rather than claiming a
   * clean exit it did not perform.
   */
  shutdown(options: { abortTurn?: boolean } = {}): { shellsStopped: number } {
    if (options.abortTurn !== false) this.abort();
    return { shellsStopped: this.gateway.shutdownShells() };
  }

  /** Background shells this session started, for a status line or a confirmation prompt. */
  runningShellCount(): number {
    return this.runningShells().length;
  }

  /** The still-running shells themselves, so a shutdown prompt can name them. */
  runningShells(): Array<{ id: string; command: string; cwd: string }> {
    return this.gateway.shells
      .list()
      .filter((shell) => shell.endedAt === undefined)
      .map((shell) => ({ id: shell.id, command: shell.command, cwd: shell.cwd }));
  }

  /**
   * Resumes a previously saved session from SessionStore.
   */
  static async resumeSession(
    workspaceRoot: string,
    targetSessionId: string,
    registry: ToolRegistry,
    eventBus?: AgentEventBus,
    approvalHandler?: ApprovalHandler,
    sessionStore?: SessionStore
  ): Promise<AgentOrchestrator | null> {
    const store = sessionStore || createSessionStore(workspaceRoot);
    const hydration = await store.getSessionHydration(targetSessionId);
    if (!hydration) return null;

    const provider = getProvider(hydration.session.provider);
    const profile = hydration.session.credentialProfileId
      ? getCredentialProfile(hydration.session.credentialProfileId)
      : undefined;
    if (hydration.session.credentialProfileId && !profile) {
      throw new Error(
        `Cannot resume session "${targetSessionId}": credential profile ` +
          `"${hydration.session.credentialProfileId}" is unavailable. Re-add it with /credentials add.`
      );
    }
    if (profile && profile.providerId !== hydration.session.provider) {
      throw new Error(
        `Cannot resume session "${targetSessionId}": credential profile "${profile.label}" does not match ` +
          `saved provider "${hydration.session.provider}".`
      );
    }
    const resolvedApiKey = profile
      ? resolveCredentialSecret(profile)
      : process.env[provider?.envKey || ""];
    if (!resolvedApiKey) {
      throw new Error(
        `Cannot resume session "${targetSessionId}": no keychain profile or environment key found for provider ` +
          `"${hydration.session.provider}"${provider ? ` (expected ${provider.envKey})` : ""}.`
      );
    }

    const orchestrator = new AgentOrchestrator(
      {
        sessionId: hydration.session.sessionId,
        workspaceRoot: hydration.session.cwd,
        providerId: hydration.session.provider,
        model: hydration.session.model,
        activeMode: hydration.session.activeMode as any,
        apiKey: resolvedApiKey,
        credentialProfileId: hydration.session.credentialProfileId,
        baseURL: hydration.session.baseUrl,
        modelAdapter: profile?.providerId === "custom-openai-compatible"
          ? "openai-chat"
          : provider?.adapter,
        reasoningEffort: hydration.session.reasoningEffort as ReasoningEffort | undefined,
        actualModel: hydration.session.actualModel,
        allowUnauthenticated: profile?.providerId === "custom-openai-compatible" && profile.credentialSource !== "keychain",
        allowLocalEndpoint: profile?.allowLocalEndpoint,
        customCapabilities: profile?.customCapabilities,
      },
      registry,
      eventBus,
      approvalHandler,
      (hydration.session.effortLevel as AgentBudgetLevel) || "medium",
      store
    );

    // Hydrate messages into context
    for (const msg of hydration.messages) {
      const msgObj: Message = {
        role: msg.role,
        content: msg.content || "",
      };
      if (msg.reasoningContent) msgObj.reasoning_content = msg.reasoningContent;
      if (msg.toolCallId) msgObj.tool_call_id = msg.toolCallId;
      if (msg.toolCallsJson) {
        try { msgObj.tool_calls = JSON.parse(msg.toolCallsJson); } catch { /* ignore */ }
        try {
          const raw = JSON.parse(msg.toolCallsJson);
          if (Array.isArray(raw)) {
            msgObj.tool_calls = raw.map((tc: any) => ({
              id: tc.id || "",
              type: "function" as const,
              function: tc.function || {
                name: tc.name || "",
                arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
              },
            }));
          }
        } catch { /* ignore */ }
      }
      if (msg.providerMetadataJson) {
        try {
          const meta = JSON.parse(msg.providerMetadataJson);
          // Strip `reasoning.encrypted` entries — these are OpenRouter session-bound
          // encrypted tokens that cannot be replayed across sessions or API key rotations.
          // Only `reasoning.summary` entries are safe to keep as context.
          if (meta?.openrouterReasoningDetails && Array.isArray(meta.openrouterReasoningDetails)) {
            const safe = meta.openrouterReasoningDetails.filter(
              (d: any) => d?.type !== "reasoning.encrypted"
            );
            if (safe.length > 0) {
              msgObj.provider_metadata = { ...meta, openrouterReasoningDetails: safe };
            }
            // If only encrypted entries existed, drop providerMetadata entirely
          } else {
            msgObj.provider_metadata = meta;
          }
        } catch { /* ignore */ }
      }
      orchestrator.context.addMessage(msgObj);
    }

    // Guard against legacy/partial history (e.g. a saved assistant tool_calls
    // message with no matching persisted tool-response message) so resumed
    // sessions never produce a malformed request that 400s against the model API.
    orchestrator.context.ensureHistoryIntegrity();

    return orchestrator;
  }

  /**
   * Executes a complete agentic turn with model streaming and tool invocation.
   */
  async runTurn(
    userPrompt: string,
    attachedContext?: string,
    /** Multimodal images for this turn's user message (Phase 27). Carried structurally so
     *  every adapter can render a native image block instead of a data-URL in the text. */
    images?: Array<{ mediaType: string; dataBase64: string; name?: string }>,
  ): Promise<TurnResult> {
    // One cancellation generation per turn. Hold this exact signal for the whole
    // turn — `context.signal` can belong to a later generation after an abort.
    const signal = this.context.beginGeneration();
    // Repeat-read dedupe is scoped to this turn: last turn's results may since have
    // been evicted, and a pointer to something the model can no longer see is worse
    // than the duplicate it would have saved.
    this.gateway.beginToolTurn();

    // Undo journal (backlog Phase 30). The label is redacted because it is written to
    // `.inflynx/checkpoints/` and a prompt may quote a token from a config file.
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.gateway.checkpoints.beginTurn(this.context.sessionId, turnId, redactSecrets(userPrompt).slice(0, 120));

    this.transitionTo("classifying", "Starting new task turn");

    // Repair before sending: a previous turn can have thrown (e.g. a persistence
    // failure) before its post-loop repair ran.
    await this.repairHistoryIntegrity();

    const fullPrompt = attachedContext ? `${userPrompt}\n\n=== Attached Context ===\n${attachedContext}` : userPrompt;
    this.context.addMessage({ role: "user", content: fullPrompt, ...(images && images.length ? { images } : {}) });

    // Persist user prompt to SessionStore
    await this.sessionStore.saveMessage(this.context.sessionId, {
      role: "user",
      content: redactSecrets(fullPrompt),
    });

    this.transitionTo("exploring", "Exploring model tool calls");

    const toolResultsAcc: ToolResult[] = [];
    let assistantText = "";
    let assistantReasoning = "";
    let keepLooping = true;
    let truncationRetries = 0;
    let overflowRetried = false;
    /**
     * Source files this turn actually changed. Only the gateway's resolved paths
     * decide this, so a plan-mode write to `.inflynx/PLAN.md` does not trigger a
     * verification gate, and `src/../src/app.ts` does.
     */
    const touchedSourceFiles = new Set<string>();
    let gateReport: VerificationReport | undefined;
    let verificationRounds = 0;

    while (keepLooping) {
      if (signal.aborted) {
        keepLooping = false;
        break;
      }

      const limitCheck = this.budgetManager.checkLimits();
      if (limitCheck.isExhausted) {
        this.eventBus.emit("session.failed", this.context.sessionId, { reason: limitCheck.reason });
        this.transitionTo("failed", limitCheck.reason ?? "Agent budget exhausted");
        break;
      }

      const modelRateLimit = await this.budgetManager.checkModelRateLimit();
      if (!modelRateLimit.allowed) {
        const reason =
          `Model rate limit reached (${modelRateLimit.limit} calls/60s). ` +
          `Retry in ${modelRateLimit.resetInSec}s.`;
        this.eventBus.emit("session.failed", this.context.sessionId, { reason });
        this.transitionTo("failed", reason);
        break;
      }

      // Stay inside the model's window *before* spending a turn on a request that
      // the provider is going to reject anyway (backlog C1/C2).
      await this.makeRoomInWindow();

      this.budgetManager.recordTurn();
      this.eventBus.emit("turn.started", this.context.sessionId, {
        turnNumber: this.budgetManager.getBudgetState().modelTurns,
      });

      assistantText = "";
      assistantReasoning = "";
      const pendingToolCallsMap = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
      let providerMetadata: Message["provider_metadata"];
      let finishReason: FinishReason = "stop";

      // Prepare tools allowed for active mode
      const allTools = this.registry.list();
      const allowedNames = new Set(filterToolsForMode(allTools, this.context.activeMode).map((t) => t.name));
      const activeTools = allTools
        .filter((t) => allowedNames.has(t.name))
        .map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

      this.budgetManager.noteRequestSent(this.context.history.length);

      try {
        const stream = streamModel({
          provider: this.context.providerId as any,
          model: this.context.model,
          messages: this.context.history,
          apiKey: this.context.apiKey,
          tools: activeTools,
          baseURL: this.context.baseURL,
          adapter: this.context.modelAdapter,
          reasoningEffort: this.context.reasoningEffort,
          maxTokens: (this.context.maxTokens ?? this.budgetManager.outputLimit) || undefined,
          thinkingBudget: this.budgetManager.getEffortProfile().thinkingBudgetTokens,
          allowUnauthenticated: this.context.allowUnauthenticated,
          allowLocalEndpoint: this.context.allowLocalEndpoint,
          customCapabilities: this.context.customCapabilities,
        }, signal);

        for await (const event of stream) {
          if (event.type === "text_delta") {
            // The model's own history keeps the RAW text. Redaction belongs on
            // egress (event stream, persistence, logs) only: applying it to what
            // the model reads back silently corrupts the next edit it makes.
            assistantText += event.text;
            this.eventBus.emit("model.text_delta", this.context.sessionId, {
              text: redactSecrets(event.text),
            });
          } else if (event.type === "thought_delta") {
            assistantReasoning += event.thought;
            this.eventBus.emit("model.thought_delta", this.context.sessionId, {
              thought: redactSecrets(event.thought),
            });
          } else if (event.type === "tool_call") {
            if (!pendingToolCallsMap.has(event.id)) {
              pendingToolCallsMap.set(event.id, { id: event.id, name: event.name, args: event.args });
            }
          } else if (event.type === "done") {
            this.budgetManager.recordUsage(event.usage);
            finishReason = event.finishReason;
            providerMetadata = event.providerMetadata;
            if (event.actualModel) {
              this.context.actualModel = event.actualModel;
              await this.sessionStore.updateSessionModelConfig(this.context.sessionId, {
                ...this.currentSessionModelConfig(),
                actualModel: event.actualModel,
              });
            }
            // Persist updated token telemetry to SessionStore
            const state = this.budgetManager.getBudgetState();
            await this.sessionStore.updateTokenTelemetry(this.context.sessionId, {
              promptTokens: state.promptTokens,
              completionTokens: state.completionTokens,
              reasoningTokens: state.reasoningTokens,
              estimatedCostUsd: state.estimatedCostUsd,
            });
          }
        }

        const collectedToolCalls = Array.from(pendingToolCallsMap.values());

        // A stream that stopped at the output ceiling may carry a half-written
        // `arguments` blob. Executing it could write corrupted source, so a
        // truncated round never executes tool calls — every adapter reported
        // `finishReason` correctly and every one of them was ignored (C5).
        const truncated = finishReason === "length";
        const pendingToolCalls = truncated ? [] : collectedToolCalls;

        if (finishReason === "content_filter" || finishReason === "error") {
          this.eventBus.emit("turn.failed", this.context.sessionId, {
            error:
              finishReason === "content_filter"
                ? "The provider filtered this response before it finished. Rephrase the request or narrow the attached context."
                : "The provider reported an error while generating this response.",
          });
          keepLooping = false;
          continue;
        }

        // Record assistant turn in context
        const assistantMsg: Message = { role: "assistant", content: assistantText };
        if (assistantReasoning) assistantMsg.reasoning_content = assistantReasoning;
        if (providerMetadata) assistantMsg.provider_metadata = providerMetadata;
        if (pendingToolCalls.length > 0) {
          assistantMsg.tool_calls = pendingToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        this.context.addMessage(assistantMsg);

        let savedReasoning = assistantReasoning;
        if (!savedReasoning && (providerMetadata as any)?.openrouterReasoningDetails) {
          const details = (providerMetadata as any).openrouterReasoningDetails;
          if (Array.isArray(details)) {
            savedReasoning = details.map((d: any) => d?.summary || "").filter(Boolean).join("");
          }
        }

        // Persist assistant message to SessionStore
        await this.sessionStore.saveMessage(this.context.sessionId, {
          role: "assistant",
          content: redactSecrets(assistantText),
          reasoningContent: savedReasoning ? redactSecrets(savedReasoning) : undefined,
          toolCallsJson: pendingToolCalls.length > 0 ? JSON.stringify(pendingToolCalls) : undefined,
          providerMetadataJson: providerMetadata ? JSON.stringify(providerMetadata) : undefined,
        });

        if (truncated) {
          if (
            truncationRetries < MAX_TRUNCATION_RETRIES &&
            this.context.raiseOutputTokenBudget(this.budgetManager.outputLimit || 32_768)
          ) {
            truncationRetries++;
            this.context.addMessage({
              role: "user",
              content:
                "Your previous response hit the output-token limit and was cut off. Continue from " +
                "exactly where you stopped; do not repeat or restart earlier output.",
            });
            continue;
          }
          this.eventBus.emit("turn.failed", this.context.sessionId, {
            error:
              `Model output was still truncated at ${this.context.maxOutputTokens} tokens after ` +
              `${truncationRetries} retry attempt(s). Split this into smaller edits or reduce the ` +
              `amount of text requested per turn.`,
          });
          this.transitionTo("failed", "Output truncated repeatedly");
          break;
        }

        // Execute tool calls if any
        if (pendingToolCalls.length > 0) {
          this.transitionTo("implementing", "Executing proposed tool calls");

          for (const tc of pendingToolCalls) {
            if (signal.aborted) {
              keepLooping = false;
              break;
            }

            tc.args = safeParseJsonArgs(tc.args);
            const toolDef = this.registry.get(tc.name);
            let permissionLevel = toolDef?.permissionLevel || "readonly";
            // `git` is declared mutating as a container, but `git status` is not a write.
            // Requiring approval for read-only repository inspection would make the tool
            // unusable, while a *missing* check on `git commit` would be worse than both —
            // so the grade comes from the argv, exactly as the shell path decides.
            if (tc.name === "git") {
              const rawArgs = (tc.args as Record<string, unknown>)?.args;
              const grade = classifyGitInvocation(Array.isArray(rawArgs) ? rawArgs.map(String) : []).grade;
              if (grade === "read-only") permissionLevel = "readonly";
            }
            // Carried into the approval decision so a self-declared "readonly" from a
            // remote MCP server cannot buy itself an auto-approval (backlog B9).
            const origin = toolDef?.origin || "core";

            // A read-only-by-rule command needs no human, and a hard denial is not
            // offered for approval either — prompting "approve this?" for something the
            // policy will refuse regardless is noise that trains the user to click
            // through prompts. The denial still goes to the gateway, which refuses and
            // audits it, so the model gets a correctable error rather than silence.
            const shellReview =
              permissionLevel === "shell" || tc.name === "execute_shell"
                ? reviewShellCommand(String((tc.args as Record<string, unknown>)?.command || ""))
                : null;
            const autoAllowedByRule = shellReview?.decision === "allow";
            let needsHuman = shellReview ? shellReview.decision === "ask" : true;

            // Anti-fake-fix review (backlog Phase 32). Computed here so the human is shown
            // *why* this edit is unusual before approving it, and so approving it means an
            // explicit override that the gateway can then accept. Core tools only: an MCP
            // server's own content is not something these patterns can sensibly judge.
            let patchSafety: PatchSafetyReview | null = null;
            if (toolDef?.isMutating && origin === "core") {
              try {
                patchSafety = reviewMutatingPatchForSafety(toolDef, tc.args as Record<string, unknown>, {
                  readGuarded: (p: string) => this.gateway.readGuardedText(p),
                });
              } catch {
                patchSafety = null; // a review failure must never block a legitimate edit
              }
            }
            const patchNeedsOverride = Boolean(patchSafety && !patchSafety.safe);
            // A violation always reaches a human, even for a tool the provider would
            // otherwise have waved through.
            needsHuman = needsHuman || patchNeedsOverride;

            this.eventBus.emit("tool.proposed", this.context.sessionId, {
              toolCallId: tc.id,
              toolName: tc.name,
              permissionLevel,
              origin,
              args: tc.args,
              ...(shellReview
                ? {
                    shellDecision: shellReview.decision,
                    shellHeadline: shellReview.headline,
                    shellSegments: shellReview.verdicts.map((v) => ({
                      text: v.text,
                      decision: v.decision,
                      reason: v.reason,
                    })),
                  }
                : {}),
              ...(patchSafety && !patchSafety.safe
                ? {
                    patchSafetyRules: patchSafety.violations.map((v: PatchSafetyViolation) => v.rule),
                    patchSafetySummary: patchSafety.violations.map((v: PatchSafetyViolation) => v.reason).join(" "),
                  }
                : {}),
            });

            // Approval check
            const approved =
              !needsHuman ||
              (await this.approvalProvider.requestApproval({
                toolCallId: tc.id,
                toolName: tc.name,
                permissionLevel,
                origin,
                args: tc.args,
                shellReview: shellReview || undefined,
                patchSafety: patchSafety || undefined,
              }));

            if (approved) {
              this.eventBus.emit("tool.approved", this.context.sessionId, { toolCallId: tc.id, toolName: tc.name });
              this.eventBus.emit("tool.started", this.context.sessionId, { toolCallId: tc.id, toolName: tc.name });

              const result = await this.gateway.executeGuarded(
                this.registry,
                tc as ToolCall,
                {
                  activeMode: this.context.activeMode,
                  sessionId: this.context.sessionId,
                  // Which of the two clears this run reached the gateway is exactly what
                  // the audit log is for: the rules cleared it, or a person did. Reaching
                  // here any other way is refused by the gateway (see 3b there).
                  shellApprovalSource: autoAllowedByRule ? ("rule:allow" as const) : ("user:prompt" as const),
                  // Only set when this patch tripped the fake-fix rules AND a human
                  // approved after being shown them. Reaching the gateway with a violation
                  // and without this is refused there — the same "required a human, prove
                  // one agreed" rule the shell path enforces.
                  patchApprovalSource: patchNeedsOverride ? ("user:override-patch-safety" as const) : undefined,
                },
                signal
              );

              this.budgetManager.recordToolCall(permissionLevel);
              toolResultsAcc.push(result);
              if (result.touchedSourceFile && result.touchedPath) {
                touchedSourceFiles.add(result.touchedPath);
              }
              // `plan.updated` existed in the protocol and had no emitter, so every plan UI
              // was wired to a signal that never fired. The tool carries the structured plan
              // rather than making each consumer re-parse markdown — see Phase 26.
              if (result.plan && !result.isError) {
                this.eventBus.emit("plan.updated", this.context.sessionId, {
                  plan: result.plan,
                  toolCallId: tc.id,
                  goal: result.plan.goal,
                  status: result.plan.status,
                  completed: result.plan.steps.filter((s) => s.status === "completed").length,
                  total: result.plan.steps.length,
                });
              }

              // Persist tool execution output to SessionStore
              await this.sessionStore.saveToolExecution(this.context.sessionId, {
                toolCallId: tc.id,
                toolName: tc.name,
                argsJson: JSON.stringify(tc.args),
                output: redactSecrets(result.output),
                isError: Boolean(result.isError),
                durationMs: result.durationMs,
              });

              this.eventBus.emit("tool.output", this.context.sessionId, {
                toolCallId: tc.id,
                toolName: tc.name,
                isError: result.isError,
                durationMs: result.durationMs,
                outputSnippet: redactSecrets(result.output).slice(0, 300),
              });

              // RAW output into context: a redacted `handle_user_authentication_flow`
              // is a different program, and the model would write the corruption
              // straight back to disk. Note the deliberate trade-off — this means
              // secrets inside readable files reach the provider. Redaction is not
              // the right control for that; the sensitive-path fence (backlog
              // Phase 33) is, because it prevents the read in the first place
              // instead of feeding the model a doctored version of its own repo.
              this.context.addMessage({
                role: "tool",
                content: result.output,
                tool_call_id: tc.id,
                // Tell the model this failed. Anthropic in particular marks the
                // tool_result block, and gateway refusals don't start with "Error:".
                is_error: Boolean(result.isError),
              });

              // Persist tool message response to SessionStore
              await this.sessionStore.saveMessage(this.context.sessionId, {
                role: "tool",
                content: redactSecrets(result.output),
                toolCallId: tc.id,
              });
            } else {
              // "Error: " prefix keeps the semantics correct for transcripts stored
              // before Message.is_error existed, and for providers without an
              // explicit error field on tool results.
              //
              // The reason is included, not just the fact of refusal: a denial that says
              // only "denied" gives the model nothing to correct, so it re-attempts a
              // variant of the same suppressed diagnostic.
              const deniedReason = patchNeedsOverride
                ? ` This edit was refused by anti-fake-fix policy:\n`
                  + patchSafety!.violations.map((v: PatchSafetyViolation) => `- ${v.reason}`).join("\n")
                  + `\nFix the underlying defect instead. If you believe the rule is wrong here, ` +
                  `explain why in your reply and ask the user to override it.`
                : "";
              const deniedMsg = `Error: Tool execution was denied by approval policy or user.${deniedReason}`;
              // The refusal is a result the turn owes its consumers: `TurnResult.toolResults`
              // drives the CLI's tool summary and the extension's transcript, and a tool the
              // human refused used to vanish from both — the model knew, the UI did not.
              toolResultsAcc.push({
                toolCallId: tc.id,
                toolName: tc.name,
                output: deniedMsg,
                isError: true,
                // Nothing ran, so nothing took time. The approval wait is deliberately not
                // counted here — that would be reported as if it were execution time.
                durationMs: 0,
              });
              this.context.addMessage({
                role: "tool",
                content: deniedMsg,
                tool_call_id: tc.id,
                is_error: true,
              });
              await this.sessionStore.saveMessage(this.context.sessionId, {
                role: "tool",
                content: deniedMsg,
                toolCallId: tc.id,
              });
            }
          }
        } else {
          // The model has stopped calling tools. If this turn changed source code,
          // "done" cannot mean "I said so" — run the workspace's own gates and give
          // the model a bounded chance to fix what they report (backlog C13/L3).
          const gate = await this.runVerificationGate(signal, touchedSourceFiles, verificationRounds);
          if (gate.action === "repair") {
            verificationRounds++;
            this.context.addMessage({ role: "user", content: gate.prompt });
            continue;
          }
          gateReport = gate.report;
          keepLooping = false;
        }

      } catch (err: any) {
        // Adapters throw `InflynxProviderError`; anything else (a bug in a tool, a
        // store failure) gets wrapped so this layer always has a kind to act on
        // rather than a string to squint at (backlog Phase 9).
        const providerErr = toProviderError(this.context.providerId, err);
        const errorMessage = redactSecrets(providerErr.message || String(err));

        // A prompt that outgrew the window is recoverable: drop stale tool results
        // and send again. Before this it was a fatal turn.failed with the oversized
        // history still in memory, so the session was dead (backlog C4).
        if (providerErr.kind === "context_overflow" && !overflowRetried) {
          overflowRetried = true;
          // The provider's own "too long" overrides our estimate, so force the pass
          // rather than re-deriving utilization and possibly deciding there is no
          // pressure at all.
          const relief = await this.makeRoomInWindow({ force: true, summarize: true });
          if (relief.dropped > 0 || relief.summarized > 0) {
            console.warn(
              `[agent-core] context overflow — freed ${relief.charsFreed.toLocaleString()} chars ` +
              `(evicted ${relief.dropped}, summarized ${relief.summarized ? "1 block" : "nothing"}) and ` +
              `retrying this turn once.`
            );
            continue;
          }
        }

        const exhausted =
          providerErr.kind === "context_overflow"
            ? `${providerErr.userMessage} This conversation exceeded the model's context window `
              + `with nothing left to evict — start a new session or switch to a larger-window model.`
            : providerErr.userMessage;

        this.eventBus.emit("turn.failed", this.context.sessionId, {
          error: providerErr.kind === "unknown" ? errorMessage : exhausted,
          errorKind: providerErr.kind,
          retryable: providerErr.retryable,
          ...(providerErr.status ? { httpStatus: providerErr.status } : {}),
        });
        keepLooping = false;
      }
    }

    // Runs on every exit path out of the loop (abort, budget stop, error, or a
    // clean finish) so a dangling assistant `tool_calls` message can never be
    // carried into the next request, in memory or in the stored transcript.
    await this.repairHistoryIntegrity();

    // The gate normally runs inside the loop, when the model stops calling tools. A
    // loop that ended another way (abort, budget, truncation, provider error) never
    // reached it — report that as `not-run` rather than leaving the field absent, so
    // a UI cannot render "no verification needed" for a turn that edited files.
    if (touchedSourceFiles.size > 0 && !gateReport) {
      gateReport = this.verificationReport("not-run", [...touchedSourceFiles], {
        summaryMessage:
          "⚠ This turn changed source files but the verification gate did not run — " +
          "the turn ended before it could. Treat the result as unverified.",
        totalChecks: 0,
      }, verificationRounds);
    }

    // Closing the lifecycle honestly: a turn that changed code went through
    // `verifying` (and possibly `repairing`), and a read-only turn stays in
    // `exploring`. Requesting `verifying` unconditionally is what produced a refusal
    // on every plain question.
    if (this.stateMachine.state === "implementing") {
      // `implementing → verifying → completed` is the only legal forward path, and
      // `implementing` is entered for *any* tool call — including a turn that only
      // read files. So this transit is lifecycle bookkeeping, not evidence that checks
      // ran. Consumers must key off `verification.started` or `TurnResult.verification`
      // for that, never off this label; the reason string says which case happened.
      this.transitionTo(
        "verifying",
        gateReport ? "Turn verification" : "No source files changed — gate not applicable"
      );
    } else if (this.stateMachine.state === "repairing") {
      // A repair attempt ended without a re-check (interrupt or provider failure
      // mid-repair). `repairing → verifying` is the only legal forward edge, and it
      // is accurate: the fix is unverified.
      this.transitionTo("verifying", "Repair attempt ended; gate did not re-run");
    }

    const isCompleted = this.stateMachine.canTransitionTo("completed");
    if (isCompleted) {
      this.stateMachine.transitionTo("completed", "Turn execution finished");
    }

    // Close the undo journal for this turn. A turn that wrote nothing produces no
    // checkpoint, so `/undo` walks past it to the last turn that actually changed files.
    const checkpoint = await this.gateway.checkpoints.commitTurn();

    return {
      sessionId: this.context.sessionId,
      // Egress boundary: callers put these straight onto a UI, an SSE stream or
      // a log, so this is where redaction belongs.
      finalText: redactSecrets(assistantText),
      finalReasoning: assistantReasoning ? redactSecrets(assistantReasoning) : undefined,
      state: this.stateMachine.state,
      toolResults: toolResultsAcc,
      budgetState: this.budgetManager.getBudgetState(this.context.history),
      isCompleted,
      turnId,
      ...(gateReport ? { verification: gateReport } : {}),
      ...(checkpoint ? { checkpointFiles: checkpoint.entries.map((e) => e.path) } : {}),
    };
  }

  /** Turns with a checkpoint on disk for this session, newest first (what `/undo` lists). */
  listCheckpoints(): Array<{ turnId: string; label: string; at: number; files: string[]; undone: boolean }> {
    return this.gateway.checkpoints.list(this.context.sessionId).map((c) => ({
      turnId: c.turnId,
      label: c.label,
      at: c.createdAt,
      files: c.entries.map((e) => e.path),
      undone: Boolean(c.undoneAt),
    }));
  }

  /**
   * Revert the most recent checkpointed turn of this session. Refuses, per file, anything
   * that has been edited since — a human's concurrent work is never overwritten, which is
   * the same rule `EditTransactionManager.commit()` now applies before its own writes.
   */
  undoLastTurn(): { turnId: string; restored: string[]; conflicts: Array<{ path: string; reason: string }> } | null {
    const latest = this.gateway.checkpoints.latest(this.context.sessionId);
    if (!latest) return null;
    const outcome = this.gateway.checkpoints.undo(latest);
    // The transcript is now describing work that has been taken back; say so in-session so
    // the model does not keep reasoning about files that no longer exist.
    this.context.addMessage({
      role: "user",
      content:
        `/undo reverted the previous turn (${outcome.restored.length} file(s) restored` +
        (outcome.conflicts.length ? `, ${outcome.conflicts.length} refused` : "") +
        `). Discard any earlier assumption about those paths and re-read them if needed.`,
    });
    return { turnId: outcome.turnId, restored: outcome.restored, conflicts: outcome.conflicts };
  }

  /**
   * Transitions when legal and *reports* refusals loudly. The previous silent
   * `if (canTransitionTo)` guards are what let the machine sit frozen in
   * `completed` for the rest of a session with no diagnostic at all (backlog C7).
   */
  private transitionTo(state: AgentState, reason: string): void {
    if (this.stateMachine.tryTransitionTo(state, reason)) return;
    const allowed = LEGAL_STATE_TRANSITIONS[this.stateMachine.state] ?? [];
    console.error(
      `[agent-core] refused state transition "${this.stateMachine.state}" → "${state}" (${reason}). ` +
      `Legal targets from "${this.stateMachine.state}": ${allowed.join(", ") || "none"}`
    );
  }

  /**
   * Synthesizes any missing tool responses and persists them, so both the live
   * context and the stored transcript stay replayable after an abort or failure.
   */
  private async repairHistoryIntegrity(): Promise<void> {
    const synthesized = this.context.ensureHistoryIntegrity();
    for (const stub of synthesized) {
      await this.sessionStore.saveMessage(this.context.sessionId, {
        role: "tool",
        content: stub.content,
        toolCallId: stub.tool_call_id,
      });
    }
  }

  /**
   * Manual context relief for `/compact`. Runs the free tier (eviction) and, when
   * the session's strategy allows it, the summarization tier — and reports what each
   * one actually freed, so the command cannot quietly become a no-op the way it was
   * while `ContextManager` sat unwired. The persisted transcript is untouched: this
   * only shrinks what gets sent next.
   */
  async compactContextNow(
    options: { summarize?: boolean } = {}
  ): Promise<{ dropped: number; charsFreed: number; summarized: number; utilizationPercent: number }> {
    const relief = await this.makeRoomInWindow({
      force: true,
      summarize: options.summarize ?? this.context.contextStrategy === "compact",
    });
    return {
      ...relief,
      utilizationPercent: Math.round(this.budgetManager.contextUtilization(this.context.history) * 100),
    };
  }

  /**
   * The verification gate, and the bounded repair loop in front of it.
   *
   * Called when the model stops asking for tools. If the turn wrote no source files
   * there is nothing to verify and the turn ends as it always did — the gate is not
   * a tax on read-only answers. If it did, the workspace's own scripts decide whether
   * the work is done, because "the model said it finished" was never evidence
   * (backlog C13: the verification loop existed and was simply never called).
   *
   * Returns either "stop" with a report, or "repair" with a corrective message to put
   * back to the model. Bounded by the effort profile's `maxVerificationRuns` so a
   * repo that simply does not build cannot trap the agent in a loop.
   */
  private async runVerificationGate(
    signal: AbortSignal,
    touchedSourceFiles: Set<string>,
    round: number
  ): Promise<{ action: "stop"; report?: VerificationReport } | { action: "repair"; prompt: string; report: VerificationReport }> {
    const changed = [...touchedSourceFiles];
    if (changed.length === 0) return { action: "stop" };

    if (signal.aborted) {
      return {
        action: "stop",
        report: this.verificationReport("cancelled", changed, {
          summaryMessage: "Verification skipped — the turn was interrupted.",
          totalChecks: 0,
        }, round),
      };
    }

    const profile = this.budgetManager.getEffortProfile();
    const engine = new VerificationEngine(this.context.sessionId, this.eventBus, {
      depth: profile.verificationDepth,
      runFullRegressionSuite: profile.runFullRegressionSuite,
    });
    const checks: VerificationCheck[] = engine.discoverWorkspaceChecks(this.context.workspaceRoot);

    if (checks.length === 0) {
      // The honest branch. Reporting success here is how a project with no scripts
      // would look "verified" forever.
      console.warn(
        `[agent-core] ${changed.length} source file(s) changed but this workspace declares no ` +
        `verification scripts — the turn cannot be confirmed.`
      );
      return {
        action: "stop",
        report: this.verificationReport("no-gates-configured", changed, {
          summaryMessage:
            `⚠ Wrote ${changed.length} source file(s) but no typecheck/build/test script was ` +
            `discovered, so nothing was verified.`,
          totalChecks: 0,
        }, round),
      };
    }

    this.transitionTo("verifying", `Verifying ${changed.length} changed file(s)`);
    const summary: SuiteSummary = await engine.runAllChecks(this.context.workspaceRoot, signal);
    const failedNames = summary.results.filter((r) => !r.passed).map((r) => r.checkName);

    if (summary.passed) {
      return {
        action: "stop",
        report: this.verificationReport("passed", changed, summary, round),
      };
    }

    const budgetExhausted = round >= profile.maxVerificationRuns;
    const limitsSpent = this.budgetManager.checkLimits().isExhausted;
    if (budgetExhausted || limitsSpent || signal.aborted) {
      return {
        action: "stop",
        report: this.verificationReport("failed", changed, summary, round),
      };
    }

    // One more chance, with the actual failure rather than a generic "try again".
    this.transitionTo("repairing", `Gate failed: ${failedNames.join(", ")}`);
    const errors = summary.results.flatMap((r) => r.parsedErrors);
    new RepairLoop(this.context.sessionId, this.eventBus)
      .notifyRepairAttempt(round + 1, profile.maxVerificationRuns, errors);
    this.budgetManager.recordRetry();

    return {
      action: "repair",
      prompt: this.formatGateFailureForModel(changed, summary, round + 1, profile.maxVerificationRuns),
      report: this.verificationReport("failed", changed, summary, round),
    };
  }

  /**
   * The canonical path guard this session's tools will be checked against.
   *
   * Exposed so a UI can resolve a preview path with the **same** authority the gateway
   * will use when it executes. Before this, the CLI's diff preview re-implemented path
   * resolution with `path.isAbsolute` + `join` and read the file *before* approval, so a
   * proposal naming an absolute path outside the workspace disclosed that file's contents
   * even though the write itself was correctly refused (backlog N6).
   */
  getPathGuard(): CanonicalPathGuard {
    return this.gateway.getPathGuard();
  }

  /**
   * Display path for a file the gateway reported.
   *
   * Relativised against the **guard's** canonical root, not `context.workspaceRoot`:
   * the guard has already run `realpathSync`, and on macOS `/var` is a symlink to
   * `/private/var`, so mixing the two produced `../../../../../../private/var/…`
   * in place of `app.ts`. Same class of bug the guard exists to prevent, arriving in
   * a cosmetic string.
   */
  private displayPath(absolutePath: string): string {
    const root = this.gateway.getPathGuard().getWorkspaceRoot();
    const rel = path.relative(root, absolutePath);
    return rel && !rel.startsWith("..") ? rel : absolutePath;
  }

  private verificationReport(
    outcome: VerificationOutcome,
    changed: string[],
    summary: Pick<SuiteSummary, "summaryMessage"> & Partial<SuiteSummary>,
    repairAttempts: number
  ): VerificationReport {
    return {
      outcome,
      sourceFilesChanged: changed.map((p) => this.displayPath(p)),
      checksRun: summary.totalChecks ?? 0,
      failedChecks: summary.results?.filter((r) => !r.passed).map((r) => r.checkName) ?? [],
      packageManager: summary.packageManager?.manager,
      depth: this.budgetManager.getEffortProfile().verificationDepth,
      repairAttempts,
      summaryMessage: summary.summaryMessage,
    };
  }

  /**
   * The failure report sent back to the model. Bounded and concrete: a raw 200 KB
   * build log both floods the window and buries the one line that matters, while a
   * bare "tests failed" gives it nothing to act on.
   */
  private formatGateFailureForModel(
    changed: string[],
    summary: SuiteSummary,
    attempt: number,
    maxAttempts: number
  ): string {
    const MAX_LINES_PER_CHECK = 25;
    const blocks: string[] = [];

    for (const result of summary.results) {
      if (result.passed) continue;
      const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const shown = lines.slice(0, MAX_LINES_PER_CHECK).join("\n");
      blocks.push(
        `--- ${result.checkName} (${result.checkId}) failed with exit code ${result.exitCode} ---\n` +
        (result.timedOut ? `[timed out — do not "fix" the code; the check itself was cut off]\n` : "") +
        (shown || "(no output)") +
        (lines.length > MAX_LINES_PER_CHECK ? `\n[…${lines.length - MAX_LINES_PER_CHECK} more line(s)…]` : "")
      );
    }

    const structured = summary.results
      .flatMap((r) => r.parsedErrors)
      .slice(0, 12)
      .map((e: DiagnosticError) => `  ${e.filePath || "?"}${e.line ? `:${e.line}` : ""}: ${(e.rawOutput || e.message).slice(0, 200)}`)
      .join("\n");

    return [
      `The verification gate ran after your edits and **failed** (repair attempt ${attempt} of ${maxAttempts}).`,
      `Files you changed in this turn: ${changed.map((p) => this.displayPath(p)).join(", ")}`,
      "",
      ...blocks,
      structured ? `\nLocations:\n${structured}` : "",
      "",
      "Fix the underlying cause now. Do not suppress, skip, or delete what is failing — a",
      "`@ts-ignore`, a `.skip` on a test, or an emptied assertion is a fake fix and will be",
      "rejected. If a failure is genuinely unrelated to your changes, say so explicitly and",
      "explain why instead of editing around it.",
    ].join("\n");
  }

  /**
   * Resolve and publish the window for the model actually in use. Everything that
   * measures or protects context reads these two numbers, so this runs at
   * construction (and therefore again after `switchModel`/`resumeSession`, which
   * both build a new orchestrator).
   */
  private applyModelWindow(): void {
    const limits = resolveContextLimits(
      this.context.providerId,
      this.context.model,
      this.context.customCapabilities
    );
    this.budgetManager.setModelWindow(limits.contextWindow, limits.maxOutputTokens);
  }

  /**
   * Keep the next request inside the model's window, cheapest tier first.
   *
   *   1. **Evict** stale tool output (free, lossless for decisions already acted on).
   *   2. **Summarize** the oldest turns — only above `CONTEXT_COMPACT_LIMIT`, and only
   *      when the session's `contextStrategy` allows it, because it costs a model call
   *      and rewrites what the model remembers. `evict` (the default) opts out of the
   *      routine pass but still allows it as an overflow last resort; `off` never
   *      spends a call.
   *
   * `force` is for the overflow path, where the provider's own "too long" beats our
   * estimate of how full we are.
   */
  private async makeRoomInWindow(
    options: { force?: boolean; summarize?: boolean } = {}
  ): Promise<{ dropped: number; charsFreed: number; summarized: number }> {
    const result = { dropped: 0, charsFreed: 0, summarized: 0 };
    if (!this.budgetManager.windowKnown) return result;

    let utilization = this.budgetManager.contextUtilization(this.context.history);
    if (!options.force && utilization <= CONTEXT_SOFT_LIMIT) return result;

    for (const protect of CONTEXT_PROTECTION_LADDER) {
      if (!options.force && utilization <= CONTEXT_SOFT_LIMIT) break;
      const relief = this.context.evictStaleToolResults({ protectRecentMessages: protect });
      if (relief.dropped === 0) continue;
      result.dropped += relief.dropped;
      result.charsFreed += relief.charsFreed;
      this.budgetManager.accountForEviction(relief.charsFreed);
      utilization = this.budgetManager.contextUtilization(this.context.history);
    }

    const strategy = this.context.contextStrategy;
    const maySummarize =
      options.summarize !== false &&
      strategy !== "off" &&
      (strategy === "compact" || options.force === true);

    if (maySummarize && (options.force || utilization > CONTEXT_COMPACT_LIMIT)) {
      const summary = await this.compactHistoryWithSummary();
      if (summary > 0) {
        result.summarized = 1;
        result.charsFreed += summary;
        utilization = this.budgetManager.contextUtilization(this.context.history);
      }
    }

    if (result.dropped > 0) {
      // The tombstone tells the model to re-run the call, so any "already read this
      // turn" pointer into the dropped output has to go too.
      this.gateway.invalidateTurnCache();
      console.warn(
        `[agent-core] context near capacity — evicted ${result.dropped} stale tool result(s) ` +
        `(${result.charsFreed.toLocaleString()} chars); now at ${Math.round(utilization * 100)}% of the ` +
        `${this.budgetManager.contextWindowTokens.toLocaleString()}-token window.`
      );
    } else if (result.summarized === 0) {
      console.warn(
        `[agent-core] context at ${Math.round(utilization * 100)}% of the window with nothing left to evict. `
      );
    }
    return result;
  }

  /**
   * One summarization pass over the oldest safe slice of history. Returns the
   * characters freed, or 0 when there was nothing to fold or the model could not
   * produce a summary — a failed compaction must leave the session usable, so every
   * problem here is a silent no-op rather than a torn-down history.
   */
  private async compactHistoryWithSummary(): Promise<number> {
    const plan = this.context.compactionPlan({ keepRecentMessages: 8 });
    if (!plan) return 0;

    // Keep the excerpt well under the window it is meant to relieve, and leave the
    // summarizer's own answer some room.
    const budget = Math.max(2_000, Math.floor(this.budgetManager.contextWindowTokens * 4 * 0.3));
    const excerpt = serializeForSummary(plan.messages, budget);
    if (!excerpt.trim()) return 0;

    let text = "";
    try {
      const stream = streamModel({
        provider: this.context.providerId as any,
        model: this.context.model,
        // Deliberately no `tools`: a compaction that starts calling the filesystem
        // would be a compaction that never finishes.
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          { role: "user", content: excerpt },
        ],
        apiKey: this.context.apiKey,
        baseURL: this.context.baseURL,
        adapter: this.context.modelAdapter,
        maxTokens: 1_024,
        allowUnauthenticated: this.context.allowUnauthenticated,
        allowLocalEndpoint: this.context.allowLocalEndpoint,
        customCapabilities: this.context.customCapabilities,
      }, this.context.signal);

      for await (const event of stream) {
        if (event.type === "text_delta") text += event.text;
      }
    } catch (err: any) {
      console.warn(
        `[agent-core] context summarization skipped (${redactSecrets(err?.message || String(err)).slice(0, 160)}); ` +
        `eviction alone will have to carry this session.`
      );
      return 0;
    }

    const summary = text.trim();
    // A summary that is barely shorter than what it replaces is worse than nothing:
    // it spends a model call to lose fidelity and save no space.
    if (!summary || summary.length > plan.chars * 0.5) return 0;

    const applied = this.context.applyCompaction(plan, summary);
    // The folded messages are gone from the model's view, so dedupe pointers into
    // them must not survive either.
    this.gateway.invalidateTurnCache();
    // History was *rewritten*, so the provider-anchored estimate no longer describes
    // it and the tail index points into a different array. Re-estimate from scratch;
    // the next real response re-anchors on ground truth.
    this.budgetManager.reanchorAfterRewrite(this.context.history);
    console.warn(
      `[agent-core] compacted ${applied.dropped} oldest message(s) into one summary ` +
      `(${applied.charsFreed.toLocaleString()} chars freed). The full transcript stays in the session store.`
    );
    return applied.charsFreed;
  }

  private currentSessionModelConfig(): {
    provider: string;
    model: string;
    credentialProfileId?: string;
    baseUrl?: string;
    reasoningEffort?: string;
    actualModel?: string;
  } {
    return {
      provider: this.context.providerId,
      model: this.context.model,
      credentialProfileId: this.context.credentialProfileId,
      baseUrl: this.context.baseURL,
      reasoningEffort: this.context.reasoningEffort,
      actualModel: this.context.actualModel,
    };
  }

  private static assertModelSelection(options: ExecutionOptions): void {
    if (!options.reasoningEffort) return;
    if (options.providerId === "custom-openai-compatible") {
      if (!options.customCapabilities?.supportedEfforts.includes(options.reasoningEffort)) {
        throw new Error(
          `Custom model "${options.model}" does not declare support for effort "${options.reasoningEffort}".`
        );
      }
      return;
    }
    assertSupportedReasoningEffort(options.providerId, options.model, options.reasoningEffort);
  }
}

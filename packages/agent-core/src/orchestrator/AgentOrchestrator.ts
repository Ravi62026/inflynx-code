import { AgentEventBus, type PublicAgentEvent } from "@inflynx/protocol";
import { streamModel, type Message, type ModelEvent, type ReasoningEffort, type TokenUsage } from "@inflynx/model-gateway";
import {
  assertSupportedReasoningEffort,
  getCredentialProfile,
  getProvider,
  redactSecrets,
  resolveCredentialSecret,
} from "@inflynx/config";
import { ToolRegistry, safeParseJsonArgs, type ToolCall, type ToolResult } from "@inflynx/tool-runtime";
import { ToolExecutionGateway } from "@inflynx/tool-runtime";
import { createSessionStore, generateSessionId, type SessionStore } from "@inflynx/session-store";
import { StateMachine, type AgentState } from "./StateMachine.js";
import { BudgetManager, type AgentBudgetLevel, type BudgetState } from "./BudgetManager.js";
import { ExecutionContext, type ExecutionOptions } from "./ExecutionContext.js";
import { ApprovalProvider, type ApprovalHandler } from "./ApprovalProvider.js";
import { filterToolsForMode } from "../index.js";

export interface TurnResult {
  sessionId: string;
  finalText: string;
  finalReasoning?: string;
  state: AgentState;
  toolResults: ToolResult[];
  budgetState: BudgetState;
  isCompleted: boolean;
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
    return this.budgetManager.getBudgetState();
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
  async runTurn(userPrompt: string, attachedContext?: string): Promise<TurnResult> {
    if (this.stateMachine.canTransitionTo("classifying")) {
      this.stateMachine.transitionTo("classifying", "Starting new task turn");
    }

    const fullPrompt = attachedContext ? `${userPrompt}\n\n=== Attached Context ===\n${attachedContext}` : userPrompt;
    this.context.addMessage({ role: "user", content: fullPrompt });

    // Persist user prompt to SessionStore
    await this.sessionStore.saveMessage(this.context.sessionId, {
      role: "user",
      content: redactSecrets(fullPrompt),
    });

    if (this.stateMachine.canTransitionTo("exploring")) {
      this.stateMachine.transitionTo("exploring", "Exploring model tool calls");
    }

    const toolResultsAcc: ToolResult[] = [];
    let assistantText = "";
    let assistantReasoning = "";
    let keepLooping = true;

    while (keepLooping) {
      const limitCheck = this.budgetManager.checkLimits();
      if (limitCheck.isExhausted) {
        this.eventBus.emit("session.failed", this.context.sessionId, { reason: limitCheck.reason });
        if (this.stateMachine.canTransitionTo("failed")) {
          this.stateMachine.transitionTo("failed", limitCheck.reason);
        }
        break;
      }

      const modelRateLimit = await this.budgetManager.checkModelRateLimit();
      if (!modelRateLimit.allowed) {
        const reason =
          `Model rate limit reached (${modelRateLimit.limit} calls/60s). ` +
          `Retry in ${modelRateLimit.resetInSec}s.`;
        this.eventBus.emit("session.failed", this.context.sessionId, { reason });
        if (this.stateMachine.canTransitionTo("failed")) {
          this.stateMachine.transitionTo("failed", reason);
        }
        break;
      }

      this.budgetManager.recordTurn();
      this.eventBus.emit("turn.started", this.context.sessionId, {
        turnNumber: this.budgetManager.getBudgetState().modelTurns,
      });

      assistantText = "";
      assistantReasoning = "";
      const pendingToolCallsMap = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
      let providerMetadata: Message["provider_metadata"];

      // Prepare tools allowed for active mode
      const allTools = this.registry.list();
      const allowedNames = new Set(filterToolsForMode(allTools, this.context.activeMode).map((t) => t.name));
      const activeTools = allTools
        .filter((t) => allowedNames.has(t.name))
        .map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

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
          maxTokens: this.context.maxTokens,
          thinkingBudget: this.budgetManager.getEffortProfile().thinkingBudgetTokens,
          allowUnauthenticated: this.context.allowUnauthenticated,
          allowLocalEndpoint: this.context.allowLocalEndpoint,
          customCapabilities: this.context.customCapabilities,
        }, this.context.signal);

        for await (const event of stream) {
          if (event.type === "text_delta") {
            const safeText = redactSecrets(event.text);
            assistantText += safeText;
            this.eventBus.emit("model.text_delta", this.context.sessionId, { text: safeText });
          } else if (event.type === "thought_delta") {
            const safeThought = redactSecrets(event.thought);
            assistantReasoning += safeThought;
            this.eventBus.emit("model.thought_delta", this.context.sessionId, { thought: safeThought });
          } else if (event.type === "tool_call") {
            if (!pendingToolCallsMap.has(event.id)) {
              pendingToolCallsMap.set(event.id, { id: event.id, name: event.name, args: event.args });
            }
          } else if (event.type === "done") {
            this.budgetManager.recordUsage(event.usage);
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

        const pendingToolCalls = Array.from(pendingToolCallsMap.values());

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

        // Execute tool calls if any
        if (pendingToolCalls.length > 0) {
          if (this.stateMachine.canTransitionTo("implementing")) {
            this.stateMachine.transitionTo("implementing", "Executing proposed tool calls");
          }

          for (const tc of pendingToolCalls) {
            tc.args = safeParseJsonArgs(tc.args);
            const toolDef = this.registry.get(tc.name);
            const permissionLevel = toolDef?.permissionLevel || "readonly";

            this.eventBus.emit("tool.proposed", this.context.sessionId, {
              toolCallId: tc.id,
              toolName: tc.name,
              permissionLevel,
              args: tc.args,
            });

            // Approval check
            const approved = await this.approvalProvider.requestApproval({
              toolCallId: tc.id,
              toolName: tc.name,
              permissionLevel,
              args: tc.args,
            });

            if (approved) {
              this.eventBus.emit("tool.approved", this.context.sessionId, { toolCallId: tc.id, toolName: tc.name });
              this.eventBus.emit("tool.started", this.context.sessionId, { toolCallId: tc.id, toolName: tc.name });

              const result = await this.gateway.executeGuarded(
                this.registry,
                tc as ToolCall,
                { activeMode: this.context.activeMode, sessionId: this.context.sessionId },
                this.context.signal
              );

              this.budgetManager.recordToolCall(permissionLevel);
              toolResultsAcc.push(result);

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

              this.context.addMessage({
                role: "tool",
                content: redactSecrets(result.output),
                tool_call_id: tc.id,
              });

              // Persist tool message response to SessionStore
              await this.sessionStore.saveMessage(this.context.sessionId, {
                role: "tool",
                content: redactSecrets(result.output),
                toolCallId: tc.id,
              });
            } else {
              const deniedMsg = "Tool execution was denied by approval policy or user.";
              this.context.addMessage({
                role: "tool",
                content: deniedMsg,
                tool_call_id: tc.id,
              });
              await this.sessionStore.saveMessage(this.context.sessionId, {
                role: "tool",
                content: deniedMsg,
                toolCallId: tc.id,
              });
            }
          }
        } else {
          keepLooping = false;
        }

      } catch (err: any) {
        this.context.ensureHistoryIntegrity();
        this.eventBus.emit("turn.failed", this.context.sessionId, {
          error: redactSecrets(err?.message || String(err)),
        });
        keepLooping = false;
      }
    }

    if (this.stateMachine.canTransitionTo("verifying")) {
      this.stateMachine.transitionTo("verifying", "Turn verification");
    }

    const isCompleted = this.stateMachine.canTransitionTo("completed");
    if (isCompleted) {
      this.stateMachine.transitionTo("completed", "Turn execution finished");
    }

    return {
      sessionId: this.context.sessionId,
      finalText: assistantText,
      finalReasoning: assistantReasoning,
      state: this.stateMachine.state,
      toolResults: toolResultsAcc,
      budgetState: this.budgetManager.getBudgetState(),
      isCompleted,
    };
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

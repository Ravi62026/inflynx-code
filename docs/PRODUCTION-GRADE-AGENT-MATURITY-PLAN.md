# Inflynx Code — Production-Grade Agent Maturity Plan

> **Status**: Approved Architecture & Implementation Roadmap  
> **Date**: 2026-08-11  
> **Scope**: mature the current Inflynx monorepo CLI, TUI, Desktop, and Server agents toward a production-grade, evidence-first, deterministic coding runtime inspired by Claude Code and Codex workflows.  
> **Non-goal**: Pretend that LLM intuition alone can replace deterministic verification, or claim that an agent can detect production bugs without evidence.

---

## 1. Executive Summary

Inflynx Code currently possesses a functional, high-velocity monorepo foundation:

- **CLI Agent (`apps/cli`)**: Full streaming agentic loop with provider selection (DeepSeek, Gemini, OpenRouter, OpenAI, Anthropic), surgical code patching, inline diff previews, `@mention` context resolution, skill auto-matching, and interactive slash commands (`/mode`, `/plan`, `/execute-plan`, `/debug`, `/graph`, `/mcp`, `/skills`).
- **Ink TUI (`apps/tui`)**: Interactive React/Ink dashboard featuring header HUD telemetry, tool execution logs, markdown rendering, and tabbed workspace file drawer.
- **Surgical Patch Engine (`@inflynx/patch-engine`)**: Exact and whitespace-tolerant snippet targeting, line-by-line unified diff generator, and two-phase atomic multi-file edit transaction manager with SHA256 checksum verification.
- **Workspace Intelligence (`@inflynx/workspace-runtime`)**: BM25-like file relevance ranking, `.gitignore`-aware file indexer, `@mention` resolver, and Mermaid/SVG/HTML architecture mind-map generator (`GraphEngine`).
- **Extensible Integrations**: Stdio/SSE Model Context Protocol (`@inflynx/mcp-runtime`) auto-discovery and SKILL.md YAML frontmatter discovery engine (`@inflynx/skill-runtime`).

However, the codebase currently operates primarily as an **uncoupled tool/model loop embedded inside individual applications**. Production-grade maturity requires a **centralized, stateful orchestration runtime** that enforces policy in code, collects empirical evidence before reporting findings, tracks strict token and wall-clock budgets, executes verification gates after every mutation, and unifies CLI, TUI, Desktop, and Web applications over a single event bus.

---

## 2. Core Product & Safety Principles

### 2.1 Evidence Before Confidence

The agent must **never** report a critical bug, security vulnerability, or successful patch based solely on model intuition. Every finding and completion report must contain concrete, reproducible evidence:

```text
Finding Claim ──► Evidence Requirement
─────────────────────────────────────────────────────────────────────────────
Bug / Defect     ──► Reproducible command/test OR stack trace OR exact line range
Patch Success    ──► Passing typecheck/build OR passing unit test stdout
Security Risk    ──► Deterministic input/output payload mismatch OR call-path trace
Data Loss / Race ──► Verification failure log OR transactional atomic assertion
```

Any finding or claim lacking empirical verification must be explicitly flagged with `confidence < 0.70` and categorized as a **Hypothesis**.

### 2.2 Model Instructions Are Not Security Boundaries

Prompts guide model behavior, but system security and boundary limits must be **enforced strictly in code**. Every tool invocation—regardless of origin (model, slash command, MCP, or plugin)—must pass through centralized policy validation checking:

1. **Canonical Path Guard**: Symlink-safe workspace boundary enforcement via `fs.realpathSync`.
2. **Command Policy**: Shell execution restricted to validated argument arrays (eliminating shell injection hazards).
3. **Permission Profiles**: `read-only`, `workspace-write`, and `full-access` execution scoping.
4. **Output Limits**: Truncation and streaming controls preventing memory exhaustion.

### 2.3 Separate Thinking Effort from Execution Profile

User-configured reasoning effort must control two distinct runtime dimensions:

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ ThinkingConfig (Model Gateway)                                           │
│ Controls provider-level reasoning tokens (e.g. Anthropic thinking budget, │
│ DeepSeek R1 reasoning_content). Evaluated per model request turn.         │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ EffortProfile (Agent Core Orchestrator)                                   │
│ Controls total model turns, tool call depth, retry attempts,              │
│ verification depth, exploration scope, and wall-clock timeout.            │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ BudgetState (Runtime Counters)                                            │
│ Enforces deterministic hard-stop thresholds for prompt tokens, completion │
│ tokens, reasoning tokens, tool executions, wall-clock time, and cost.     │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Minimal, Reversible, Transactional Mutations

Code modifications must be **patch-first, diff-visible, transaction-aware, and rollback-capable**. The system must never overwrite concurrent user edits or leave a workspace in a partially mutated state upon failure.

### 2.5 Verification Is a Gate, Not a Suggestion

A patch application does not constitute task completion. Task completion requires passing through a stateful verification pipeline:

$$\text{Patch Applied} \longrightarrow \text{Focused Verification} \longrightarrow \text{Package Verification} \longrightarrow \text{Repository Gate} \longrightarrow \text{Completion Report}$$

### 2.6 Safe Stop & Graceful Recovery

When confidence is low, budgets are exhausted, policy denies an action, or verification fails repeatedly, the agent must **stop safely**, output an actionable diagnostic report, and offer a clear recovery path rather than continuing blindly.

---

## 3. Comprehensive Codebase Audit & Gap Analysis

A comprehensive line-by-line audit of all 14 packages and 4 applications in the repository reveals the current operational baseline and exact maturity gaps:

### 3.1 Package & Application Audit Summary

| Package / App | Path | Current Line Count | Primary Function | Production Maturity State | Key Gaps to Resolve |
|---|---|---:|---|---|---|
| `apps/cli` | `apps/cli/src/index.ts` | 921 | CLI Agent REPL & Slash Commands | **Functional Prototype** | Owns its own `while(true)` loop; history & budget tracking not centralized. |
| `apps/tui` | `apps/tui/src/index.tsx` | 315 | Ink Terminal Dashboard | **Functional Prototype** | Duplicates agent loop (`handleSubmit`); lacks `/mode`, `/debug`, `/plan`, `@mentions`. |
| `apps/desktop` | `apps/desktop/src` | - | Electron Desktop Shell | **Skeleton** | Missing core orchestrator bridge & IPC event wiring. |
| `apps/server` | `apps/server/src` | - | Local Agent WebSocket Server | **Skeleton** | Missing WebSocket protocol adapter for `PublicAgentEvent`. |
| `@inflynx/agent-core` | `packages/agent-core` | 313 | Mode Configs, Graph, Plan, Debug | **Partial Engines** | **Missing `AgentOrchestrator`, `StateMachine`, `BudgetManager`, `ExecutionContext`.** |
| `@inflynx/policy-engine` | `packages/policy-engine` | 19 | Workspace Boundary Guard | **High Hazard** | `startsWith` check is not symlink-safe; missing centralized tool gateway. |
| `@inflynx/tool-runtime` | `packages/tool-runtime` | 622 | Core Tools & Registry | **Functional Baseline** | Regex shell blacklist bypassable; `search_files` shell string interpolation risk; no DAG. |
| `@inflynx/patch-engine` | `packages/patch-engine` | 370 | Surgical Patching & Diffing | **Production Ready** | 2-phase atomic commit implemented; lacks AST operations and target staleness hash. |
| `@inflynx/model-gateway` | `packages/model-gateway` | 335 | Anthropic & OpenAI Streaming | **Functional Baseline** | **Returns 0 usage tokens in streams;** missing native Gemini thinking adapter. |
| `@inflynx/workspace-runtime` | `packages/workspace-runtime` | 486 | Indexer, BM25 Ranker, MindMap | **Production Ready** | Missing incremental FS watcher (`chokidar`) and symbol call-graph query engine. |
| `@inflynx/session-store` | `packages/session-store` | 21 | Persistence Interfaces | **Interface Only** | Missing concrete SQLite session database and turn persistence. |
| `@inflynx/protocol` | `packages/protocol` | 28 | Agent Event Schemas | **Interface Only** | Missing runtime event bus and event validator. |
| `@inflynx/telemetry` | `packages/telemetry` | 10 | Console Logger | **Stub** | `logEvent` only calls `console.log`; missing secret redaction and metrics aggregator. |
| `@inflynx/mcp-runtime` | `packages/mcp-runtime` | 302 | Stdio/SSE MCP Connectors | **Production Ready** | Stdio JSON-RPC fully functional; SSE transport is currently a mock probe. |
| `@inflynx/skill-runtime` | `packages/skill-runtime` | 244 | SKILL.md Frontmatter Engine | **Production Ready** | Fully functional discovery, frontmatter parser, and prompt matcher. |
| `@inflynx/config` | `packages/config` | 271 | Env, MCP & Provider Configs | **Production Ready** | Monorepo root finder, env loader, and provider specs operational. |
| `tests/` | `tests/` | 0 | Unit, Security & Integration Suites | **Empty** | Directory structures exist (`unit/`, `security/`, `evals/`) but **0 test files exist**. |

---

### 3.2 CLI vs. TUI Architectural Divergence

Currently, `apps/cli` and `apps/tui` re-implement the model-tool interaction loop independently:

```text
CLI Execution Loop (apps/cli/src/index.ts):
User Prompt ──► Parse Mentions ──► Match Skills ──► LLM Stream ──► Tool Approval HUD ──► executeTool() ──► Error Recover Stub ──► Repeat

TUI Execution Loop (apps/tui/src/index.tsx):
User Prompt ──► State Update ──► LLM Stream ──► executeTool() ──► Hardcoded Token Math ──► Repeat (Max 8)
```

**Consequences of Divergence**:
1. **Feature Asymmetry**: Slash commands (`/mode`, `/debug`, `/plan`, `/execute-plan`, `/graph`, `/mcp`, `/skills`), `@mention` resolution, and skill injection work in the CLI but are completely missing in the TUI.
2. **Inconsistent Error Handling**: The CLI includes deep-level recovery stubs for unresponded `tool_call_id`s to prevent DeepSeek/OpenAI API 400 crashes; the TUI lacks this recovery logic.
3. **Telemetric Inconsistency**: The TUI estimates token count using a crude heuristic `(input + output) / 4`, whereas the CLI does not track token costs.

---

### 3.3 Known Implementation Hazards to Resolve Immediately

1. **Symlink Escape in `validateWorkspaceBoundary` (`@inflynx/policy-engine`)**:
   ```ts
   // CURRENT INSECURE IMPLEMENTATION (Line 16):
   export function validateWorkspaceBoundary(targetPath: string, workspaceRoot: string): boolean {
     return targetPath.startsWith(workspaceRoot) && !targetPath.includes("..");
   }
   ```
   *Hazard*: Path string comparison does not resolve symlinks via `fs.realpathSync`. A symlink inside the workspace pointing to `/etc/passwd` or `~/.ssh` evaluates as valid because its virtual path starts with `workspaceRoot`.

2. **Shell Command Interpolation Injection (`@inflynx/tool-runtime`)**:
   ```ts
   // CURRENT INSECURE IMPLEMENTATION (Line 322 in search_files):
   const rgArgs = [ ... `"${pattern}"`, `"${absPath}"` ].join(" ");
   ```
   *Hazard*: Interpolating untrusted string arguments into shell command strings enables command injection if `pattern` contains quotes, backticks, or subshell directives (e.g. `pattern = 'foo" $(rm -rf /) "'`).

3. **Zero Token Telemetry Bug (`@inflynx/model-gateway`)**:
   ```ts
   // CURRENT BUG (Line 124 in streamAnthropic & Line 282 in streamOpenAiCompatible):
   yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
   ```
   *Hazard*: Stream completion events return zero tokens, rendering cost tracking and token budget enforcement non-functional.

---

## 4. Target Architecture & Shared Core Event Bus

```text
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    apps/cli     │    │    apps/tui     │    │  apps/desktop   │    │   apps/server   │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │                      │
         └──────────────────────┴──────────┬───────────┴──────────────────────┘
                                           │  Subscribes to PublicAgentEvent Stream
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                  @inflynx/agent-core                                  │
│                                                                                        │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │   TaskClassifier      │  │     PlanEngine        │  │     AgentOrchestrator      │  │
│  └───────────────────────┘  └───────────────────────┘  └─────────────┬──────────────┘  │
│  ┌───────────────────────┐  ┌───────────────────────┐                │                 │
│  │   ContextManager      │  │   VerificationEngine  │  ┌─────────────▼────────────┐  │
│  └───────────────────────┘  └───────────────────────┘  │    AgentStateMachine       │  │
│  ┌───────────────────────┐  ┌───────────────────────┐  └─────────────┬──────────────┘  │
│  │     BudgetManager     │  │     RepairLoop        │                │                 │
│  └───────────────────────┘  └───────────────────────┘                │                 │
└──────────────────────────────────────────┬───────────────────────────┼─────────────────┘
                                           │                           │
                   ┌───────────────────────┴───────────────┐           │ Emits Events
                   ▼                                       ▼           ▼
┌──────────────────────────────────────┐     ┌───────────────────────────────────────────┐
│        @inflynx/model-gateway        │     │          @inflynx/protocol            │
│  (Anthropic, DeepSeek, Gemini, etc.) │     │   (Typed Public Event Bus System)         │
└──────────────────────────────────────┘     └─────────────────────┬─────────────────────┘
                                                                   │
                                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Security & Storage                                   │
│  ┌───────────────────────────┐ ┌───────────────────────────┐ ┌──────────────────────┐  │
│  │  @inflynx/policy-engine   │ │  @inflynx/tool-runtime    │ │@inflynx/session-store│  │
│  │ (CanonicalPathGuard)      │ │(ToolExecutionGateway)     │ │   (SQLite Driver)    │  │
│  └───────────────────────────┘ └───────────────────────────┘ └──────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Typed Event Protocol Contract (`@inflynx/protocol`)

All frontends are thin presentation layers that subscribe to `PublicAgentEvent` emissions:

```ts
export type AgentEventType =
  | "session.started"          // Session initialized with CWD & config
  | "state.changed"            // State machine state transition
  | "plan.created"             // Structured plan generated
  | "plan.step_updated"        // Individual step status change
  | "model.turn_started"       // Model request loop turn initiated
  | "model.thought_delta"      // Reasoning stream chunk (DeepSeek R1 / Anthropic thinking)
  | "model.text_delta"         // Text response stream chunk
  | "tool.proposed"            // Model proposed tool call
  | "tool.approved"            // User or auto-approval granted
  | "tool.started"             // Execution started
  | "tool.output"              // Execution finished with output snippet
  | "verification.started"     // Verification suite triggered
  | "verification.finished"    // Verification completed (pass/fail status)
  | "repair.attempted"         // Bounded repair loop triggered
  | "finding.created"          // Critical defect or review finding recorded
  | "budget.warning"           // Budget counter reached warning threshold (70%, 85%)
  | "session.completed"        // Task finished successfully
  | "session.failed";          // Task stopped due to error/budget limit

export interface PublicAgentEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: AgentEventType;
  sessionId: string;
  timestamp: number;
  payload: TPayload;
}
```

---

## 5. Centralized Policy Gateway & Hardened Security Architecture

### 5.1 Symlink-Safe Canonical Path Guard (`@inflynx/policy-engine`)

Replace string-prefix validation with canonical path resolution capable of handling existing files, new files, and symlinks:

```ts
import fs from "fs";
import path from "path";

export class CanonicalPathGuard {
  private canonicalWorkspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.canonicalWorkspaceRoot = fs.realpathSync(path.resolve(workspaceRoot));
  }

  /**
   * Resolves target path to canonical absolute path and enforces workspace boundary.
   * Throws Error if path escapes workspace via traversal or symlink.
   */
  validateAndResolve(targetPath: string): string {
    const absoluteTarget = path.isAbsolute(targetPath)
      ? path.normalize(targetPath)
      : path.normalize(path.join(this.canonicalWorkspaceRoot, targetPath));

    let canonicalTarget: string;

    if (fs.existsSync(absoluteTarget)) {
      canonicalTarget = fs.realpathSync(absoluteTarget);
    } else {
      // For new files, resolve parent directory realpath
      const parentDir = path.dirname(absoluteTarget);
      if (!fs.existsSync(parentDir)) {
        throw new Error(`Directory does not exist: "${parentDir}"`);
      }
      const canonicalParent = fs.realpathSync(parentDir);
      canonicalTarget = path.join(canonicalParent, path.basename(absoluteTarget));
    }

    // Strict boundary check against canonical workspace root
    if (
      canonicalTarget !== this.canonicalWorkspaceRoot &&
      !canonicalTarget.startsWith(this.canonicalWorkspaceRoot + path.sep)
    ) {
      throw new Error(
        `Security Policy Violation: Path "${targetPath}" resolves to "${canonicalTarget}", ` +
        `which lies outside workspace root "${this.canonicalWorkspaceRoot}".`
      );
    }

    return canonicalTarget;
  }
}
```

### 5.2 Command Execution Policy & Anti-Injection Engine (`@inflynx/policy-engine`)

Replace command string concatenation with argument array execution:

```ts
import { execFile } from "child_process";

export interface ValidatedCommand {
  executable: string;
  args: string[];
}

export class CommandPolicy {
  private static DANGEROUS_PATTERNS = [
    /rm\s+-rf\s+[\/\~]/,
    /sudo/,
    /mkfs/,
    /dd\s+if=/,
    /: >/,
    />\s*\/dev\/sd/,
  ];

  static validateShellCommand(commandString: string): void {
    for (const pattern of this.DANGEROUS_PATTERNS) {
      if (pattern.test(commandString)) {
        throw new Error(`Command blocked by security policy: Matches pattern ${pattern}`);
      }
    }
  }

  /**
   * Safely executes process without shell string interpolation using argument arrays.
   */
  static async execProcessDirect(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(executable, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
        }
      });

      signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        reject(new Error("Process execution aborted by user signal."));
      });
    });
  }
}
```

### 5.3 Centralized Tool Execution Gateway (`@inflynx/tool-runtime`)

All tool executions must route through `ToolExecutionGateway`:

```ts
export class ToolExecutionGateway {
  constructor(
    private pathGuard: CanonicalPathGuard,
    private modeConfig: ModeConfig,
    private eventBus: (event: PublicAgentEvent) => void
  ) {}

  async executeGuardedTool(
    tool: ToolDefinition,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    // 1. Centralized Mode Permission Check
    if (tool.permissionLevel === "shell" && !this.modeConfig.allowShell) {
      throw new Error(`Tool "${tool.name}" requires shell permission, which is disabled in [${this.modeConfig.mode}] mode.`);
    }

    if (tool.isMutating && !this.modeConfig.allowMutating) {
      throw new Error(`Tool "${tool.name}" is mutating, which is disabled in [${this.modeConfig.mode}] mode.`);
    }

    // 2. Path Boundary Validation for Filesystem Tools
    if (typeof rawArgs.path === "string") {
      rawArgs.path = this.pathGuard.validateAndResolve(rawArgs.path);
    }

    // 3. Execution with Timeout & Abort Signal
    const startMs = Date.now();
    const result = await tool.execute(rawArgs, signal);
    const durationMs = Date.now() - startMs;

    return {
      toolCallId: (rawArgs._id as string) || "call",
      toolName: tool.name,
      output: result,
      durationMs,
    };
  }
}
```

---

## 6. Shared Agent Orchestrator & Enforced State Machine

### 6.1 State Machine Transition Matrix (`@inflynx/agent-core`)

The agent runtime must enforce a deterministic state machine:

```text
                       ┌────────────────────────────────────────────────────────┐
                       ▼                                                        │
┌──────┐      ┌─────────────────┐      ┌──────────────┐      ┌───────────────┐  │
│ idle │ ────►│   classifying   │ ────►│   planning   │ ────►│   exploring   │──┘
└──────┘      └─────────────────┘      └──────────────┘      └───────┬───────┘
                                                                     │
┌──────────────┐      ┌───────────────┐      ┌──────────────┐        │
│  completed   │ ◄────│   reviewing   │ ◄────│  verifying   │ ◄──────┤
└──────────────┘      └───────┬───────┘      └───────▲──────┘        │
                              │                      │               ▼
                      ┌───────▼───────┐      ┌───────┴──────┐┌───────────────┐
                      │  repairing    │ ────►│ implementing ││ hypothesizing │
                      └───────────────┘      └──────────────┘└───────────────┘
```

```ts
export type AgentState =
  | "idle"                  // Initial state
  | "classifying"           // Task classification & strategy selection
  | "planning"              // Structured plan generation
  | "exploring"             // Codebase research & symbol navigation
  | "hypothesizing"         // Debug hypothesis formation
  | "implementing"          // Code mutation via patch_file / write_file
  | "verifying"             // Verification gate execution (typecheck, tests)
  | "repairing"             // Bounded failure recovery loop
  | "reviewing"             // Final report generation & finding synthesis
  | "waiting_for_approval"  // Paused for user approval
  | "completed"             // Task completed successfully with verification
  | "failed"                // Hard stop due to budget or fatal error
  | "cancelled";            // Aborted by user signal

export const LEGAL_STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["classifying"],
  classifying: ["planning", "exploring", "failed"],
  planning: ["exploring", "waiting_for_approval", "implementing", "failed"],
  exploring: ["planning", "hypothesizing", "implementing", "failed"],
  hypothesizing: ["exploring", "implementing", "verifying", "failed"],
  implementing: ["verifying", "failed"],
  verifying: ["reviewing", "repairing", "completed", "failed"],
  repairing: ["implementing", "verifying", "failed"],
  reviewing: ["completed", "failed"],
  waiting_for_approval: ["implementing", "cancelled", "planning"],
  completed: ["idle"],
  failed: ["idle"],
  cancelled: ["idle"],
};
```

### 6.2 Effort Profiles & `BudgetManager` (`@inflynx/agent-core`)

```ts
export type EffortLevel = "low" | "medium" | "high";

export interface EffortProfile {
  level: EffortLevel;
  thinkingBudgetTokens: number;      // Per-request model reasoning budget
  maxModelTurns: number;             // Hard turn limit
  maxToolCalls: number;              // Total tool call budget
  maxRetries: number;                // Max tool/build repair attempts
  maxVerificationRuns: number;       // Max verification iterations
  maxWallClockMs: number;            // Total wall-clock time limit
  maxTotalReasoningTokens: number;   // Aggregate task reasoning limit
  verificationDepth: "basic" | "standard" | "deep";
  runFullRegressionSuite: boolean;
}

export const DEFAULT_EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  low: {
    level: "low",
    thinkingBudgetTokens: 1024,
    maxModelTurns: 5,
    maxToolCalls: 10,
    maxRetries: 1,
    maxVerificationRuns: 2,
    maxWallClockMs: 2 * 60 * 1000,   // 2 minutes
    maxTotalReasoningTokens: 8192,
    verificationDepth: "basic",
    runFullRegressionSuite: false,
  },
  medium: {
    level: "medium",
    thinkingBudgetTokens: 4096,
    maxModelTurns: 15,
    maxToolCalls: 30,
    maxRetries: 3,
    maxVerificationRuns: 5,
    maxWallClockMs: 8 * 60 * 1000,   // 8 minutes
    maxTotalReasoningTokens: 32768,
    verificationDepth: "standard",
    runFullRegressionSuite: true,
  },
  high: {
    level: "high",
    thinkingBudgetTokens: 8192,
    maxModelTurns: 30,
    maxToolCalls: 75,
    maxRetries: 5,
    maxVerificationRuns: 10,
    maxWallClockMs: 20 * 60 * 1000,  // 20 minutes
    maxTotalReasoningTokens: 131072,
    verificationDepth: "deep",
    runFullRegressionSuite: true,
  },
};
```

---

## 7. Context Manager & Structured Planning Engine

### 7.1 Task Classifier & Execution Strategy

```ts
export type TaskCategory =
  | "question"          // Read-only query / explanation
  | "implementation"    // New feature or refactor
  | "bug_fix"           // Targeted defect repair
  | "security_audit"    // Code vulnerability assessment
  | "performance";      // Optimization & benchmark task

export interface TaskClassification {
  category: TaskCategory;
  recommendedMode: AgentMode;
  recommendedEffort: EffortLevel;
  targetComponents: string[];
  requiredVerification: string[];
}
```

### 7.2 Structured Plan Schema vs. Human Markdown Projection

Plans exist as structured JSON objects in memory and persist as both `.inflynx/plan.json` and human-readable `.inflynx/PLAN.md`:

```ts
export interface StructuredPlanStep {
  id: number;
  title: string;
  description: string;
  targetFiles: string[];
  verificationCommand?: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  dependencies: number[];
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  outputEvidence?: string;
}

export interface StructuredPlan {
  id: string;
  goal: string;
  category: TaskCategory;
  steps: StructuredPlanStep[];
  createdTimestamp: number;
  status: "draft" | "approved" | "executing" | "completed" | "failed";
}
```

---

## 8. Verification Engine & Failure-Driven Repair Loop

### 8.1 Automated Project Check Registry (`@inflynx/agent-core`)

The `VerificationEngine` inspects workspace metadata and automatically configures relevant check commands:

```ts
export interface VerificationCheck {
  id: string;
  name: string;
  type: "typecheck" | "test" | "lint" | "build" | "custom";
  command: string;
  args: string[];
  timeoutMs: number;
  isGate: boolean; // Must pass before completing task
}

export interface VerificationResult {
  checkId: string;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsedErrors: DiagnosticError[];
}

export interface DiagnosticError {
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  severity: "error" | "warning";
}
```

### 8.2 Anti-Pattern Rules in Bounded Repair Loop

When verification fails, the orchestrator triggers `RepairLoop`. The repair engine strictly rejects fake fixes:

```text
Anti-Pattern Rejection Guard:
1. Rejects deletion or commenting out of failing test cases.
2. Rejects adding @ts-ignore or eslint-disable without explicit user authorization.
3. Rejects swallowing errors with empty catch blocks.
4. Rejects modifying assertion expected values to match buggy output.
```

If a patch fails verification after `maxRetries` attempts, the orchestrator automatically rolls back staged changes and yields control to the user.

---

## 9. Evidence-First Debugging & Critical Bug Detection

### 9.1 Evidence-Backed Bug Finding Schema (`BugFinding`)

```ts
export interface BugFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "correctness"
    | "security"
    | "data_integrity"
    | "race_condition"
    | "performance"
    | "reliability";
  title: string;
  targetFile: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: {
    reproductionCommand?: string;
    stackTrace?: string;
    codeSnippet?: string;
    verifiedDataFlow?: string;
  };
  impact: string;
  rootCause: string;
  confidenceScore: number; // Must be >= 0.70 to mark as defect; else hypothesis
  verificationStatus: "hypothesis" | "reproduced" | "fixed" | "unverified";
  suggestedFix?: string;
}
```

Findings are synthesized directly into `.inflynx/DEBUG_REPORT.md` following a standardized CodeRabbit-style markdown template.

---

## 10. Real Token Telemetry & Provider Usage Extraction

### 10.1 Fixing Token Extraction in `@inflynx/model-gateway`

Update stream readers to extract real token metrics:

```ts
// 1. Anthropic Usage Extractor (v1/messages):
if (parsed.type === "message_start") {
  accumulatedUsage.promptTokens = parsed.message.usage.input_tokens;
} else if (parsed.type === "message_delta") {
  accumulatedUsage.completionTokens = parsed.usage.output_tokens;
}

// 2. OpenAI / DeepSeek Usage Extractor (chat/completions):
// Pass stream_options: { include_usage: true } in body
if (parsed.usage) {
  accumulatedUsage.promptTokens = parsed.usage.prompt_tokens;
  accumulatedUsage.completionTokens = parsed.usage.completion_tokens;
  accumulatedUsage.reasoningTokens = parsed.usage.completion_tokens_details?.reasoning_tokens || 0;
}
```

---

## 11. Desktop, Server & Web Application Architecture

```text
           ┌──────────────────────────────────────────────────────────┐
           │                      fe/ (Vite React Web UI)             │
           └────────────────────────────┬─────────────────────────────┘
                                        │ WebSocket JSON-RPC Connection
                                        ▼
           ┌──────────────────────────────────────────────────────────┐
           │                  apps/server (Node/Fastify)              │
           └────────────────────────────┬─────────────────────────────┘
                                        │ IPC / Process Stream
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                  @inflynx/agent-core                                  │
│                (Shared Event Bus & AgentOrchestrator Instance)                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

The React Web application (`fe/`) and Desktop app (`apps/desktop`) consume the identical event stream emitted by `@inflynx/agent-core`, ensuring 100% feature parity between CLI, TUI, Desktop, and Web frontends.

---

## 12. Concrete Test Suite & Evaluation Corpus Specification

Establish a comprehensive test suite in `tests/` using **Vitest**:

```text
tests/
├── unit/
│   ├── policy-engine/
│   │   ├── path-guard.test.ts          # Symlink escape & boundary tests
│   │   └── command-policy.test.ts       # Shell injection prevention tests
│   ├── patch-engine/
│   │   ├── surgical-patch.test.ts       # Substring & line-trimmed patch tests
│   │   └── atomic-transaction.test.ts   # 2-phase commit & rollback tests
│   └── agent-core/
│       ├── state-machine.test.ts        # State transition legality tests
│       └── budget-manager.test.ts       # Hard-stop limit enforcement tests
├── security/
│   ├── path-traversal.test.ts           # Traversal attack payload fixtures
│   └── shell-injection.test.ts          # Command substitution attack fixtures
├── integration/
│   ├── orchestrator-loop.test.ts        # Full loop test with mocked model gateway
│   └── verification-repair.test.ts      # Automated build failure repair tests
└── evals/
    ├── corpus/
    │   ├── repo-null-deref/             # Known defect fixture repository
    │   ├── repo-cmd-injection/          # Vulnerability fixture repository
    │   └── repo-race-condition/         # Concurrency defect repository
    └── bug-finding-eval.test.ts         # Detection, reproduction, & fix evaluation
```

---

## 13. Recommended Implementation Roadmap & 8-Phase Priority Matrix

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ P0 (Critical Foundation & Safety)                                                │
│   Phase 1: Security Policy & Tool Execution Gateway                              │
│   Phase 2: Real Token Telemetry & Model Gateway Usage                            │
│   Phase 3: Shared Core Orchestrator, State Machine & Event Bus                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ P1 (Verification, Quality & Intelligence)                                        │
│   Phase 4: Verification Engine & Bounded Repair Loop                             │
│   Phase 5: Evidence-First Debugging & Finding Engine                             │
│   Phase 6: Context Manager & Structured Planning Engine                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ P2 (Persistence, Testing & Multi-App Scale)                                      │
│   Phase 7: Test Suite & Security Evaluation Corpus                               │
│   Phase 8: SQLite Session Persistence & Monorepo App Bridge (Server/Desktop/Web)  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Phase Summary & Deliverables

- **Phase 1 [P0] — Security Policy & Tool Execution Gateway**:
  `CanonicalPathGuard` (`fs.realpathSync`), `CommandPolicy` (argument arrays), and `ToolExecutionGateway` in `@inflynx/tool-runtime`.
- **Phase 2 [P0] — Real Token Telemetry & Model Gateway Usage**:
  Extract prompt, completion, and DeepSeek/Anthropic reasoning tokens in `@inflynx/model-gateway`. Real-time cost estimation.
- **Phase 3 [P0] — Shared Core Orchestrator & State Machine**:
  `AgentOrchestrator`, `StateMachine`, `BudgetManager`, `ExecutionContext`, and typed `PublicAgentEvent` bus. Unify CLI and TUI.
- **Phase 4 [P1] — Verification Engine & Bounded Repair Loop**:
  Automated build/test checks, failure parser diagnostics, and repair loop anti-pattern guards.
- **Phase 5 [P1] — Evidence-First Debugging & Finding Engine**:
  `BugFinding` schema with mandatory reproduction evidence and `.inflynx/DEBUG_REPORT.md` synthesis.
- **Phase 6 [P1] — Context Selection & Structured Planning Engine**:
  `TaskClassifier`, BM25 + recency context compactor, and dependency-aware plan steps.
- **Phase 7 [P2] — Test Suite & Security Evaluation Corpus**:
  Vitest test runner setup, package unit tests, security attack payload fixtures, and bug-finding benchmark repos.
- **Phase 8A [P2] — Relational Database Store (SQLite + PostgreSQL Dual Adapter)**:
  SQLite embedded driver (`SqliteSessionStore`) for offline CLI/TUI and PostgreSQL driver (`PostgresSessionStore`) for `apps/server` multi-tenant server deployments. Stores sessions, turns, messages, tool execution logs, bug findings, and token telemetry.
- **Phase 8B [P2] — Vector DB & Semantic Code Search Engine (`@inflynx/vector-store`)**:
  Embedded `HnswVectorStore` (local) and `PgVectorStore` (PostgreSQL) for semantic code search, AST chunk indexing, and episodic agent memory.
- **Phase 8C [P2] — Monorepo Multi-App WebSocket Server & Desktop Shell Bridge**:
  Fastify WebSocket JSON-RPC server in `apps/server` broadcasting `@inflynx/protocol` events to `apps/desktop` and Vite React Web frontend (`fe/`).

---

## 14. Definition of Done for Production-Grade Maturity v1.0

The Inflynx Agent runtime achieves Production-Grade Maturity v1.0 when:

1. Both `apps/cli` and `apps/tui` run over the single `AgentOrchestrator` in `@inflynx/agent-core`.
2. Every tool invocation passes through code-enforced canonical path guards and command policies.
3. Every prompt, completion, and reasoning token is tracked accurately with real cost metrics.
4. Complex multi-file tasks generate a structured plan and execute via two-phase atomic transactions.
5. All code modifications undergo automated verification gates before completion reporting.
6. Bug findings contain mandatory empirical evidence (reproduction commands, logs, line ranges).
7. The monorepo test suite in `tests/` passes with 100% green status in CI.

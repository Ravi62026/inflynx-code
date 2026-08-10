# Inflynx Code — Production-Grade Agent Maturity Plan

> Status: Proposed implementation roadmap  
> Date: 2026-08-10  
> Scope: Mature the current CLI/TUI agent toward a reliable, evidence-first coding agent inspired by Claude Code and Codex workflows.  
> Non-goal: Claim that the agent can detect every production bug. The system must communicate uncertainty and require evidence for high-severity findings.

---

## 1. Executive Summary

Inflynx currently has a usable foundation:

- A CLI agent loop with streaming model responses and tool calls.
- An Ink-based TUI with a separate streaming/tool loop.
- Provider routing for Anthropic and OpenAI-compatible providers.
- Initial thinking-effort configuration (`low`, `medium`, `high`).
- A tool registry with file, search, web, shell, and edit tools.
- Basic mode filtering (`ask`, `plan`, `agent`, `debug`).
- Surgical patching and temporary-file based file commits.
- Basic workspace indexing, relevance ranking, plans, debug reports, MCP, and skills.

The current implementation is still primarily a model/tool loop. Production-grade maturity requires a centralized orchestration runtime that can:

1. Classify task risk and intent.
2. Build and execute a structured plan.
3. Collect evidence before making claims.
4. Enforce policy independently of model instructions.
5. Track effort, turns, tools, retries, verification, time, and token budgets.
6. Apply minimal reversible changes.
7. Run verification gates after modifications.
8. Recover from provider, tool, build, and test failures.
9. Produce findings with evidence, confidence, impact, and verification status.
10. Persist audit history and learn from repeated failures.

The implementation should be incremental. Safety, orchestration, verification, and observability come before advanced AST indexing or model-cost optimization.

---

## 2. Product Principles

### 2.1 Evidence before confidence

The agent must not present a critical or high-confidence bug finding based only on model intuition. A finding should include one or more of:

- A reproducible command or test.
- A stack trace or runtime log.
- An exact source path and line range.
- A deterministic input/output mismatch.
- A verified data-flow or call-path explanation.
- A security proof-of-concept in a controlled workspace.
- A failing regression test.

Findings without direct evidence must be marked as hypotheses.

### 2.2 Model instructions are not security boundaries

Prompts can guide behavior, but permissions must be enforced in code. Every tool execution must pass through centralized policy checks for:

- Workspace boundary.
- Symlink escape.
- Sandbox profile.
- Read/write/shell permission.
- Network access.
- Confirmation requirements.
- Resource limits.

### 2.3 Thinking effort and execution effort are separate

The user-facing effort selector must control two distinct layers:

```text
ThinkingConfig
  Provider/model-level reasoning controls for one model request.

EffortProfile
  Agent-level turns, tool calls, retries, verification depth, and time budget.

BudgetState
  Runtime counters and hard-stop enforcement for the complete task.
```

Thinking does not happen only once at the start. Each model request may reason again after tool results. Therefore the system must track both per-request reasoning usage and aggregate task usage.

### 2.4 Minimal, reversible changes

Changes should be patch-first, diff-visible, transaction-aware, and rollback-capable. The agent should never silently overwrite unrelated user edits.

### 2.5 Verification is a gate, not a suggestion

A successful patch is not a successful task. Verification must be explicit and stateful:

```text
patch applied → focused verification → package verification → repository verification → review
```

### 2.6 Stop safely

When confidence is low, budgets are exhausted, policy denies an action, or verification remains red, the agent must stop with an actionable report instead of continuing blindly.

---

## 3. Current Baseline and Gaps

### 3.1 Current runtime path

The main CLI path is concentrated in `apps/cli/src/index.ts`:

```text
load environment
  → discover workspace
  → initialize registry/MCP/skills/plans/debug/graph
  → collect user prompt
  → add context and skills
  → stream model response
  → approve and execute tools
  → append tool results
  → repeat until no tool calls
```

The TUI in `apps/tui/src/index.tsx` implements a separate, simpler loop. This duplication will eventually cause behavior differences unless both frontends use the same core orchestrator.

### 3.2 Current maturity gaps

| Area | Current state | Required direction |
|---|---|---|
| Orchestration | Loop embedded in CLI/TUI | Shared `AgentOrchestrator` |
| States | Types and mode filters exist | Enforced state machine and transitions |
| Thinking | Per-request provider mapping | Add task-level effort profiles and aggregate budgets |
| Tool scheduling | Sequential calls | Dependency-aware scheduling with safe read parallelism |
| Verification | Ad hoc shell calls | Structured verification engine and repair loop |
| Debugging | Prompt-driven audit/report | Evidence-backed findings and reproduction workflow |
| Security | Basic blocked shell patterns | Central policy enforcement and sandbox boundary checks |
| Paths | Absolute/relative resolution | Canonical path and symlink-safe workspace guard |
| Editing | Surgical text patch and file transaction | Conflict detection, rollback, AST adapters |
| Workspace intelligence | File index and package graph | Symbol graph, call graph, test mapping, incremental index |
| Sessions | Interface only | Concrete persistence and resume/fork |
| Telemetry | Console JSON logging | Redacted structured events, correlation IDs, metrics |
| Protocol | Event type definitions | Event bus and frontend-neutral runtime events |
| Plugins | Interfaces only | Validated plugin loading and capability sandbox |
| Tests | No visible test suite | Unit, integration, security, fixture, and evaluation suites |

### 3.3 Known implementation hazards to resolve early

- `resolveWorkspacePath()` accepts absolute paths without a centralized boundary check.
- `validateWorkspaceBoundary()` uses string-prefix logic and is not symlink-safe.
- Shell execution relies on command strings and shell semantics.
- The shell blacklist is not a sufficient security policy.
- Search commands interpolate user/model strings into shell command strings.
- Tool permission filtering is performed before execution but not enforced centrally inside `executeTool()`.
- The CLI and TUI duplicate model/tool history handling.
- Provider usage events currently report zero token usage.
- Anthropic native content blocks need robust accumulation and replay handling.
- Provider support is not uniform; unsupported thinking controls must be explicit in UI and telemetry.
- `pnpm build` could not be run in the current environment because `pnpm` was unavailable; CI must become authoritative.

---

## 4. Target Architecture

```text
apps/cli ───────────────┐
                         │
apps/tui ────────────────┼──► @inflynx/agent-core
                         │       │
future server/IDE ──────┘       ├── Task classifier
                                 ├── Plan engine
                                 ├── State machine
                                 ├── Budget manager
                                 ├── Context manager
                                 ├── Tool scheduler
                                 ├── Verification engine
                                 ├── Repair loop
                                 ├── Review/finding engine
                                 └── Event emitter
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
          @inflynx/model-gateway  @inflynx/tool-runtime  @inflynx/session-store
                    │                     │                     │
                    ▼                     ▼                     ▼
             Provider adapters       Policy gateway       SQLite/project history
                                          │
                                          ▼
                                @inflynx/policy-engine
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
      @inflynx/workspace-runtime  @inflynx/patch-engine     @inflynx/protocol
```

### 4.1 Shared core principle

The frontends should render events and collect approvals. They should not own orchestration logic. The core should emit events such as:

- `session.started`
- `state.changed`
- `plan.created`
- `model.started`
- `model.delta`
- `thought.delta`
- `tool.proposed`
- `tool.approved`
- `tool.started`
- `tool.output`
- `verification.started`
- `verification.finished`
- `finding.created`
- `budget.warning`
- `session.completed`
- `session.failed`

---

## 5. Effort Profiles and Budget Model

### 5.1 Configuration model

Create a shared effort profile in `@inflynx/agent-core` or a small shared config module:

```ts
export type EffortLevel = "low" | "medium" | "high";

export interface EffortProfile {
  level: EffortLevel;
  thinkingBudgetTokens: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxRetries: number;
  maxVerificationRuns: number;
  maxWallClockMs: number;
  maxTotalReasoningTokens: number;
  verificationDepth: "basic" | "standard" | "deep";
  explorationDepth: "focused" | "related" | "architecture";
  runFullRegressionSuite: boolean;
  allowParallelReadonlyTools: boolean;
}
```

Recommended initial defaults:

| Setting | Low | Medium | High |
|---|---:|---:|---:|
| Thinking budget/request | 1,024 | 4,096 | 8,192 |
| Max model turns | 3 | 8 | 16 |
| Max tool calls | 8 | 20 | 50 |
| Max retries | 1 | 2 | 3 |
| Max verification runs | 2 | 5 | 10 |
| Max wall-clock time | 60 seconds | 5 minutes | 15 minutes |
| Max total reasoning tokens | 4,096 | 32,768 | 131,072 |
| Exploration | Focused | Related | Architecture |
| Verification | Basic | Standard | Deep |
| Full regression suite | No | Yes | Yes |
| Parallel read-only tools | Yes | Yes | Yes |

These are policy defaults, not provider guarantees. Actual providers may consume fewer or more tokens.

### 5.2 Runtime budget state

```ts
export interface BudgetState {
  level: EffortLevel;
  startedAt: number;
  modelTurns: number;
  toolCalls: number;
  readonlyToolCalls: number;
  mutatingToolCalls: number;
  shellCalls: number;
  retries: number;
  verificationRuns: number;
  reasoningTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}
```

Every counter must be updated by the orchestrator, not by prompts. Hard limits must stop execution deterministically. Warnings should be emitted at 70%, 85%, and 100% of each relevant budget.

### 5.3 Repeated thinking behavior

A task may contain many model turns:

```text
user prompt
  → model reasoning
  → read/search tools
  → model reasoning over evidence
  → patch tool
  → model reasoning over patch result
  → build/test tools
  → model reasoning over failures
  → final answer
```

The UI should show:

- Current effort.
- Current state.
- Model turn number.
- Tool call count.
- Verification count.
- Reasoning-token usage when available.
- Remaining budget.

---

## 6. Phased Implementation Roadmap

## Phase 0 — Baseline, Contracts, and CI

### Goals

Establish a reproducible baseline before changing orchestration behavior.

### Work items

1. Add CI for Windows and Linux at minimum.
2. Install and pin the package manager through documented setup or Corepack.
3. Run `pnpm install`, `pnpm build`, and all available tests in CI.
4. Add strict TypeScript checks for every package.
5. Add a test harness with mocked model streams and temporary workspaces.
6. Add a compatibility matrix for providers and thinking capabilities.
7. Document unsupported providers/features instead of silently pretending support.

### Files/packages

- Root `package.json`
- `pnpm-workspace.yaml`
- New `.github/workflows/ci.yml`
- New `tests/fixtures/`
- Package-level `tsconfig.json` files
- `packages/model-gateway`

### Acceptance criteria

- Clean install works in CI.
- Build failures are visible and reproducible.
- Model streaming can be tested without network/API keys.
- Changed behavior has regression coverage.

---

## Phase 1 — Central Policy and Safe Tool Gateway

### Goals

Make every tool execution pass through enforceable security and resource policy.

### Work items

1. Replace string-prefix path checks with canonical path validation.
2. Resolve and validate real paths using `realpath` where applicable.
3. Reject traversal, workspace escapes, and symlink escapes.
4. Define policy profiles:
   - `read-only`
   - `workspace-write`
   - `full-access`
5. Enforce policy inside `executeTool()` and not only at prompt/tool-list level.
6. Add per-tool capabilities:
   - filesystem read
   - filesystem write
   - shell
   - network
   - external process
7. Replace shell blacklist-only logic with command execution policy.
8. Validate shell working directory through the same path gateway.
9. Add maximum output size and timeout handling.
10. Kill process trees on cancellation, including Windows process handling.
11. Ensure search tools do not interpolate untrusted strings into shell command strings. Prefer direct process arguments or in-process search.
12. Add audit events for denied and approved actions.

### Files/packages

- `packages/policy-engine/src/index.ts`
- `packages/tool-runtime/src/index.ts`
- `packages/patch-engine/src/index.ts`
- New `packages/policy-engine/src/path-guard.ts`
- New `packages/policy-engine/src/command-policy.ts`
- New `packages/tool-runtime/src/ToolExecutionGateway.ts`

### Acceptance criteria

- Attempts to read/write outside workspace are denied.
- Symlink escapes are denied.
- Ask/plan mode restrictions are enforced even if called directly.
- Shell cancellation does not leave child processes running.
- Security tests cover traversal, symlink, injection, SSRF, and output-limit cases.

---

## Phase 2 — Shared Agent Orchestrator and State Machine

### Goals

Move loop control out of the CLI/TUI and into `@inflynx/agent-core`.

### Work items

1. Create `AgentOrchestrator` with dependency injection for:
   - model gateway
   - tool runtime
   - policy gateway
   - workspace index
   - verifier
   - session store
   - event emitter
   - approval provider
2. Implement states:

```text
idle
classifying
planning
exploring
hypothesizing
implementing
verifying
repairing
reviewing
waiting_for_approval
completed
failed
cancelled
```

3. Define legal transitions and transition reasons.
4. Add cancellation through `AbortSignal`.
5. Add state-entry and state-exit events.
6. Enforce effort profile budgets in one place.
7. Add tool-call deduplication and repeated-failure detection.
8. Preserve provider-specific assistant/tool history correctly.
9. Make CLI and TUI thin adapters over the same orchestrator.
10. Add a bounded continuation policy so a model cannot loop indefinitely.

### Suggested files

```text
packages/agent-core/src/orchestrator/AgentOrchestrator.ts
packages/agent-core/src/orchestrator/StateMachine.ts
packages/agent-core/src/orchestrator/ExecutionContext.ts
packages/agent-core/src/orchestrator/BudgetManager.ts
packages/agent-core/src/orchestrator/RetryPolicy.ts
packages/agent-core/src/orchestrator/ApprovalProvider.ts
packages/agent-core/src/orchestrator/index.ts
```

### Acceptance criteria

- CLI and TUI produce equivalent tool/model behavior.
- Every model request and tool call increments a central budget counter.
- Max turns/tools/time/retries are hard limits.
- Cancellation works while streaming and while executing tools.
- Orchestrator unit tests cover normal, denied, failed, cancelled, and budget-exhausted flows.

---

## Phase 3 — Structured Planning and Context Management

### Goals

Make exploration deliberate, relevant, and bounded.

### Work items

1. Add a task classifier:
   - question
   - explanation
   - implementation
   - bug fix
   - security audit
   - performance investigation
   - refactor
2. Build structured plans with step dependencies, target files, risks, and verification commands.
3. Add plan state independent of Markdown rendering.
4. Keep `.inflynx/PLAN.md` as a human-readable projection of structured state.
5. Add context items with priority and source metadata.
6. Add token-aware context selection and compaction.
7. Deduplicate file reads, search results, and repeated tool output.
8. Add active-file and git-diff relevance boosts.
9. Add task-specific exploration depth from effort profile.
10. Detect when evidence is insufficient and request logs, reproduction steps, or environment details.

### Suggested files

- `packages/agent-core/src/planning/TaskClassifier.ts`
- `packages/agent-core/src/planning/StructuredPlan.ts`
- `packages/agent-core/src/context/ContextManager.ts`
- `packages/agent-core/src/context/ContextCompactor.ts`
- Existing `PlanEngine.ts`
- `packages/workspace-runtime/src/index.ts`

### Acceptance criteria

- A complex task creates a structured plan before mutation.
- Context stays within configured limits.
- Plans survive process restart.
- The agent can explain why each file was included.

---

## Phase 4 — Verification Engine and Repair Loop

### Goals

Make verification systematic and failure-driven.

### Work items

1. Create a verification registry for commands and checks.
2. Detect project commands from package metadata and configuration.
3. Support check types:
   - typecheck/build
   - unit tests
   - integration tests
   - lint/format
   - security scan
   - dependency audit
   - diff validation
   - custom user checks
4. Parse stdout/stderr into structured failures.
5. Map failures to files, lines, categories, and probable causes.
6. Add focused verification first, then broader verification based on effort profile.
7. Add repair loop with bounded retries.
8. Save failure signatures and resolutions to a failure journal.
9. Prevent fake fixes:
   - no disabling tests
   - no deleting assertions
   - no swallowing errors
   - no unrelated changes to hide failures
10. Re-run failed checks after every repair.
11. Produce a verification summary in the final response and report.

### Suggested files

```text
packages/agent-core/src/verification/VerificationEngine.ts
packages/agent-core/src/verification/CheckRegistry.ts
packages/agent-core/src/verification/FailureParser.ts
packages/agent-core/src/verification/RepairLoop.ts
packages/agent-core/src/verification/FailureJournal.ts
```

### Acceptance criteria

- A patch cannot be marked complete without configured verification results.
- Failures are preserved as evidence.
- Repair attempts stop at profile limits.
- The final report distinguishes fixed, unresolved, skipped, and unverified checks.

---

## Phase 5 — Evidence-First Debugging and Critical Bug Detection

### Goals

Turn debug mode into a disciplined investigation system rather than a generic code-review prompt.

### Finding schema

```ts
export interface BugFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "security"
    | "correctness"
    | "data-loss"
    | "race-condition"
    | "reliability"
    | "performance"
    | "observability";
  title: string;
  file: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: string[];
  reproduction?: string;
  impact: string;
  rootCause: string;
  confidence: number;
  verificationStatus: "hypothesis" | "reproduced" | "fixed" | "regression-tested" | "unresolved";
  suggestedFix?: string;
}
```

### Audit passes

#### Correctness and crash pass

- Null/undefined paths.
- Incorrect branching and state transitions.
- Async error and cancellation handling.
- Partial writes and transaction errors.
- Retry duplication and idempotency.
- Resource leaks and unhandled promises.

#### Security pass

- Path traversal and symlink escape.
- Command injection and shell quoting.
- SSRF and unrestricted network access.
- Secret leakage in logs, prompts, diffs, and session persistence.
- Authorization and permission confusion.
- Unsafe deserialization and prototype pollution.
- Temporary-file and permission issues.

#### Data integrity pass

- Atomicity and rollback.
- Lost updates.
- Duplicate events.
- Concurrent writes.
- Corrupt session/tool history.
- Inconsistent cache/index invalidation.

#### Performance pass

- Blocking filesystem/process operations.
- Unbounded output/context growth.
- Repeated scans and duplicate reads.
- N+1 tool calls.
- Excessive model turns.
- Missing timeouts and cancellation.

#### Regression pass

- Public API compatibility.
- Test coverage of changed behavior.
- Configuration migration needs.
- Cross-platform behavior.
- Build/lint/typecheck status.

### Investigation workflow

```text
collect baseline
  → reproduce or establish evidence
  → inspect source and call paths
  → generate hypotheses
  → run targeted checks
  → rank findings by severity/confidence
  → patch only verified root causes
  → run regression checks
  → write report
```

### Acceptance criteria

- Critical findings include reproducible evidence or are explicitly marked hypotheses.
- Debug reports include exact paths, categories, impact, root cause, and verification state.
- The engine can stop and request missing reproduction information.
- Security audit output is separate from style/code-quality nits.

---

## Phase 6 — Workspace Intelligence and Incremental Semantic Graph

### Goals

Improve investigation quality for large repositories.

### Work items

1. Add incremental filesystem watching.
2. Persist `.inflynx/project-map.json` or equivalent index metadata.
3. Parse TypeScript/JavaScript symbols with the TypeScript compiler API initially.
4. Add definitions, imports, exports, references, and basic call edges.
5. Add test-to-source mapping.
6. Add changed-file and dependency-impact analysis.
7. Add graph queries:
   - callers/callees
   - importers/imports
   - affected tests
   - public API consumers
   - dependency distance
8. Avoid loading entire large files into context; use focused symbol/line slices.
9. Add cache invalidation on file changes.
10. Add indexing diagnostics and stale-index detection.

### Suggested files

- `packages/workspace-runtime/src/index.ts`
- New `packages/workspace-runtime/src/indexer/`
- New `packages/workspace-runtime/src/symbol-graph/`
- New `packages/workspace-runtime/src/watch/`

### Acceptance criteria

- Large repositories can be indexed incrementally.
- A changed file returns affected symbols and tests.
- The agent can trace a finding across callers and dependencies.
- Stale index state is detected rather than trusted silently.

---

## Phase 7 — Transactional Editing, Conflicts, and AST Support

### Goals

Make multi-file changes safer and more structurally reliable.

### Work items

1. Add precondition hashes to patches.
2. Refuse to apply a patch if the target changed since it was read.
3. Add transaction rollback that restores all previously committed files if a later commit fails.
4. Add user-visible combined diff and affected-file risk summary.
5. Add conflict resolution workflow.
6. Add TypeScript AST transformations for selected operations:
   - import insertion/removal
   - symbol rename preparation
   - function replacement
   - interface/property changes
7. Preserve comments and formatting where possible.
8. Keep textual patch fallback for unsupported languages.
9. Add post-edit parse validation before verification.

### Suggested files

- `packages/patch-engine/src/index.ts`
- New `packages/patch-engine/src/ast/TypeScriptAstAdapter.ts`
- New `packages/patch-engine/src/transactions/ConflictDetector.ts`
- New `packages/patch-engine/src/transactions/RollbackManager.ts`

### Acceptance criteria

- Concurrent user edits are never silently overwritten.
- A failed multi-file commit leaves the workspace consistent.
- AST operations have parser and formatting regression tests.

---

## Phase 8 — Sessions, Failure Memory, and Observability

### Goals

Make sessions resumable, auditable, and diagnosable.

### Work items

1. Implement concrete SQLite session store.
2. Persist sessions, turns, messages, tool calls, approvals, budgets, findings, and verification results.
3. Add resume, fork, and rollback session operations.
4. Store redacted tool output and provider metadata.
5. Implement failure journal keyed by normalized error signatures.
6. Add structured telemetry with correlation IDs.
7. Redact credentials, authorization headers, cookies, tokens, and secret-like values before persistence/logging.
8. Add metrics:
   - task completion rate
   - verification pass rate
   - repair success rate
   - average tool calls
   - average model turns
   - budget exhaustion rate
   - false-positive finding rate
   - provider error rate
9. Add privacy controls and retention settings.

### Suggested files

- `packages/session-store/src/index.ts`
- New `packages/session-store/src/sqlite/`
- `packages/telemetry/src/index.ts`
- `packages/config/src/index.ts`
- `packages/protocol/src/index.ts`

### Acceptance criteria

- A session can be resumed after process restart.
- Logs and persisted sessions contain no raw API keys.
- Every task has a traceable event timeline.
- Failure patterns can improve future diagnosis without exposing secrets.

---

## Phase 9 — Provider Reliability, Cost, and Capability Routing

### Goals

Make model behavior predictable across providers.

### Work items

1. Normalize provider capability discovery.
2. Add native Gemini thinking adapter instead of relying only on the OpenAI-compatible endpoint.
3. Parse actual usage from each provider.
4. Normalize reasoning-token usage where available.
5. Handle provider-native content blocks without lossy reconstruction.
6. Add retry classification:
   - safe transient retry
   - rate-limit retry
   - invalid request no-retry
   - authentication no-retry
   - cancellation no-retry
7. Add request idempotency where supported.
8. Add model fallback only when policy permits.
9. Add model escalation based on task classification and evidence quality.
10. Estimate cost from actual usage and configured price tables.
11. Do not send unsupported thinking fields.
12. Display capability warnings in CLI/TUI.

### Suggested files

- `packages/model-gateway/src/index.ts`
- New `packages/model-gateway/src/providers/`
- New `packages/model-gateway/src/capabilities/`
- New `packages/model-gateway/src/usage/`
- New `packages/model-gateway/src/retry/`

### Acceptance criteria

- Each provider has contract tests with mocked streams.
- Unsupported features are visible and deterministic.
- Usage and cost are not reported as zero when the provider supplies data.
- Retry behavior does not duplicate mutations.

---

## Phase 10 — Tool DAG, Parallelism, and Large-Repository Optimization

### Goals

Improve speed without sacrificing ordering and safety.

### Work items

1. Build a dependency graph for tool calls.
2. Execute independent read-only operations in parallel.
3. Serialize mutations and commands that depend on updated state.
4. Add maximum concurrency and per-tool resource limits.
5. Cancel dependent nodes after a fatal prerequisite failure.
6. Cache immutable read results during a turn.
7. Invalidate cache after mutations.
8. Summarize large search results and raw logs before adding them to context.
9. Use adaptive exploration:
   - start focused
   - expand only when evidence requires it
10. Add tool-call batching for compatible read operations.

### Suggested files

- `packages/tool-runtime/src/dag/ToolDagScheduler.ts`
- `packages/tool-runtime/src/dag/DependencyResolver.ts`
- `packages/tool-runtime/src/cache/ToolResultCache.ts`
- `packages/agent-core/src/context/ContextCompactor.ts`

### Acceptance criteria

- Independent reads run concurrently.
- Mutations never race.
- Cache invalidation is tested.
- Large-repository tasks use less context without losing relevant evidence.

---

## Phase 11 — Plugin and Protocol Maturity

### Goals

Expose a stable runtime to future server, desktop, and IDE clients.

### Work items

1. Define versioned public protocol schemas.
2. Add runtime event validation.
3. Add local server/WebSocket adapter.
4. Add plugin manifest validation.
5. Add plugin capability and permission declarations.
6. Load plugins in isolated or restricted contexts.
7. Add plugin lifecycle and error isolation.
8. Prevent plugins from bypassing policy gateway.
9. Add protocol compatibility tests.

### Suggested files

- `packages/protocol/src/index.ts`
- `packages/plugin-sdk/src/index.ts`
- New `apps/server/`
- New plugin loader under `packages/agent-core` or `packages/plugin-sdk`

### Acceptance criteria

- TUI, CLI, and future server consume the same event contract.
- Plugin tools use the same policy and budget enforcement.
- Plugin failures do not crash the host agent.

---

## 7. Verification and Evaluation Strategy

### 7.1 Unit tests

Cover:

- Thinking budget validation.
- Provider capability mapping.
- Message/content-block replay.
- Effort profile resolution.
- Budget enforcement.
- State transition legality.
- Retry classification.
- Path boundary and symlink checks.
- Shell policy.
- Patch uniqueness and conflict detection.
- Diff generation.
- Plan parsing.
- Failure parsing.
- Secret redaction.

### 7.2 Integration tests

Use a fake model gateway and temporary workspace to test:

1. Read-only question.
2. Plan generation.
3. Approved patch.
4. Denied patch.
5. Tool failure and retry.
6. Build failure and repair.
7. Cancellation during model stream.
8. Cancellation during shell execution.
9. Budget exhaustion.
10. Provider tool-call history replay.
11. Multi-file transaction rollback.
12. Session resume.

### 7.3 Security tests

- `..` traversal.
- Absolute path outside root.
- Symlink outside root.
- Shell metacharacters.
- Command substitution.
- Malicious search patterns.
- SSRF to local/private addresses.
- Secret values in tool output and logs.
- Malicious MCP configuration.
- Plugin capability escalation.

### 7.4 Bug-finding evaluation corpus

Create fixture repositories containing known defects:

- Null dereference.
- Authorization bypass.
- SQL/command injection pattern.
- Race condition.
- Retry duplication.
- Lost update.
- Incorrect cache invalidation.
- Memory leak.
- Unhandled promise rejection.
- Path traversal.
- Insecure secret logging.
- Incorrect transaction rollback.

Measure:

- Detection rate.
- Reproduction rate.
- False-positive rate.
- Root-cause accuracy.
- Fix success rate.
- Regression rate.
- Average model turns/tools.
- Cost and wall-clock time by effort profile.

No single benchmark proves production readiness; evaluation must be treated as a feedback loop.

---

## 8. Recommended Implementation Order

The fastest safe order is:

```text
0. Baseline + CI + tests
1. Policy and safe tool gateway
2. Shared orchestrator/state machine
3. Effort profiles and budget manager
4. Verification engine and bounded repair loop
5. Evidence-first findings/debug mode
6. Context manager and structured planning
7. Transaction conflicts and rollback
8. Session store and redacted telemetry
9. Semantic index and test mapping
10. Provider reliability and usage
11. Tool DAG and parallel reads
12. AST editing
13. Plugins/server/protocol expansion
```

Do not start with a larger context window or a larger thinking budget. Without verification and policy enforcement, more model thinking mainly makes the agent slower and can increase the amount of unverified work.

---

## 9. Definition of Done for a Mature Agent v1

The agent is ready for a serious internal beta when it can:

1. Run through one shared orchestrator from CLI and TUI.
2. Enforce workspace and shell policy in code.
3. Track effort profile, model turns, tool calls, retries, verification runs, time, and token usage.
4. Create a structured plan for complex tasks.
5. Collect evidence before reporting critical findings.
6. Apply conflict-aware reversible patches.
7. Run focused and full verification gates.
8. Retry failures within explicit limits.
9. Stop safely when evidence or budgets are insufficient.
10. Persist redacted sessions and verification history.
11. Produce a final report containing:
    - changed files
    - evidence collected
    - commands run
    - verification results
    - unresolved risks
    - budget/cost summary
    - confidence level
12. Pass the security and fixture evaluation suites.

---

## 10. First Implementation Sprint

The first sprint should not attempt the entire roadmap. Implement these vertical slices:

### Sprint A — Contracts

- Add `EffortProfile` and `BudgetState`.
- Add structured `AgentEvent` types.
- Add `BugFinding` and `VerificationResult` types.
- Add provider capability and usage contract tests.

### Sprint B — Orchestrator

- Implement `AgentOrchestrator` for one model/tool loop.
- Move the CLI loop behind the orchestrator.
- Preserve existing approvals and provider history.
- Add hard model/tool/time limits.

### Sprint C — Policy

- Implement canonical path guard.
- Enforce policy inside `executeTool()`.
- Add shell timeout/cancellation and safe argument handling.
- Add security fixtures.

### Sprint D — Verification

- Add `VerificationEngine` with build/typecheck/test checks.
- Add bounded repair loop.
- Add final verification summary.

### Sprint E — Debug evidence

- Add finding extraction schema.
- Require evidence and confidence.
- Generate `.inflynx/DEBUG_REPORT.md` from structured findings.
- Add known-bug fixture tests.

### Sprint A–E exit criteria

A complex task should be able to move through:

```text
planning → exploring → implementing → verifying → repairing → reviewing → completed
```

with every transition, tool call, approval, failure, and verification result visible in the event stream.

---

## 11. Final Guidance

Claude Code/Codex-like maturity is not achieved by increasing thinking tokens alone. The differentiator is a controlled engineering loop:

```text
better evidence
+ better orchestration
+ safer tools
+ stronger verification
+ bounded recovery
+ persistent observability
```

Thinking effort should influence reasoning budget and agent execution profile, but it must never disable safety gates or allow unverified critical-bug claims. High effort should mean deeper investigation and verification, not merely a longer model response.

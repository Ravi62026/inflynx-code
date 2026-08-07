# Flynt Code: Advanced Agentic Coding Platform
## Technical RFC & Architectural Specification

## 1. Vision

Flynt Code is designed to evolve from a TypeScript agent CLI prototype into a production-grade, open-source agentic coding platform comparable in capability to Codex, Claude Code, and Kilo Code.

Rather than acting as a simple chatbot attached to basic file tools, Flynt is an **orchestration runtime**:

$$\text{Orchestration Runtime} = \text{Model Gateway} + \text{State Machine} + \text{Tool DAG Scheduler} + \text{Policy Engine} + \text{Verification Loop} + \text{Event-Driven UI}$$

### Target Capabilities
- **Repository-Aware**: Indexes code, constructs symbol dependency graphs, and reasons across the codebase rather than answering from a single prompt.
- **Autonomous Execution**: Plans, inspects evidence, performs AST/patch-aware modifications, executes shell commands, runs tests, fixes failures, and reviews changesets.
- **Provider Agnostic & BYOK-Only**: Supports OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, and local models (Ollama, LM Studio) behind a single streaming gateway interface with strict Bring Your Own Key security.
- **Real-Time Event Stream**: Streams model tokens character-by-character and emits granular tool/process activity events.
- **User Control & Auditability**: Enforces workspace boundaries, permission policy engines, diff previews, edit transactions, session undo stacks, and secret redaction.
- **Platform Architecture**: Operates CLI-first while exposing an event protocol and server layer that can power a TUI, desktop shell, web client, or IDE extension.

---

## 2. Baseline & Identified Limitations

The initial Flynt prototype provides a working TypeScript CLI with basic tools (`read_file`, `grep`, `glob`, `write_file`, `edit_file`, `bash`, `ask_user`), provider paths (DeepSeek, OpenRouter, Gemini), and simple session backups.

### Architectural Limitations to Resolve:

1. **State Machine**: The agent loop lacks explicit states (`planning`, `exploring`, `implementing`, `verifying`, `debugging`, `reviewing`), task state tracking, or configurable step/turn budgets.
2. **Shell Runtime**: `bash.ts` relies on `shell: true`; it lacks sandbox isolation, PTY streams, persistent shell sessions (`cd` tracking), and process-tree cancellation.
3. **Security & Boundary Enforcement**: Workspace boundaries are not strictly enforced; path traversal (`..`) and symlink escapes must be rejected at the system boundary. Hardcoded demo keys must be removed in favor of strict BYOK.
4. **Model Output**: Model responses arrive as batch outputs, leading to 10–30s spinner waits instead of character-by-character token streaming.
5. **Editing Capability**: File modification relies on string replacement; it requires patch-first transactions combined with syntax-aware AST node transformations.
6. **Codebase Memory**: Every session re-discovers the workspace from scratch; it lacks incremental repository indexing, symbol graphs, or persistent project memory (`FLYNT.md`).
7. **Verification**: Builds and tests are executed inconsistently rather than via structured language server type-checking and automated repair loops.
8. **Tool Execution**: Parallel tool calls are queued linearly without dependency DAG scheduling.

---

## 3. Agent Execution Engine & State Machine

### 3.1 Controlled Agent Loop

Modern coding agents derive their capability from a stateful, iterative loop with verification gates:

```text
User Request
  │
  ├─► Task Classification & Structured Planning
  ├─► Repository Discovery & Symbol Graph Query
  ├─► Model Reasoning & Dynamic Gateway Routing
  ├─► Tool Dependency DAG Scheduling & Parallel Execution
  ├─► Tool Output & Command Event Ingestion
  ├─► AST / Patch Edit Application
  ├─► Automated Typecheck, Lint & Test Verification
  ├─► Failure-Driven Debugging & Repair Cycle (Max 3 Attempts)
  └─► Final Changeset Diff & Summary
```

### 3.2 State Machine Transitions

Every session turn operates within an explicit state machine:

```text
       ┌───────────┐
       │   idle    │
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │ planning  │
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │ exploring │
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
 ┌────►│implementing│
 │     └─────┬─────┘
 │           │
 │           ▼
 │     ┌───────────┐
 │     │ verifying │
 │     └─────┬─────┘
 │           │
 │      ┌────┴────────────────────────┐
 │      ▼                             ▼
 │ ┌───────────┐               ┌───────────┐
 └─┤ debugging │               │ reviewing │
   └───────────┘               └─────┬─────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │    completed    │
                            │  waiting_appr   │
                            │   cancelled     │
                            └─────────────────┘
```

Each state dictates allowed tools, execution budgets, and transition criteria.

---

## 4. Target Monorepo Architecture

The platform architecture decouples UI, server, orchestration, model gateway, tool execution, and workspace runtime:

```text
flynt-code/
├── apps/
│   ├── cli/                         # Command-line entry point
│   ├── tui/                         # Terminal UI adapter (Ink/Blessed)
│   ├── server/                      # Local API and WebSocket server
│   └── desktop/                     # Future desktop shell
├── packages/
│   ├── agent-core/                  # State machine & orchestrator
│   │   ├── orchestrator/
│   │   ├── state-machine/
│   │   ├── planning/
│   │   ├── verification/
│   │   └── compaction/
│   ├── model-gateway/               # Unified streaming provider gateway
│   │   ├── providers/               # OpenAI, Anthropic, Gemini, DeepSeek, Ollama
│   │   ├── router/                  # Dynamic cost & model escalation router
│   │   └── adapters/
│   ├── tool-runtime/                # Tool registration, schemas, & DAG scheduler
│   │   ├── registry/
│   │   ├── dag-scheduler/
│   │   └── handlers/
│   ├── workspace-runtime/           # Workspace sandbox, PTY, process tree, FS watcher
│   │   ├── filesystem/
│   │   ├── symbol-graph/            # AST & Code Symbol Graph
│   │   ├── shell-pty/
│   │   └── sandbox/
│   ├── policy-engine/               # Approvals, permissions & path boundary guards
│   ├── patch-engine/                # Unified diff patches & AST node editor
│   ├── session-store/               # SQLite persistence, thread rollouts, resume/fork
│   ├── protocol/                    # JSON-RPC / WebSocket event schemas
│   ├── plugin-sdk/                  # Extension contract for 3rd-party tools & modes
│   └── config/                      # Config validation, profiles, secret redaction
├── skills/                          # Reusable instruction & tool packages
├── prompts/                         # Versioned system & mode prompts
└── tests/                           # Unit, integration, security & eval suites
```

---

## 5. Model Gateway & Dynamic Cost Routing

### 5.1 Provider-Neutral Interface

All LLM integrations conform to a single streaming interface:

```ts
interface ModelGateway {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  listModels(): Promise<ModelInfo[]>;
  capabilities(model: string): ModelCapabilities;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; thought: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "done"; usage: TokenUsage; finishReason: string };
```

### 5.2 Dynamic Cost Optimizer & Model Escalation

To optimize response quality while reducing LLM API costs by up to 70%, Flynt implements automated model escalation routing:

```
Task Prompt
    │
    ▼
Fast Model (e.g., Gemini 2.5 Flash / Claude Haiku)
    │
    ├───► [Complexity Classification]
    │       ├─ Simple Query / Read File ──► Return Fast Model Output
    │       └─ Complex Architecture / Refactor / Multi-file Edit Detected
    │               │
    │               ▼
    └───────► Auto-Escalate to Strong Model (e.g., Claude Sonnet 4 / Gemini Pro / Opus)
```

---

## 6. Codebase Indexing, Symbol Graph & Persistent Memory

### 6.1 Incremental Repository Indexer & FS Watcher

Rather than re-scanning the project on every prompt, Flynt maintains an active repository indexer:

- **Filesystem Watcher**: Uses OS file notifications (`chokidar`/`fsevents`) to track file creations, edits, and deletions incrementally.
- **Project Map (`.flynt/project-map.json`)**: Contains file trees, framework metadata, entry points, dependency locks, and shallow AST export signatures.

### 6.2 Semantic Code Symbol Graph

Flynt constructs an in-memory symbol graph for fast reference resolution:

```text
Symbol (Function / Class / Interface)
   ├──► Exports & Definitions
   ├──► Imports & Dependencies
   ├──► Call Graph (Caller ──► Callee)
   └──► References across Codebase
```

This graph enables instant multi-file reference tracking and symbol renaming without requiring repeated workspace-wide `grep` passes.

### 6.3 Persistent Project Memory (`FLYNT.md`) & Project Rules (`.flynt/rules.md`)

- **`FLYNT.md` (Agent Memory)**: Automatically written by the agent during sessions to record structural discoveries (e.g., "Uses Prisma ORM", "Tests live in `__tests__/`").
- **`.flynt/rules.md` (User Constraints)**: User-defined guidelines (e.g., "Use `pnpm` only", "2-space indentation", "Do not touch `src/generated/`"). Loaded directly into system context.

---

## 7. AST-Aware Editing & Multi-File Atomic Transactions

### 7.1 Hybrid AST & Unified Patch Engine

Flynt supports two complementary file editing strategies:

1. **Unified Diff Patches**: Standard contextual line-based patches for simple modifications.
2. **AST-Aware Node Transformations**: Uses Tree-sitter / TypeScript Compiler API / Babel for structural AST edits:
   $$\text{Find AST Node} \longrightarrow \text{Apply Transformation} \longrightarrow \text{Print Source (Preserving Formatting & Comments)}$$

### 7.2 Multi-File Atomic Changeset Transactions

Multi-file refactors execute within atomic transactions:

```ts
const tx = workspace.beginTransaction();
tx.patch("src/types.ts", patch1);
tx.astTransform("src/service.ts", astTransformSpec);
tx.create("src/middleware/auth.ts", content);

const result = await tx.commit(); // Atomic apply
if (!result.ok) await tx.rollback(); // Restores all files to pre-transaction hashes
```

---

## 8. Smart Context Window & Relevance Ranking

### 8.1 Quantitative Context Relevance Formula

When assembling model context, items are scored and ranked using a quantitative relevance formula:

$$\text{Relevance Score} = \text{Importance} \times \text{Recency} \times \text{Similarity} \times \frac{1}{\text{Dependency Distance} + 1}$$

Where:
- $\text{Importance}$: Weight based on context category (Pinned system rules = 1.0, failing error logs = 0.9, recent file edits = 0.8, old grep dumps = 0.2).
- $\text{Recency}$: Exponential decay based on turn index difference: $e^{-\lambda (T_{\text{current}} - T_{\text{item}})}$.
- $\text{Similarity}$: Cosine similarity between task prompt vector and context embeddings.
- $\text{Dependency Distance}$: Graph distance in the Semantic Code Symbol Graph from the active target file.

### 8.2 5-Tier Context Priority Eviction

Context entries are managed in 5 priority tiers:
1. **Pinned**: System prompt, `.flynt/rules.md`, active task plan (Never evicted).
2. **High**: Current target files, failing compiler/test errors, recent user inputs.
3. **Medium**: Symbol graph definitions, related file reads from current turn.
4. **Low**: Historical conversation turns, successful tool outputs.
5. **Ephemeral**: Large raw search dumps (Summarized into single-line findings).

---

## 9. Tool Scheduler & Dependency DAG

Instead of queuing tool calls sequentially or executing all in parallel blindly, Flynt parses tool dependencies into a Directed Acyclic Graph (DAG):

```text
       ┌────────────────┐         ┌────────────────┐
       │  Read File A   │         │  Read File B   │
       └───────┬────────┘         └───────┬────────┘
               │                          │
               └────────────┬─────────────┘
                            │
                            ▼
                   ┌────────────────┐
                   │  Search Graph  │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │   AST Edit     │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Typecheck/Test │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │  Git Commit    │
                   └────────────────┘
```

Parallelizable operations (reads, searches) run concurrently, while mutating operations (edits, builds, commits) enforce strict dependency barriers.

---

## 10. Structured Planning Schema & Failure Journal

### 10.1 Structured Task State Machine

Task plans are represented internally as structured JSON state:

```json
{
  "taskId": "task-402",
  "goal": "Implement Redis Rate Limiting",
  "status": "in_progress",
  "steps": [
    { "id": 1, "description": "Install dependencies", "status": "completed" },
    { "id": 2, "description": "Create rate limit middleware", "status": "in_progress", "targetFile": "src/middleware/rate-limit.ts" },
    { "id": 3, "description": "Verify via unit test", "status": "pending", "verificationCmd": "npm test" }
  ]
}
```

The UI renders this structured state as an interactive Markdown checklist, while the agent tracks execution programmatically.

### 10.2 Project Failure Journal (`.flynt/failure-journal.json`)

When an edit or build command fails, Flynt logs the failure signature and its eventual fix resolution:

```json
{
  "errorPattern": "TS2307: Cannot find module 'ioredis'",
  "context": "Express route middleware setup",
  "resolution": "Install @types/ioredis as dev dependency",
  "occurrences": 2
}
```

On subsequent errors matching a known pattern, Flynt consults the journal to apply proven fixes immediately.

---

## 11. Security, BYOK & Sandbox Policy Engine

### 11.1 Strict BYOK (Bring Your Own Key) Policy
- **Zero Hardcoded Secrets**: No bundled API keys, demo keys, or fallback credentials exist in the codebase.
- **Guided Onboarding**: If no key is found in environment variables (`~/.flynt/.env` or project `.env`), Flynt displays an interactive setup wizard and pings the provider API to validate credentials.
- **Central Secret Redaction**: All API keys, authorization headers, and environment tokens are stripped from logs, traces, tool outputs, and persisted session rollouts.

### 11.2 Sandbox Execution Profiles

| Sandbox Profile | File System Access | Shell Access | Network Access |
|:---|:---|:---|:---|
| **`read-only`** | Workspace read-only | Disabled | Disabled |
| **`workspace-write`** | Workspace read/write; Path traversal (`..`) blocked | Allowed (Sandboxed, command allowlist) | Restricted to local loopback |
| **`full-access`** | System-wide (Requires explicit user confirmation) | Unrestricted PTY | Unrestricted (Warned visibly) |

---

## 12. Extensible Plugin Specification

Flynt exposes a formal Plugin SDK for third-party extensions:

```ts
export interface FlyntPlugin {
  name: string;
  version: string;
  tools?: ToolDefinition[];
  prompts?: Record<string, string>;
  policies?: PolicyRule[];
  commands?: SlashCommandDefinition[];
  onEvent?: (event: PublicAgentEvent) => void | Promise<void>;
}
```

Plugins can register custom tools, add specialized workflow modes, or attach telemetry subscribers cleanly without modifying core orchestrator logic.

---

## 13. Weekly Implementation Deliverables

To provide clear implementation milestones for open-source contributors, work is structured into 8 weekly deliverables:

### 🗓️ Week 1: Safety & BYOK Baseline
- Remove all hardcoded credentials from codebase and implement strict BYOK key validation wizard.
- Implement path traversal guards (`..` rejection) and symlink escape checks.
- Add central secret redaction middleware for logs, error messages, and events.

### 🗓️ Week 2: ModelGateway & Streaming Runtime
- Implement `ModelGateway` interface returning `AsyncIterable<ModelEvent>`.
- Build streaming adapters for Google Gemini, OpenAI, Anthropic, and OpenRouter.
- Implement token-by-token character streaming and heartbeat indicators in CLI.

### 🗓️ Week 3: Workspace Runtime & Tool DAG Scheduler
- Implement persistent PTY shell sessions with process-group tree cancellation.
- Build Tool Dependency DAG Scheduler for safe parallel tool execution.
- Implement basic sandbox execution profiles (`read-only`, `workspace-write`).

### 🗓️ Week 4: AST Editing & Multi-File Edit Transactions
- Build unified patch engine and Tree-sitter / TS Compiler API AST node transformer.
- Implement atomic multi-file edit transactions with changeset rollback.
- Add interactive diff preview in CLI (`[y/N/edit]`).

### 🗓️ Week 5: Code Symbol Graph & Incremental Indexer
- Integrate OS filesystem watcher (`chokidar`) for incremental workspace indexing.
- Build in-memory Semantic Code Symbol Graph (definitions, imports, call graph).
- Implement `.flynt/rules.md` loading and `FLYNT.md` persistent project memory.

### 🗓️ Week 6: State Machine & Structured Task Planning
- Implement 6-state execution machine (`planning` $\rightarrow$ `exploring` $\rightarrow$ `implementing` $\rightarrow$ `verifying` $\rightarrow$ `debugging` $\rightarrow$ `reviewing`).
- Build structured JSON task plan engine rendered as Markdown checklists.
- Add quantitative context relevance scoring formula ($\text{Relevance} = \text{Importance} \times \text{Recency} \times \text{Similarity} \times \frac{1}{\text{Distance} + 1}$).

### 🗓️ Week 7: Language Server Integration & Failure Journal
- Integrate lightweight type-checker validation (`tsc --noEmit`, `pyright`, `cargo check`).
- Build `.flynt/failure-journal.json` error pattern recorder and automatic repair loop.
- Implement `/test` and `/coverage` slash commands.

### 🗓️ Week 8: Git Integration, Cost Optimizer & Plugin SDK
- Add git context awareness, checkpoint commits, and slash commands (`/commit`, `/pr`, `/branch`).
- Implement dynamic cost optimizer & model escalation router.
- Finalize SQLite session store (resume/fork) and publish `FlyntPlugin` SDK.

---

## 14. Definition of Done

Flynt Code reaches public Release Candidate (v1.0) when it can:

1. Accept a complex repository task and produce a structured, reviewable plan before execution.
2. Stream model output token-by-token with real-time tool DAG activity visualization.
3. Maintain workspace state incrementally via filesystem watching and semantic symbol graphs.
4. Execute atomic multi-file edits via AST transformations and unified patches with full rollback.
5. Perform fast type-checker validation and self-correct failures using a project failure journal.
6. Enforce strict BYOK credentials, workspace boundaries, and secret redaction.
7. Support multi-model routing to optimize quality and reduce API cost.
8. Persist, resume, and fork execution sessions stored in SQLite.
9. Pass comprehensive integration, security, and benchmark evaluation suites.

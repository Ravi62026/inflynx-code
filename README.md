# Inflynx Code (`inflynx-code`)
## Advanced Agentic Coding Platform

Production-grade, open-source agentic coding platform with multi-model provider support, streaming token output, AST-aware editing, semantic code symbol graphs, and sandboxed execution.

### Monorepo Packages

- `apps/cli`: Inflynx CLI Agent (`inflynx-agent`)
- `apps/server`: Local API & WebSocket Server
- `packages/agent-core`: State Machine & Orchestrator
- `packages/model-gateway`: Unified Streaming Provider Gateway & Cost Router
- `packages/tool-runtime`: Tool Registry & Dependency DAG Scheduler
- `packages/workspace-runtime`: FS Watcher, Symbol Graph, PTY Sandbox
- `packages/policy-engine`: Permission & Sandbox Policy Guards
- `packages/patch-engine`: Unified Diff & AST Node Transformer
- `packages/session-store`: SQLite Session Persistence & Rollouts
- `packages/protocol`: WebSocket / JSON-RPC Event Schemas
- `packages/plugin-sdk`: Plugin SDK & Extension Interface

### Quickstart

```bash
pnpm install
pnpm build
```

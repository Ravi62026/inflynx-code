# Inflynx Code (`inflynx-code`)
## Advanced Agentic Coding Platform

Open-source agentic coding platform with multi-model provider support, streaming (SSE) token output, a guarded file/workspace tool surface, approval-gated execution, and plan/verification support. (Phase 46 / L19: this list used to claim "AST-aware editing, semantic code symbol graphs, sandboxed execution" — none of which existed; it now describes what the code actually does.)

### Monorepo Packages

- `apps/cli`: Inflynx CLI Agent (`inflynx-agent`)
- `apps/server`: Local HTTP API with Server-Sent-Events streaming
- `packages/agent-core`: State machine, orchestrator, and budget manager
- `packages/model-gateway`: Unified streaming adapters (OpenAI / Anthropic / Gemini / OpenRouter) + token & cost accounting
- `packages/tool-runtime`: 20-tool registry and the guarded execution gateway (approvals, path canonicalisation, fences)
- `packages/workspace-runtime`: `.gitignore`-aware file indexer, `@mention` resolution, and the Mermaid/SVG architecture mind-map generator
- `packages/policy-engine`: path guard, per-invocation classification, and shell rule/audit engine
- `packages/patch-engine`: unified-diff patch application and turn checkpoints
- `packages/session-store`: append-only JSONL (local) and PostgreSQL session persistence
- `packages/protocol`: canonical agent-event and plan schemas (shared, dependency-free)
- `packages/plugin-sdk`: *experimental* plugin interface (loader/registry not yet implemented)

### Quickstart

```bash
pnpm install
pnpm build
```

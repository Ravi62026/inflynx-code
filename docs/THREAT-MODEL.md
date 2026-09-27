# Threat Model

Phase 46 (B15). A candid model of what Inflynx Code protects, from whom, how, and what it does
**not** yet defend against. Paired with [`PRIVACY.md`](./PRIVACY.md) (data egress) — this file is
about *attacks and controls*, not data flows.

## What we are protecting (assets)

1. The user's **source tree** (files on disk) from destructive or unwanted edits.
2. **Secrets and sensitive files** (`.env*`, `.git/**`, keys, `credentials.json`, `.ssh/.aws`) from
   being read into a provider prompt or overwritten.
3. The **machine** from unintended command execution (the agent can run a shell).
4. The **provider bill / budget** and the integrity of "done" (not claiming a fix that did not happen).

## Actors and trust boundaries

| Actor | Trusted? | Notes |
|---|---|---|
| The human user | Yes | Approves mutating/shell actions; owns the workspace and config. |
| The **model** | Semi-trusted | Decides which tool to call and with what args; every consequential call crosses the gateway + approval layer. |
| **Retrieved content** (web pages, MCP tool results, `@mention`'d files, attachments) | **Untrusted** | Primary prompt-injection vector. Never treated as instructions. |
| **Cloned repo contents** (`mcp.json`, plan files, code) | Untrusted-by-default | Content may not grant itself permission. |
| Providers / Redis / Postgres | Out of scope | Infrastructure; see PRIVACY.md for what leaves. |

## Threats and current controls

| # | Threat | Control (where it lives) |
|---|---|---|
| T1 | Model edits/deletes files outside intent, or escapes the workspace | `ToolExecutionGateway` canonicalises every path to the workspace root and rejects traversal; `policy-engine/path-guard`; a pre-image checkpoint enables `/undo` for the file tools |
| T2 | Secret exfiltration — a prompt carries `.env`/keys to the provider | Sensitive-path fences (Phase 27/28/33): `.env*`/`.git`/`node_modules`/key material excluded from index, `@mention`, attachments, and writes |
| T3 | **Prompt injection** through fetched/MCP/mentioned content hijacking the agent | Retrieved text is wrapped as *untrusted* (`protocol/untrusted`) with begin/end delimiters and embedded end-markers escaped, so it is read as data, not commands |
| T4 | Dangerous shell (`rm -rf`, curl|sh, redirections onto protected paths) | Shell rule engine + per-invocation classification + interactive approval; deny rules and the `[ask]` rich review; audit log of every shell turn |
| T5 | **Fake fix** — agent declares success without the change working | Anti-fake-fix step in the gateway (a "fixed" claim must correspond to touched paths) + the verification gate (typecheck/tests) whose verdict is surfaced at end of turn |
| T6 | Overwrite of a file the agent never read (context drift / race) | Patch safety review (`reviewMutatingPatchForSafety`) flags context mismatch before applying |
| T7 | A repo/config silently gaining execution power | MCP servers are untrusted-by-default and must be explicitly trusted before their tools run; external tools are mode-gated |
| T8 | Runaway cost / infinite loop | `BudgetManager` hard limits (turns, tool calls, wall-clock, reasoning tokens) + a rate-limit *pause* (Phase 42) rather than a hard session kill |

## Known gaps (honest, not papered over)

- **No authentication, no multi-user RBAC, and per-user authorization on `apps/server`.** It is a
  **single-user, local-first** service and is intended to bind to localhost only. Auth/RBAC were
  deliberately deferred until the agent itself is production-grade; **do not expose the server to an
  untrusted network** in its current state.
- **Local JSON/Postgres stores are not encrypted at rest.** Treat the workspace `.inflynx/` directory
  and the database as holding everything the conversation contained.
- **`/undo` covers the file tools, not the shell** (finding M19): a turn that truncates a file via
  `execute_shell` has no pre-image to restore, even though the command is still seen and audited.
- **Approval is the last line for shell/mutating actions.** `INFLYNX_AUTO_APPROVE` bypasses it and is
  recorded as such; use only where the whole workspace is disposable.
- **Provider-side retention** depends on the chosen provider/account; the Responses path sends
  `store:false`, but the guarantees are the provider's, not ours.

## Non-goals of this model

Physical/access-control compromise of the host, malicious *installed* MCP servers that the user
explicitly trusted, and supply-chain compromise of dependencies (mitigated only partly by the CI
`pnpm audit --prod` gate) are outside this document's scope.

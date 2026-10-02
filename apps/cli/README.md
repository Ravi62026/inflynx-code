# Inflynx Code — CLI Agent (`inflynx`)

A **local-first, bring-your-own-key (BYOK), approval-gated** agentic coding tool. It reads your
workspace, plans multi-step changes, edits files through guarded patches, runs shell commands behind
your approval, and verifies its own work — while your code and API key stay on your machine.

> Not a cloud service. There are **no accounts and no telemetry**. Every action that changes a file or
> runs a command is shown for your approval first. Your provider key never leaves your machine except
> in the API calls you choose to make. See [`docs/PRIVACY.md`](https://github.com/Ravi62026/inflynx-code/blob/main/docs/PRIVACY.md)
> for exactly what can go outbound.

## Install

```bash
npm install -g inflynx-agent
```

This gives you the `inflynx` (and `inflynx-agent`) command. Requires **Node.js 20+**.

## Quickstart

```bash
# 1. Give it a model key (any one of these)
export OPENROUTER_API_KEY=sk-or-...     # or OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY

# 2. From inside a project directory, start the interactive agent
cd your-project
inflynx

# ...or run a single task and exit
inflynx -p "find every caller of parseFrontmatter and summarize the call sites"

# ...or pipe context in
cat build.log | inflynx "explain this failure and propose the smallest fix"
```

No key set? `inflynx` still opens in a safe **demo mode** so you can see the interface and the tool
registry before connecting a model.

## What it does

- **A guarded tool surface** — read/search/edit/patch files, list/glob, git, background shells, web
  search, diagnostics via the TypeScript language service. File writes are path-canonicalised to your
  workspace; sensitive paths (`.env*`, `.git/**`, key files) are fenced; each mutating/shell action
  asks for approval.
- **Plans + verification** — it can lay out a structured plan and gate "done" on the typecheck/tests
  actually passing, not just its own claim.
- **Sub-agent delegation** — offload a read-only exploration to a bounded child so your main session
  stays small.
- **Reversibility** — file edits are checkpointed; `/undo` restores the last turn's changes.
- **Local-first state** — sessions persist to a local append-only store by default; point
  `DATABASE_URL`/`REDIS_URL` at Postgres/Redis only if you want the production backend.

## Help

```bash
inflynx --help
```

Inside the REPL, `/help` lists the slash commands (modes, plan, sessions, mcp, undo, …).

## Status & honesty

This is an early **local-first developer tool**, not a hardened multi-tenant service. The companion
VS Code extension and a hosted/cloud tier are not part of this CLI launch. Bugs and feedback:
[GitHub issues](https://github.com/Ravi62026/inflynx-code/issues).

## License

MIT

# Privacy — what leaves the machine

Phase 46 (B15 / N2). This states *exactly* what network egress Inflynx Code performs and how to
turn each one off. Anything not listed here does not phone out. Everything is local-first: with no
provider keys configured, the agent cannot complete a model turn and the server stays in an offline
demo mode.

## Egress inventory

| # | Where data goes | What is sent | When | How to disable |
|---|---|---|---|---|
| 1 | Your configured **LLM provider** (OpenAI / Anthropic / Gemini / OpenRouter base URLs) | The full prompt: system instructions, conversation history, and tool results, streamed for each turn | Every model call | Do not set a provider key in `.env`. The CLI then cannot run a real turn; the server uses offline demo mode. |
| 2 | **OpenRouter** (only if you pick it) | Same as #1, plus fixed identification headers `HTTP-Referer: https://github.com/inflynx-cloud/inflynx-code` and `X-Title: Inflynx Code Agent` | Every OpenRouter call | Choose a direct provider key (OpenAI/Anthropic/Gemini) instead of OpenRouter — the referer/title headers are added only on the OpenRouter path. |
| 3 | **DuckDuckGo** (`html.duckduckgo.com`, `api.duckduckgo.com`) | The literal search query string | When the agent runs the `web_search` tool | Decline the tool at the approval prompt, or run a mode that does not expose it. Your *code* is not sent by this tool — only the query text the agent composes. |
| 4 | **Any public URL** the agent chooses (`fetch_url`) | A plain HTTP GET (no cookies/auth from you) | When the agent runs `fetch_url` | Decline the tool at approval. |
| 5 | **MCP servers** you configure (`.inflynx/mcp.json` / global) | Tool arguments over the configured transport | When the agent calls an MCP tool | Do not add servers; untrusted-by-default servers must be explicitly trusted before they can execute. |
| 6 | **PostgreSQL** at `DATABASE_URL` (if set) | Session rows, messages, tool logs, token telemetry | On session writes | Leave `DATABASE_URL` unset → sessions stay in the local append-only JSONL store under `.inflynx/sessions/` (on your machine only). |
| 7 | **Redis** at `REDIS_URL` (if set) | Rate-limit counters and optional event pub/sub only — never file contents | On rate-limit checks | Leave `REDIS_URL` unset → rate limiting is inactive (fail-open) and no data goes to Redis. |

## Explicitly does NOT happen

- **No telemetry/analytics beacon.** There is no first-party usage-tracking endpoint; `packages/telemetry`
  is not a remote sink.
- **No Mermaid/graph image upload.** Architecture graphs render to **local** `.mmd` / `.svg` / `.html`
  files. The `GraphEngine` previously base6-encoded the whole module/dependency graph and fetched
  `https://mermaid.ink/svg/<that>` to make a PNG — silently egressing private repo structure
  (finding B15). **That was removed in Phase 47**; there is no remote graph render. *Residual caveat:*
  the generated `graph.html` loads the `mermaid.min.js` script from the jsDelivr CDN, so **opening
  that HTML file in a browser** makes one request to jsDelivr (the mermaid source is rendered client-
  side and is not uploaded). Use `GRAPH.md`/`graph.svg` if you want zero network at view time.
- **No file contents to DuckDuckGo or to any search.** Only the query string.

## Sensitive-content handling that reduces what leaves

- `.env*`, `.git/**`, `node_modules/**`, key material (`*.pem`, `*.key`, `credentials.json`, `.ssh`,
  `.aws`, …) are excluded from indexing and `@mention`, and secret-named attachments are withheld
  before they can reach the model/provider (see the Phase 27 / 28 / 33 fences).
- Tool results from `fetch_url`/MCP are wrapped as untrusted content so retrieved text cannot masquerade
  as instructions.

## Local storage

With the default (no `DATABASE_URL`) configuration, all transcripts and checkpoints live under the
workspace's `.inflynx/` directory on your own machine. `.inflynx/` is git-ignored so it is not
committed by accident.

/**
 * Inflynx Code — Local API & SSE Streaming Server (`apps/server`)
 *
 * Exposes a production-ready HTTP and Server-Sent Events (SSE) streaming API
 * connecting frontends (Web, Desktop, Remote Clients) directly to the
 * Inflynx Core Orchestrator, PostgreSQL Session Store, and Model Gateway.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { prepareAttachments } from "./attachments.js";
import {
  loadEnv,
  MODEL_CATALOG,
  TOP_PROVIDERS,
  REASONING_EFFORTS,
  getProvider,
  supportsReasoningEffort,
  type ReasoningEffort,
} from "@inflynx/config";
import { createSessionStore, PostgresSessionStore, type SessionStore } from "@inflynx/session-store";
import { ToolRegistry, CORE_TOOLS } from "@inflynx/tool-runtime";
import { AgentOrchestrator, type AgentBudgetLevel, type AgentMode, type ToolApprovalRequest } from "@inflynx/agent-core";
import { AgentEventBus, type PublicAgentEvent } from "@inflynx/protocol";
import { handleAuthRoutes } from "./auth/routes.js";
import { authEnforced, resolveUser } from "./auth/middleware.js";
import { creditsForCostUsd } from "./auth/credits.js";
import { isProviderError } from "@inflynx/model-gateway";
import { getRedisClient } from "@inflynx/cache";

loadEnv();

// H5 (Phase 42): this is a multi-tenant server, so when Redis is configured the rate limiter is a
// real control — a broken/unreachable Redis must DENY (fail closed), not silently permit every call
// the way the single-user CLI is allowed to. A deployment can still opt out by setting the var.
process.env.INFLYNX_RATE_LIMIT_FAIL_CLOSED ||= "1";

const PORT = Number(process.env.PORT || 4000);

// ─── Local-first posture (backlog Phase 2) ─────────────────────────────────────
// This service can read, write and execute files anywhere inside its workspace
// root. It therefore binds loopback by default, never lets a request choose the
// root, and treats auto-approval as an operator decision made at launch. None of
// this is authentication — identity/RBAC remain deferred (backlog §6).
const TRUTHY = /^(1|true)$/i;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function resolveBindHost(requested: string | undefined, allowRemote: boolean): string {
  const host = (requested || "").trim() || "127.0.0.1";
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing to bind to "${host}". This server writes files and runs commands in the workspace, so a ` +
      `non-loopback bind requires explicit opt-in via INFLYNX_SERVER_ALLOW_REMOTE=1 — and at that point ` +
      `authentication and TLS are your responsibility (still unimplemented; see backlog §6).`
    );
  }
  return host;
}

const SERVER_ALLOW_REMOTE = TRUTHY.test(process.env.INFLYNX_SERVER_ALLOW_REMOTE || "");
const HOST = resolveBindHost(process.env.HOST, SERVER_ALLOW_REMOTE);

/** Auto-approval is a launch-time operator decision, never a client-controllable flag. */
const SERVER_AUTO_APPROVE = TRUTHY.test(process.env.INFLYNX_AUTO_APPROVE || "");

/** Origins permitted for browser clients. Node callers (the extension host) are unaffected by CORS. */
const ALLOWED_ORIGINS = new Set(
  (process.env.INFLYNX_ALLOWED_ORIGINS ||
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
);

/** Roots an operator may point the server at. Requests never participate in this decision. */
const ALLOWED_WORKSPACE_ROOTS = (process.env.INFLYNX_ALLOWED_ROOTS || process.cwd())
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

function resolveServerWorkspaceRoot(): string {
  const requested = process.env.INFLYNX_SERVER_WORKSPACE
    ? path.resolve(process.env.INFLYNX_SERVER_WORKSPACE)
    : process.cwd();
  const contained = ALLOWED_WORKSPACE_ROOTS.some(
    (root) => requested === root || requested.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  );
  if (!contained) {
    throw new Error(
      `Refusing to start: workspace "${requested}" is outside INFLYNX_ALLOWED_ROOTS ` +
      `(${ALLOWED_WORKSPACE_ROOTS.join(", ")}).`
    );
  }
  return requested;
}

const WORKSPACE_ROOT = resolveServerWorkspaceRoot();

const sessionStore: SessionStore = createSessionStore(WORKSPACE_ROOT);

// Auth (Phase 2): identity/device codes/credits require Postgres. Present only when DATABASE_URL is
// set; the /auth + /me routes and the (default-off) INFLYNX_AUTH_ENFORCED gate no-op without it, so
// the local BYOK demo flow is untouched until the keys + CLI /login (Phase 4) turn it on.
const identityStore = process.env.DATABASE_URL ? new PostgresSessionStore(process.env.DATABASE_URL) : null;

/**
 * One tool registry **per session**, built on demand rather than shared.
 *
 * The core tools are stateless since Phase 5 (they take a `ToolExecutionContext`
 * and the gateway owns the guard), so a shared instance was not a live isolation
 * bug — it was a trap. The moment MCP servers or plugins are wired into this
 * process, tool sets become per-session and a module-level registry would leak one
 * session's connectors into another's tool list. Building it here costs a Map of
 * eight stateless objects and removes that failure mode permanently.
 */
function createToolRegistry(): ToolRegistry {
  return new ToolRegistry(CORE_TOOLS);
}

const activeOrchestrators = new Map<
  string,
  { orchestrator: AgentOrchestrator; bus: AgentEventBus; registry: ToolRegistry }
>();

/** Modes a client may request. Anything else is rejected rather than passed through. */
const VALID_AGENT_MODES: AgentMode[] = ["ask", "plan", "agent", "debug"];

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  permissionLevel: string;
  args: Record<string, unknown>;
  resolve: (approved: boolean) => void;
  timeoutId: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, Map<string, PendingApproval>>();

function createApprovalHandler(sessionId: string, bus: AgentEventBus, autoApprove: boolean) {
  return async (request: ToolApprovalRequest): Promise<boolean> => {
    if (autoApprove || request.permissionLevel === "readonly") {
      return true;
    }

    const toolCallId = request.toolCallId || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // `sessionId` travels inside the payload: the SSE writer forwards the payload
    // only, so a client could not tell which session was asking and answered against
    // whichever session it happened to be showing (backlog K9).
    bus.emit("tool.approval_required", sessionId, {
      sessionId,
      toolCallId,
      toolName: request.toolName,
      permissionLevel: request.permissionLevel,
      args: request.args,
    });

    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        const sessionMap = pendingApprovals.get(sessionId);
        sessionMap?.delete(toolCallId);
        resolve(false);
      }, 5 * 60 * 1000);

      if (!pendingApprovals.has(sessionId)) {
        pendingApprovals.set(sessionId, new Map());
      }
      pendingApprovals.get(sessionId)!.set(toolCallId, {
        toolCallId,
        toolName: request.toolName,
        permissionLevel: request.permissionLevel,
        args: request.args,
        resolve: (val: boolean) => {
          clearTimeout(timeoutId);
          resolve(val);
        },
        timeoutId,
      });
    });
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
  // CORS is applied once per request by `applyCorsHeaders()` before any writeHead:
  // a per-response `Access-Control-Allow-Origin` set here would override it.
  if (res.headersSent) {
    // Reached from the catch-all below when a route has already started streaming.
    // `writeHead` on a live SSE response throws ERR_HTTP_HEADERS_SENT, which turns
    // one failed turn into an uncaught exception that kills the request handler.
    console.warn(
      `[inflynx-server] status ${statusCode} could not be sent — the response was already ` +
      `streaming. The error was written into the stream instead.`
    );
    try {
      res.write(`event: turn.failed\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    } catch {
      res.destroy();
    }
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
}

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const fail = (message: string, statusCode: number) => {
      if (settled) return;
      settled = true;
      const err = new Error(message) as Error & { statusCode?: number };
      err.statusCode = statusCode;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        // Stop storing, but keep draining: `req.destroy()` tears down the socket and
        // the 413 never reaches the client (measured — curl saw a bare connection
        // reset). Dropping the data listeners and resuming discards the rest of the
        // upload without buffering it, so the response can still be written.
        req.removeAllListeners("data");
        req.resume();
        fail("Request body too large (max 2MB)", 413);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        fail("Invalid JSON body", 400);
      }
    });
    req.on("error", () => fail("Request stream error", 400));
  });
}

const sessionHydrationCache = new Map<string, { data: any; time: number }>();
let listSessionsCache: { data: any; time: number } | null = null;

/**
 * K2 (Phase 47): the store names these `provider` / `effortLevel` / `status` with numeric
 * timestamps; the extension reads `providerId` / `budgetLevel` / `state` with ISO strings. Reading
 * the wrong names is what made a resumed session silently reset the provider picker and the sidebar
 * tooltip show "Budget: undefined". This mapper is the single wire contract (`SessionRecordWire` in
 * @inflynx/protocol) so both sides agree by construction.
 */
function toWireSession(r: any) {
  if (!r) return r;
  return {
    sessionId: r.sessionId,
    providerId: r.provider,
    model: r.model,
    activeMode: r.activeMode,
    budgetLevel: r.effortLevel,
    reasoningEffort: r.reasoningEffort,
    state: r.status,
    title: r.title,
    cwd: r.cwd,
    createdAt: typeof r.createdAt === "number" ? new Date(r.createdAt).toISOString() : r.createdAt,
    updatedAt: typeof r.updatedAt === "number" ? new Date(r.updatedAt).toISOString() : r.updatedAt,
  };
}

const server = http.createServer(async (req, res) => {
  applyCorsHeaders(req, res);

  // Correlation id: without it, a client-side "the turn failed" report cannot be
  // matched to a server log line at all. Full request-scoped structured logging is
  // Phase 45; this is the 5-line version that makes today's logs usable.
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader("X-Inflynx-Request-Id", requestId);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname.replace(/\/+$/, "") || "/";

  if (pathname !== "/health") {
    console.log(`[HTTP] ${req.method} ${pathname}`);
  }

  try {
    // ─── Auth routes (CLI device flow) + /me ──────────────────────────────────
    // Only meaningful with a Postgres identity store; otherwise they 404, leaving the local flow intact.
    if (identityStore && (pathname.startsWith("/auth/") || pathname === "/me" || pathname.startsWith("/me/"))) {
      const handled = await handleAuthRoutes(req, res, {
        store: identityStore,
        baseUrl: (process.env.INFLYNX_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, ""),
        send: sendJson,
        readBody: parseJsonBody,
        toWireSession,
      });
      if (handled) return;
      return sendJson(res, 404, { error: "not found" });
    }

    // Mandatory-login gate (Phase 2). Default OFF (INFLYNX_AUTH_ENFORCED unset) so the BYOK local
    // flow is unaffected; flipped on with Clerk keys + the CLI /login (Phase 4). When on, session
    // routes require a valid app token. /health and /api/models stay public.
    if (authEnforced() && pathname.startsWith("/api/sessions")) {
      const claims = resolveUser(req);
      if (!claims) return sendJson(res, 401, { error: "authentication required — run: icode /login" });
      (req as { __inflynxUser?: unknown }).__inflynxUser = claims;
    }

    // ─── GET /health ────────────────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/health") {
      let postgresStatus = "disconnected";
      try {
        await sessionStore.listSessions(WORKSPACE_ROOT);
        postgresStatus = "connected";
      } catch {
        postgresStatus = "error";
      }

      const redis = getRedisClient();
      const redisStatus = redis && redis.status === "ready" ? "connected" : "optional_offline";

      return sendJson(res, 200, {
        status: "ok",
        service: "inflynx-server",
        version: "1.0.0",
        port: PORT,
        workspaceRoot: WORKSPACE_ROOT,
        postgres: postgresStatus,
        redis: redisStatus,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    }

    // ─── GET /api/models ────────────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/models") {
      return sendJson(res, 200, {
        catalog: MODEL_CATALOG,
        providers: TOP_PROVIDERS,
        supportedEfforts: REASONING_EFFORTS,
      });
    }

    // ─── GET /api/sessions ──────────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/sessions") {
      const now = Date.now();
      const limit = Number(reqUrl.searchParams.get("limit") || "50");
      // Per-user history: with auth on, a caller sees only their own sessions (not the shared cwd).
      const claims = (req as { __inflynxUser?: { sub: string } }).__inflynxUser;
      if (claims && identityStore) {
        const mine = await identityStore.listSessionsByUser(claims.sub, limit);
        return sendJson(res, 200, { sessions: mine.map(toWireSession) });
      }
      if (listSessionsCache && (now - listSessionsCache.time) < 800) {
        return sendJson(res, 200, { sessions: listSessionsCache.data.slice(0, limit).map(toWireSession) });
      }
      const allSessions = await sessionStore.listSessions(WORKSPACE_ROOT);
      listSessionsCache = { data: allSessions, time: now };
      const sessions = allSessions.slice(0, limit).map(toWireSession);
      return sendJson(res, 200, { sessions });
    }

    // ─── POST /api/sessions ─────────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/sessions") {
      listSessionsCache = null;
      const body = await parseJsonBody(req);
      let providerId = body.providerId || process.env.INFLYNX_AGENT_PROVIDER || "openrouter";
      if (providerId === "openrouter" && !process.env.OPENROUTER_API_KEY && process.env.DEEPSEEK_API_KEY) {
        providerId = "deepseek";
      }
      const provider = getProvider(providerId);
      const model = body.model || (providerId === "deepseek" ? "deepseek-v4-flash" : (process.env.INFLYNX_AGENT_MODEL || provider?.defaultModel || "openai/gpt-5.6-luna"));
      const apiKey = provider ? process.env[provider.envKey] || "" : "";
      if (body.apiKey) {
        console.warn(
          "[inflynx-server] Ignoring client-supplied apiKey — keys are resolved server-side from the " +
          "environment or OS keychain only."
        );
      }
      // Validated at the boundary: an unknown mode would otherwise blow up in
      // `filterToolsForMode` (MODE_CONFIGS[mode] is undefined) on the first turn.
      if (body.activeMode !== undefined && !VALID_AGENT_MODES.includes(body.activeMode as AgentMode)) {
        return sendJson(res, 400, {
          error: `Invalid activeMode "${body.activeMode}". Expected one of: ${VALID_AGENT_MODES.join(", ")}.`,
        });
      }
      const activeMode = (body.activeMode as AgentMode) || "agent";
      const budgetLevel = (body.budgetLevel as AgentBudgetLevel) || "medium";
      let reasoningEffort = (body.reasoningEffort as ReasoningEffort) || undefined;
      if (reasoningEffort && !supportsReasoningEffort(providerId, model, reasoningEffort)) {
        reasoningEffort = "none";
      }
      // The workspace root is operator-controlled; a request must never pick it.
      if (body.workspaceRoot) {
        console.warn(
          `[inflynx-server] Ignoring client-supplied workspaceRoot "${body.workspaceRoot}"; ` +
          `this server only operates on ${WORKSPACE_ROOT}.`
        );
      }
      const workspaceRoot = WORKSPACE_ROOT;

      const bus = new AgentEventBus();
      const autoApprove = SERVER_AUTO_APPROVE;
      if (body.autoApprove || req.headers["x-auto-approve"]) {
        console.warn(
          "[inflynx-server] Ignoring client-requested auto-approval — it is a launch-time operator flag " +
          "(INFLYNX_AUTO_APPROVE), never a per-request privilege."
        );
      }
      // Session identity is generated server-side: a client-chosen id could
      // collide with (and silently graft messages onto) an existing session.
      const targetSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (body.sessionId) {
        console.warn(`[inflynx-server] Ignoring client-supplied sessionId "${body.sessionId}".`);
      }
      const approvalHandler = createApprovalHandler(targetSessionId, bus, autoApprove);
      const registry = createToolRegistry();

      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot,
          providerId,
          model,
          apiKey,
          activeMode,
          reasoningEffort,
          sessionId: targetSessionId,
        },
        registry,
        bus,
        approvalHandler,
        budgetLevel,
        sessionStore
      );

      activeOrchestrators.set(orchestrator.sessionId, { orchestrator, bus, registry });

      // Attribute the new session to the authenticated caller (owner is fixed at creation).
      const ownerClaims = (req as { __inflynxUser?: { sub: string } }).__inflynxUser;
      if (ownerClaims && identityStore) {
        await identityStore.setSessionUser(orchestrator.sessionId, ownerClaims.sub).catch(() => {});
      }

      return sendJson(res, 201, {
        sessionId: orchestrator.sessionId,
        providerId,
        model,
        activeMode,
        budgetLevel,
        reasoningEffort: orchestrator.modelConfiguration.reasoningEffort,
        state: orchestrator.state,
      });
    }

    // ─── GET /api/sessions/:id ──────────────────────────────────────────────
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const sessionId = sessionMatch[1];
      const now = Date.now();
      const cached = sessionHydrationCache.get(sessionId);
      if (cached && (now - cached.time) < 800) {
        return sendJson(res, 200, { session: cached.data });
      }
      const hydration = await sessionStore.getSessionHydration(sessionId);
      if (!hydration) {
        return sendJson(res, 404, { error: `Session "${sessionId}" not found.` });
      }
      // Per-user authorization: a session belongs to exactly one owner; never leak another's.
      const caller = (req as { __inflynxUser?: { sub: string } }).__inflynxUser;
      if (caller && hydration.session.userId && hydration.session.userId !== caller.sub) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      // K2: normalize the inner session row so the extension reads real providerId/budgetLevel/state.
      const wireHydration = { ...hydration, session: toWireSession(hydration.session) };
      sessionHydrationCache.set(sessionId, { data: wireHydration, time: now });
      return sendJson(res, 200, { session: wireHydration });
    }

    // ─── POST /api/sessions/:id/turns (SSE Streaming) ───────────────────────
    const turnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (req.method === "POST" && turnMatch) {
      const sessionId = turnMatch[1];
      sessionHydrationCache.delete(sessionId);
      listSessionsCache = null;
      const body = await parseJsonBody(req);
      const prompt = String(body.prompt || "").trim();

      if (!prompt) {
        return sendJson(res, 400, { error: "Missing required 'prompt' field in request body." });
      }

      // Phase 2/3: with an authenticated caller (only present when INFLYNX_AUTH_ENFORCED is on),
      // enforce ownership, disablement, and a credit balance BEFORE running (402 = out of credits).
      const caller = (req as { __inflynxUser?: { sub: string } }).__inflynxUser;
      if (caller && identityStore && authEnforced()) {
        const own = await sessionStore.getSessionHydration(sessionId);
        if (own?.session?.userId && own.session.userId !== caller.sub) {
          return sendJson(res, 403, { error: "forbidden" });
        }
        const u = await identityStore.getUser(caller.sub);
        if (!u || u.disabled) return sendJson(res, 403, { error: "account disabled" });
        if (u.credits <= 0) return sendJson(res, 402, { error: "out of credits — top up to continue" });
      }

      // Rehydrate or reuse active orchestrator
      let active = activeOrchestrators.get(sessionId);
      if (!active) {
        // An unknown id used to be accepted and written to. `saveMessage` against a
        // session with no row either fails a Postgres foreign key mid-stream (after
        // SSE headers are out, so it cannot be reported as a 404) or silently creates
        // an orphan row that `listSessions` never shows. Validate before any write.
        const known = await sessionStore.getSessionHydration(sessionId);
        if (!known) {
          return sendJson(res, 404, {
            error: `Session "${sessionId}" not found. Create it with POST /api/sessions first.`,
          });
        }
        // Also what the resume path below needs — don't fetch it twice.
        sessionHydrationCache.set(sessionId, { data: known, time: Date.now() });

        const bus = new AgentEventBus();
        const registry = createToolRegistry();
        const autoApprove = SERVER_AUTO_APPROVE;
        const approvalHandler = createApprovalHandler(sessionId, bus, autoApprove);

        // Check if demo turn
        if (prompt.toLowerCase().startsWith("/demo")) {
          startSse(res);
          const sseWrite = (event: string, payload: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          sseWrite("turn.started", { turnNumber: 1 });
          sseWrite("model.thought_delta", {
            delta: `Analyzing workspace environment and reviewing active capabilities in Demo Mode...\nInspecting local tool registry: ${CORE_TOOLS.length} tools ready.`,
          });
          await new Promise((r) => setTimeout(r, 300));

          const demoText = `👋 Hello! I am **Inflynx Code**, your autonomous AI software engineer.\n\n✨ **Demo Mode Active** — The extension UI, real-time SSE streaming pipeline, Markdown rendering, and session persistence are working successfully!\n\n### Next Steps to enable live autonomous execution:\n1. Open \`.env\` in your workspace root (\`${WORKSPACE_ROOT}/.env\`).\n2. Add your provider API key:\n   \`\`\`env\n   OPENROUTER_API_KEY=sk-or-v1-...\n   # Or: OPENAI_API_KEY=sk-...\n   # Or: ANTHROPIC_API_KEY=sk-ant-...\n   # Or: GOOGLE_API_KEY=AIza...\n   \`\`\`\n3. Select your preferred model in the top-right model picker.\n\nFeel free to ask questions or explore the session history and tool registry in the sidebar!`;

          for (let i = 0; i < demoText.length; i += 16) {
            sseWrite("model.text_delta", { delta: demoText.slice(i, i + 16) });
            await new Promise((r) => setTimeout(r, 20));
          }

          await sessionStore.saveMessage(sessionId, {
            role: "assistant",
            content: demoText,
            reasoningContent: "Analyzing workspace environment and reviewing active capabilities in Demo Mode...",
          });

          sseWrite("turn.completed", {
            finalText: demoText,
            toolResults: [],
            budgetState: {
              level: "medium",
              turnsUsed: 0,
              maxTurns: 45,
              toolCallsUsed: 0,
              maxToolCalls: 90,
              tokensUsed: 0,
              maxTokens: 0,
              contextUtilizationPercent: 0,
              exhausted: false,
            },
            isCompleted: true,
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        try {
          const resumed = await AgentOrchestrator.resumeSession(
            WORKSPACE_ROOT,
            sessionId,
            registry,
            bus,
            approvalHandler,
            sessionStore
          );
          if (!resumed) {
            return sendJson(res, 404, { error: `Session "${sessionId}" not found or cannot be resumed.` });
          }
          active = { orchestrator: resumed, bus, registry };
          activeOrchestrators.set(sessionId, active);
        } catch (resumeErr: any) {
          startSse(res);
          const warningMsg = `⚠️ **Cannot Resume Session: Missing API Key**\n\n${resumeErr.message}\n\n### How to Fix:\n1. Open \`.env\` in the project root and add your API key.\n2. Or configure it via **VS Code Settings** (\`inflynx.openSettings\`).\n\n💡 *Tip: Type \`/demo\` in the chat box to test Inflynx Code without an API key.*`;

          await sessionStore.saveMessage(sessionId, {
            role: "system",
            content: warningMsg,
          });

          res.write(`event: turn.failed\ndata: ${JSON.stringify({ error: warningMsg })}\n\n`);
          res.write(`event: turn.completed\ndata: ${JSON.stringify({ finalText: "", toolResults: [], isCompleted: false })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
      }

      // Dynamically sync mode, reasoning effort, and model if passed in request body
      if (active?.orchestrator) {
        // This used to compare a *mode* against a *state* (`exploring`,
        // `completed`, …) so the guard was effectively always true (J5). Values are
        // now validated, and every change is logged so a silent ask→agent
        // escalation is at least visible. Per-session escalation consent is Phase 10.
        if (body.activeMode !== undefined) {
          if (VALID_AGENT_MODES.includes(body.activeMode as AgentMode)) {
            const requestedMode = body.activeMode as AgentMode;
            if (requestedMode !== active.orchestrator.activeMode) {
              console.log(
                `[inflynx-server] session ${sessionId} mode change: ` +
                `${active.orchestrator.activeMode} → ${requestedMode}`
              );
              active.orchestrator.setMode(requestedMode);
            }
          } else {
            console.warn(`[inflynx-server] Ignoring invalid activeMode "${body.activeMode}".`);
          }
        }
        if (body.reasoningEffort && body.reasoningEffort !== active.orchestrator.modelConfiguration.reasoningEffort) {
          try {
            await active.orchestrator.setReasoningEffort(body.reasoningEffort);
          } catch (effortErr: any) {
            console.warn(`[Inflynx Server] Could not set reasoning effort:`, effortErr?.message);
          }
        }
        if (body.model && body.model !== active.orchestrator.modelConfiguration.model) {
          try {
            const switched = await active.orchestrator.switchModel({
              model: body.model,
              providerId: body.providerId || active.orchestrator.modelConfiguration.providerId,
              reasoningEffort: body.reasoningEffort || active.orchestrator.modelConfiguration.reasoningEffort,
            });
            active.orchestrator = switched;
            activeOrchestrators.set(sessionId, active);
          } catch (modelErr: any) {
            console.warn(`[Inflynx Server] Could not switch model:`, modelErr?.message);
          }
        }
      }

      // Setup SSE response
      startSse(res);

      const sseWrite = (event: string, payload: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      // ─── Demo Mode Fallback ───────────────────────────────────────────────
      const provId = active.orchestrator.modelConfiguration.providerId;
      if (prompt.toLowerCase().startsWith("/demo") || provId === "demo") {
        sseWrite("turn.started", { turnNumber: 1 });
        sseWrite("model.thought_delta", {
          delta: `Analyzing workspace environment and reviewing active capabilities in Demo Mode...\nInspecting local tool registry: ${CORE_TOOLS.length} tools ready.`,
        });
        await new Promise((r) => setTimeout(r, 300));

        const demoText = `👋 Hello! I am **Inflynx Code**, your autonomous AI software engineer.\n\n✨ **Demo Mode Active** — The extension UI, real-time SSE streaming pipeline, Markdown rendering, and session persistence are working successfully!\n\n### Next Steps to enable live autonomous execution:\n1. Open \`.env\` in your workspace root (\`${WORKSPACE_ROOT}/.env\`).\n2. Add your provider API key:\n   \`\`\`env\n   OPENROUTER_API_KEY=sk-or-v1-...\n   # Or: OPENAI_API_KEY=sk-...\n   # Or: ANTHROPIC_API_KEY=sk-ant-...\n   # Or: GOOGLE_API_KEY=AIza...\n   \`\`\`\n3. Select your preferred model in the top-right model picker.\n\nFeel free to ask questions or explore the session history and tool registry in the sidebar!`;

        for (let i = 0; i < demoText.length; i += 16) {
          sseWrite("model.text_delta", { delta: demoText.slice(i, i + 16) });
          await new Promise((r) => setTimeout(r, 20));
        }

        await sessionStore.saveMessage(sessionId, {
          role: "assistant",
          content: demoText,
          reasoningContent: "Analyzing workspace environment and reviewing active capabilities in Demo Mode...",
        });

        sseWrite("turn.completed", {
          finalText: demoText,
          toolResults: [],
          budgetState: {
            level: "medium",
            turnsUsed: 0,
            maxTurns: 45,
            toolCallsUsed: 0,
            maxToolCalls: 90,
            tokensUsed: 0,
            maxTokens: 0,
            contextUtilizationPercent: 0,
            exhausted: false,
          },
          isCompleted: true,
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ─── Upfront Credential Check ─────────────────────────────────────────
      const provider = getProvider(provId);
      const envKey = provider?.envKey || "";
      const hasKey = Boolean(process.env[envKey]);

      if (provId !== "demo" && provider?.credentialRequired && !hasKey) {
        const warningMsg = `⚠️ **No API Key Configured for "${provider.name}"**\n\nTo interact with **${active.orchestrator.modelConfiguration.model}**, please configure your API key:\n\n1. Open \`.env\` in the workspace root and set:\n   \`\`\`env\n   ${provider.envKey}=your_api_key_here\n   \`\`\`\n2. Or set it in **VS Code Settings** (\`inflynx.openSettings\`).\n\n💡 *Tip: Type \`/demo\` in chat to test Inflynx Code's streaming interface in offline demo mode.*`;

        await sessionStore.saveMessage(sessionId, {
          role: "system",
          content: warningMsg,
        });

        sseWrite("turn.failed", { error: warningMsg });
        sseWrite("turn.completed", {
          finalText: "",
          toolResults: [],
          budgetState: active.orchestrator.budgetSnapshot,
          isCompleted: false,
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // Subscribe to live bus events for this turn
      const unsubBus = active.bus.on("*", (event: PublicAgentEvent) => {
        if (event.type === "turn.failed") {
          const errPayload = event.payload as any;
          const errorText = errPayload?.error || "Turn failed";
          sessionStore.saveMessage(sessionId, {
            role: "system",
            content: `⚠️ Provider Error: ${errorText}`,
          }).catch(() => {});
        }
        sseWrite(event.type, event.payload);
      });

      // Process any attached images / screenshots / files (Phase 27).
      let attachedContext = body.attachedContext || "";
      let messageImages: Array<{ mediaType: string; dataBase64: string; name?: string }> = [];
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (attachments.length > 0) {
        const attachmentsDir = path.join(WORKSPACE_ROOT, ".inflynx", "attachments");
        const prepared = prepareAttachments(attachments, { root: WORKSPACE_ROOT, saveDir: attachmentsDir });
        messageImages = prepared.images;
        if (prepared.contextText) {
          attachedContext = (attachedContext ? `${attachedContext}\n\n` : "") + prepared.contextText;
        }
      }

      const onClientClose = () => {
        try {
          active.orchestrator.abort();
        } catch {}
      };
      req.on("close", onClientClose);

      try {
        const costBefore = active.orchestrator.budget.estimatedCostUsd;
        const turnResult = await active.orchestrator.runTurn(prompt, attachedContext || undefined, messageImages.length ? messageImages : undefined);
        sseWrite("turn.completed", {
          finalText: turnResult.finalText,
          toolResults: turnResult.toolResults,
          budgetState: active.orchestrator.budgetSnapshot,
          isCompleted: turnResult.isCompleted,
        });
        // Phase 3: meter the turn — debit the session's incremental cost from the owner's balance.
        if (caller && identityStore && authEnforced()) {
          const delta = Math.max(0, active.orchestrator.budget.estimatedCostUsd - costBefore);
          if (delta > 0) await identityStore.debitCredits(caller.sub, creditsForCostUsd(delta), "model-turn", sessionId).catch(() => {});
        }
        res.write("data: [DONE]\n\n");
      } catch (err: any) {
        const errMsg = isProviderError(err) ? err.userMessage : err?.message || String(err);
        await sessionStore.saveMessage(sessionId, {
          role: "system",
          content: `⚠️ Turn Execution Error: ${errMsg}`,
        }).catch(() => {});
        sseWrite("turn.failed", {
          error: errMsg,
          // The provider's own sentence is already user-facing, so the UI can show
          // `error` verbatim and use `errorKind`/`retryable` to decide what to offer.
          ...(isProviderError(err)
            ? { errorKind: err.kind, retryable: err.retryable, httpStatus: err.status }
            : {}),
        });
        sseWrite("turn.completed", {
          finalText: "",
          toolResults: [],
          budgetState: active.orchestrator.budgetSnapshot,
          isCompleted: false,
        });
        res.write("data: [DONE]\n\n");
      } finally {
        req.off("close", onClientClose);
        unsubBus();
        res.end();
      }
      return;
    }

    // ─── POST /api/sessions/:id/approve ─────────────────────────────────────
    const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const sessionId = approveMatch[1];
      const body = await parseJsonBody(req);
      const toolCallId = String(body.toolCallId || "");
      const approved = Boolean(body.approved);

      const sessionMap = pendingApprovals.get(sessionId);
      const pending = sessionMap?.get(toolCallId);

      if (!pending) {
        return sendJson(res, 404, {
          error: `No pending approval found for toolCallId "${toolCallId}" in session "${sessionId}".`,
        });
      }

      sessionMap?.delete(toolCallId);
      pending.resolve(approved);

      return sendJson(res, 200, {
        status: "resolved",
        sessionId,
        toolCallId,
        approved,
      });
    }

    // ─── POST /api/sessions/:id/abort ───────────────────────────────────────
    const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) {
      const sessionId = abortMatch[1];
      const active = activeOrchestrators.get(sessionId);
      if (active) {
        active.orchestrator.abort();
      }
      // Cancel and deny any pending approvals for this session
      const sessionMap = pendingApprovals.get(sessionId);
      if (sessionMap) {
        for (const [, pending] of sessionMap) {
          pending.resolve(false);
        }
        sessionMap.clear();
      }
      // A cancelled turn must not leave its dev server bound to the port: the
      // process group is signalled, then the shell is dropped from the session.
      const shellsStopped = active?.orchestrator.shutdown({ abortTurn: false }).shellsStopped ?? 0;
      return sendJson(res, 200, {
        status: "aborted",
        sessionId,
        ...(shellsStopped > 0 ? { shellsStopped } : {}),
      });
    }

    // 404 Route Not Found
    return sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` });
  } catch (err: any) {
    const statusCode = Number(err?.statusCode) || 500;
    console.error(`[inflynx-server] ${requestId} ${req.method} ${pathname} failed:`, err);
    return sendJson(res, statusCode, {
      error: statusCode === 500 ? "Internal Server Error" : err?.message || "Request failed",
      requestId,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log("==================================================================");
  console.log("⚡ INFLYNX CODE BACKEND API & SSE STREAMING SERVER");
  console.log("==================================================================");
  console.log(`🚀 Server listening on: http://${HOST}:${PORT}`);
  console.log(`🔒 Bind scope:          ${isLoopbackHost(HOST) ? "loopback only" : `NON-LOCAL (${HOST}) via INFLYNX_SERVER_ALLOW_REMOTE`}`);
  console.log(`🔑 Auto-approve:        ${SERVER_AUTO_APPROVE ? "ENABLED for all sessions (INFLYNX_AUTO_APPROVE)" : "disabled — per-tool approvals required"}`);
  console.log(`🏥 Health check:        http://localhost:${PORT}/health`);
  console.log(`🤖 Models catalog:      http://localhost:${PORT}/api/models`);
  console.log(`💾 Sessions endpoint:   http://localhost:${PORT}/api/sessions`);
  console.log(`📂 Workspace Root:      ${WORKSPACE_ROOT}`);
  console.log("==================================================================\n");

  if (!isLoopbackHost(HOST)) {
    console.warn("⚠️  WARNING: this server can write files and execute commands in the workspace.");
    console.warn("   It is reachable from a routable interface while authentication and TLS are still");
    console.warn("   unimplemented. Do not leave it exposed.\n");
  }
});

function handleShutdown(signal: string) {
  console.log(`\n[inflynx-server] Received ${signal} — gracefully shutting down...`);

  // Abort in-flight turns and reap their background shells first. Without this a
  // `pnpm dev` the agent started outlives the server entirely, because background
  // shells are deliberately detached into their own process group.
  let shellsStopped = 0;
  for (const [sessionId, active] of activeOrchestrators) {
    try {
      shellsStopped += active.orchestrator.shutdown({ abortTurn: true }).shellsStopped;
    } catch (err: any) {
      console.warn(`[inflynx-server] shutdown failed for ${sessionId}: ${err?.message || err}`);
    }
  }
  activeOrchestrators.clear();
  if (shellsStopped > 0) {
    console.log(`[inflynx-server] stopped ${shellsStopped} background shell(s).`);
  }

  server.close(() => {
    console.log("[inflynx-server] HTTP server closed.");
    void finishExit();
  });
  // `server.close()` only fires once every connection has ended, and an SSE stream
  // is open by design — so a graceful close is a hang here, not a shutdown. Force
  // the exit and say what was still in flight instead of pretending it drained.
  const abandonedSessions = activeOrchestrators.size;
  setTimeout(() => {
    console.log(
      `[inflynx-server] ${abandonedSessions} session(s) still attached (SSE streams do not close) — forcing exit.`
    );
    void finishExit();
  }, 2_000).unref?.();

  async function finishExit(): Promise<void> {
    // H11: release the session store (Postgres pool / handles) before exiting. Best-effort
    // and time-boxed — a wedged close must not hang shutdown past the force timer.
    try {
      await Promise.race([sessionStore.close(), new Promise((r) => setTimeout(r, 1_000))]);
    } catch (err: any) {
      console.warn(`[inflynx-server] sessionStore.close() failed: ${err?.message || err}`);
    }
    process.exit(0);
  }
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

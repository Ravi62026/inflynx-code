/**
 * Inflynx Code — Local API & SSE Streaming Server (`apps/server`)
 *
 * Exposes a production-ready HTTP and Server-Sent Events (SSE) streaming API
 * connecting frontends (Web, Desktop, Remote Clients) directly to the
 * Inflynx Core Orchestrator, PostgreSQL Session Store, and Model Gateway.
 */

import http from "node:http";
import { URL } from "node:url";
import {
  loadEnv,
  MODEL_CATALOG,
  TOP_PROVIDERS,
  REASONING_EFFORTS,
  getProvider,
  type ReasoningEffort,
} from "@inflynx/config";
import { createSessionStore, type SessionStore } from "@inflynx/session-store";
import { ToolRegistry, CORE_TOOLS } from "@inflynx/tool-runtime";
import { AgentOrchestrator, type AgentBudgetLevel, type AgentMode } from "@inflynx/agent-core";
import { AgentEventBus, type PublicAgentEvent } from "@inflynx/protocol";
import { getRedisClient } from "@inflynx/cache";

loadEnv();

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const WORKSPACE_ROOT = process.cwd();

const sessionStore: SessionStore = createSessionStore(WORKSPACE_ROOT);
const toolRegistry = new ToolRegistry(CORE_TOOLS);
const activeOrchestrators = new Map<string, { orchestrator: AgentOrchestrator; bus: AgentEventBus }>();

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large (max 2MB)"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Global CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname.replace(/\/+$/, "") || "/";

  try {
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
      const limit = Number(reqUrl.searchParams.get("limit") || "50");
      const allSessions = await sessionStore.listSessions(WORKSPACE_ROOT);
      const sessions = allSessions.slice(0, limit);
      return sendJson(res, 200, { sessions });
    }

    // ─── POST /api/sessions ─────────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/sessions") {
      const body = await parseJsonBody(req);
      const providerId = body.providerId || process.env.INFLYNX_AGENT_PROVIDER || "openrouter";
      const provider = getProvider(providerId);
      const model = body.model || process.env.INFLYNX_AGENT_MODEL || provider?.defaultModel || "openai/gpt-5.6-luna";
      const apiKey = body.apiKey || (provider ? process.env[provider.envKey] : "") || "mock_key";
      const activeMode = (body.activeMode as AgentMode) || "agent";
      const budgetLevel = (body.budgetLevel as AgentBudgetLevel) || "medium";
      const reasoningEffort = (body.reasoningEffort as ReasoningEffort) || undefined;
      const workspaceRoot = body.workspaceRoot || WORKSPACE_ROOT;

      const bus = new AgentEventBus();
      const orchestrator = await AgentOrchestrator.start(
        {
          workspaceRoot,
          providerId,
          model,
          apiKey,
          activeMode,
          reasoningEffort,
        },
        toolRegistry,
        bus,
        async () => true, // default auto-approve for server headless mode; frontend approval endpoint can be wired
        budgetLevel,
        sessionStore
      );

      activeOrchestrators.set(orchestrator.sessionId, { orchestrator, bus });

      return sendJson(res, 201, {
        sessionId: orchestrator.sessionId,
        providerId,
        model,
        activeMode,
        budgetLevel,
        state: orchestrator.state,
      });
    }

    // ─── GET /api/sessions/:id ──────────────────────────────────────────────
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const sessionId = sessionMatch[1];
      const hydration = await sessionStore.getSessionHydration(sessionId);
      if (!hydration) {
        return sendJson(res, 404, { error: `Session "${sessionId}" not found.` });
      }
      return sendJson(res, 200, { session: hydration });
    }

    // ─── POST /api/sessions/:id/turns (SSE Streaming) ───────────────────────
    const turnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (req.method === "POST" && turnMatch) {
      const sessionId = turnMatch[1];
      const body = await parseJsonBody(req);
      const prompt = String(body.prompt || "").trim();

      if (!prompt) {
        return sendJson(res, 400, { error: "Missing required 'prompt' field in request body." });
      }

      // Rehydrate or reuse active orchestrator
      let active = activeOrchestrators.get(sessionId);
      if (!active) {
        const bus = new AgentEventBus();
        const resumed = await AgentOrchestrator.resumeSession(
          WORKSPACE_ROOT,
          sessionId,
          toolRegistry,
          bus,
          async () => true,
          sessionStore
        );
        if (!resumed) {
          return sendJson(res, 404, { error: `Session "${sessionId}" not found or cannot be resumed.` });
        }
        active = { orchestrator: resumed, bus };
        activeOrchestrators.set(sessionId, active);
      }

      // Setup SSE response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const sseWrite = (event: string, payload: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      // Subscribe to live bus events for this turn
      const unsubBus = active.bus.on("*", (event: PublicAgentEvent) => {
        sseWrite(event.type, event.payload);
      });

      try {
        const turnResult = await active.orchestrator.runTurn(prompt, body.attachedContext);
        sseWrite("turn.completed", {
          finalText: turnResult.finalText,
          toolResults: turnResult.toolResults,
          budgetState: turnResult.budgetState,
          isCompleted: turnResult.isCompleted,
        });
        res.write("data: [DONE]\n\n");
      } catch (err: any) {
        sseWrite("turn.failed", { error: err?.message || String(err) });
      } finally {
        unsubBus();
        res.end();
      }
      return;
    }

    // ─── POST /api/sessions/:id/abort ───────────────────────────────────────
    const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) {
      const sessionId = abortMatch[1];
      const active = activeOrchestrators.get(sessionId);
      if (active) {
        active.orchestrator.abort();
      }
      return sendJson(res, 200, { status: "aborted", sessionId });
    }

    // 404 Route Not Found
    return sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` });
  } catch (err: any) {
    console.error(`[inflynx-server] Unhandled error handling ${req.method} ${pathname}:`, err);
    return sendJson(res, 500, { error: err?.message || "Internal Server Error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("==================================================================");
  console.log("⚡ INFLYNX CODE BACKEND API & SSE STREAMING SERVER");
  console.log("==================================================================");
  console.log(`🚀 Server listening on: http://${HOST}:${PORT}`);
  console.log(`🏥 Health check:        http://localhost:${PORT}/health`);
  console.log(`🤖 Models catalog:      http://localhost:${PORT}/api/models`);
  console.log(`💾 Sessions endpoint:   http://localhost:${PORT}/api/sessions`);
  console.log(`📂 Workspace Root:      ${WORKSPACE_ROOT}`);
  console.log("==================================================================\n");
});

function handleShutdown(signal: string) {
  console.log(`\n[inflynx-server] Received ${signal} — gracefully shutting down...`);
  server.close(() => {
    console.log("[inflynx-server] HTTP server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

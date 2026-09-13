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
import { AgentOrchestrator, type AgentBudgetLevel, type AgentMode, type ToolApprovalRequest } from "@inflynx/agent-core";
import { AgentEventBus, type PublicAgentEvent } from "@inflynx/protocol";
import { getRedisClient } from "@inflynx/cache";

loadEnv();

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const WORKSPACE_ROOT = process.cwd();

const sessionStore: SessionStore = createSessionStore(WORKSPACE_ROOT);
const toolRegistry = new ToolRegistry(CORE_TOOLS);
const activeOrchestrators = new Map<string, { orchestrator: AgentOrchestrator; bus: AgentEventBus }>();

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

    bus.emit("tool.approval_required" as any, sessionId, {
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
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auto-Approve",
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

const sessionHydrationCache = new Map<string, { data: any; time: number }>();
let listSessionsCache: { data: any; time: number } | null = null;

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

  if (pathname !== "/health") {
    console.log(`[HTTP] ${req.method} ${pathname}`);
  }

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
      const now = Date.now();
      const limit = Number(reqUrl.searchParams.get("limit") || "50");
      if (listSessionsCache && (now - listSessionsCache.time) < 800) {
        return sendJson(res, 200, { sessions: listSessionsCache.data.slice(0, limit) });
      }
      const allSessions = await sessionStore.listSessions(WORKSPACE_ROOT);
      listSessionsCache = { data: allSessions, time: now };
      const sessions = allSessions.slice(0, limit);
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
      const apiKey = body.apiKey || (provider ? process.env[provider.envKey] : "") || "mock_key";
      const activeMode = (body.activeMode as AgentMode) || "agent";
      const budgetLevel = (body.budgetLevel as AgentBudgetLevel) || "medium";
      const reasoningEffort = (body.reasoningEffort as ReasoningEffort) || undefined;
      const workspaceRoot = body.workspaceRoot || WORKSPACE_ROOT;

      const bus = new AgentEventBus();
      const autoApprove = req.headers["x-auto-approve"] === "true" || Boolean(body.autoApprove);
      const targetSessionId = body.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const approvalHandler = createApprovalHandler(targetSessionId, bus, autoApprove);

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
        toolRegistry,
        bus,
        approvalHandler,
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
      const now = Date.now();
      const cached = sessionHydrationCache.get(sessionId);
      if (cached && (now - cached.time) < 800) {
        return sendJson(res, 200, { session: cached.data });
      }
      const hydration = await sessionStore.getSessionHydration(sessionId);
      if (!hydration) {
        return sendJson(res, 404, { error: `Session "${sessionId}" not found.` });
      }
      sessionHydrationCache.set(sessionId, { data: hydration, time: now });
      return sendJson(res, 200, { session: hydration });
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

      // Rehydrate or reuse active orchestrator
      let active = activeOrchestrators.get(sessionId);
      if (!active) {
        const bus = new AgentEventBus();
        const autoApprove = req.headers["x-auto-approve"] === "true" || Boolean(body.autoApprove);
        const approvalHandler = createApprovalHandler(sessionId, bus, autoApprove);

        // Check if demo turn
        if (prompt.toLowerCase().startsWith("/demo")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          const sseWrite = (event: string, payload: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          sseWrite("turn.started", { turnNumber: 1 });
          sseWrite("model.thought_delta", {
            delta: "Analyzing workspace environment and reviewing active capabilities in Demo Mode...\nInspecting local tool registry: 14 tools ready.",
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
              startedAt: Date.now(),
              modelTurns: 1,
              toolCalls: 0,
              readonlyToolCalls: 0,
              mutatingToolCalls: 0,
              shellCalls: 0,
              retries: 0,
              verificationRuns: 0,
              promptTokens: 42,
              completionTokens: 148,
              reasoningTokens: 20,
              estimatedCostUsd: 0,
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
            toolRegistry,
            bus,
            approvalHandler,
            sessionStore
          );
          if (!resumed) {
            return sendJson(res, 404, { error: `Session "${sessionId}" not found or cannot be resumed.` });
          }
          active = { orchestrator: resumed, bus };
          activeOrchestrators.set(sessionId, active);
        } catch (resumeErr: any) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
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

      // ─── Demo Mode Fallback ───────────────────────────────────────────────
      const provId = active.orchestrator.modelConfiguration.providerId;
      if (prompt.toLowerCase().startsWith("/demo") || provId === "demo") {
        sseWrite("turn.started", { turnNumber: 1 });
        sseWrite("model.thought_delta", {
          delta: "Analyzing workspace environment and reviewing active capabilities in Demo Mode...\nInspecting local tool registry: 14 tools ready.",
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
            startedAt: Date.now(),
            modelTurns: 1,
            toolCalls: 0,
            readonlyToolCalls: 0,
            mutatingToolCalls: 0,
            shellCalls: 0,
            retries: 0,
            verificationRuns: 0,
            promptTokens: 42,
            completionTokens: 148,
            reasoningTokens: 20,
            estimatedCostUsd: 0,
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
          budgetState: active.orchestrator.budget,
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
        const errMsg = err?.message || String(err);
        await sessionStore.saveMessage(sessionId, {
          role: "system",
          content: `⚠️ Turn Execution Error: ${errMsg}`,
        }).catch(() => {});
        sseWrite("turn.failed", { error: errMsg });
        sseWrite("turn.completed", {
          finalText: "",
          toolResults: [],
          budgetState: active.orchestrator.budget,
          isCompleted: false,
        });
        res.write("data: [DONE]\n\n");
      } finally {
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

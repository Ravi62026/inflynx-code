/**
 * Shared agent test harness (backlog Phase 45).
 *
 * Before this, every turn-level suite hand-rolled the same four things — an SSE `fetch`
 * stub, a scripted provider reply, a temp workspace, a temp session store — and they had
 * already drifted (three near-copies in git-tools/plan-tool/phase33 alone). A harness is
 * not just DRY: the recorded-request bodies it captures are what make an *eval* (does the
 * agent actually emit X?) possible instead of a tautology (add a thing, read the thing).
 *
 * Everything here is offline and deterministic — the provider is a stub, so the loop,
 * gateway, compaction and adapters are exercised for real without a key or a network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupOnExit } from "./tmp.js";
import { ToolRegistry, CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { AgentOrchestrator } from "../../packages/agent-core/src/orchestrator/AgentOrchestrator.js";
import { AgentEventBus } from "../../packages/protocol/src/index.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/index.js";

export interface FetchStub {
  /** Raw `body` strings of every outbound request, in order — for request-shape assertions. */
  bodies(): string[];
  /** Request URLs, in order — for baseURL/proxy assertions (Phase 34/36). */
  urls(): string[];
  /** Parsed JSON of every outbound request body, in order. */
  requests(): any[];
  count(): number;
  restore(): void;
}

/** A `text/event-stream` Response from raw `data:` payload lines (OpenAI-style). */
export function sse(lines: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}`).join("\n") + "\n")); c.close(); },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A scripted assistant turn that proposes one tool call. */
export function toolCallSse(name: string, args: Record<string, unknown>, id = "c1"): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ]);
}

/** A scripted assistant turn that only emits text (the model is done calling tools). */
export function textSse(text: string): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);
}

/**
 * Installs a `global.fetch` stub that records every request body and serves `script`
 * responses in order (reusing the last one once exhausted). Always pair with `restore()`
 * in a `finally`.
 */
export function stubFetch(
  script: Array<() => Response | Promise<Response>> | ((n: number, body: string) => Response | Promise<Response>)
): FetchStub {
  const original = (globalThis as any).fetch;
  const captured: string[] = [];
  const urls: string[] = [];
  let n = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    captured.push(typeof init?.body === "string" ? init.body : "");
    const idx = n++;
    const response = typeof script === "function"
      ? await script(idx, captured[captured.length - 1])
      : await (script[idx] ?? script[script.length - 1])();
    return response;
  };
  return {
    bodies: () => captured.slice(),
    urls: () => urls.slice(),
    requests: () => captured.map((b) => { try { return JSON.parse(b); } catch { return {}; } }),
    count: () => captured.length,
    restore: () => { (globalThis as any).fetch = original; },
  };
}

export function makeTempWorkspace(prefix = "inflynx-harness-"): string {
  return cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface Harness {
  root: string;
  registry: ToolRegistry;
  bus: AgentEventBus;
  fetch: FetchStub;
  orchestrator: AgentOrchestrator;
  cleanup(): void;
}

/**
 * A temp workspace + temp store + a stubbed provider, wired into a real
 * `AgentOrchestrator`. `approve` decides per tool call (default: approve everything).
 */
export async function startHarness(opts: {
  root?: string;
  mode?: "agent" | "plan" | "ask" | "debug";
  approve?: (toolName: string) => Promise<boolean> | boolean;
  effort?: "low" | "medium" | "high";
  registry?: ToolRegistry;
  /** Provider replier: an ordered list of producers, or a function of the call index. */
  script?: Array<() => Response | Promise<Response>> | ((n: number, body: string) => Response | Promise<Response>);
} = {}): Promise<Harness> {
  const root = opts.root ?? makeTempWorkspace();
  const registry = opts.registry ?? new ToolRegistry(CORE_TOOLS);
  const bus = new AgentEventBus();
  const fetch = stubFetch(opts.script ?? (() => textSse("ok")));

  const orchestrator = await AgentOrchestrator.start(
    {
      workspaceRoot: root,
      providerId: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      activeMode: opts.mode ?? "agent",
      modelAdapter: "openai-chat",
    } as never,
    registry as never,
    bus as never,
    async (req: any) => (opts.approve ? await opts.approve(req.toolName ?? req.toolCallId) : true),
    opts.effort ?? "low",
    new LocalJsonSessionStore(root) as never
  );

  return {
    root,
    registry,
    bus,
    fetch,
    orchestrator,
    cleanup() {
      fetch.restore();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* exit hook covers it */ }
    },
  };
}

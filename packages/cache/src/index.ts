/**
 * @inflynx/cache
 *
 * Thin Redis client wrapper used for:
 *   1. Token-bucket rate limiting of tool executions / model API calls
 *      (wired into `ToolExecutionGateway` and `BudgetManager`).
 *   2. A forward-compatible pub/sub backbone for `AgentEventBus`, so a future
 *      `apps/server` can broadcast the same session events to multiple
 *      subscribers without re-architecting the event bus.
 *
 * Design principle: Redis is an *optional* infrastructure dependency for the
 * CLI. If `REDIS_URL` is not set, or the connection fails, every method
 * here fails OPEN for rate limiting (never blocks a user because Redis is
 * down) and simply no-ops for pub/sub. This mirrors the local-dev fallback
 * philosophy used by `@inflynx/session-store` for Postgres.
 */

import { Redis } from "ioredis";

let sharedClient: Redis | null | undefined; // undefined = not yet attempted, null = disabled/unavailable
let warnedOpenOnce = false;

/**
 * Returns a shared ioredis client, or `null` if REDIS_URL is not configured.
 * Never throws.
 *
 * H10 (Phase 42): the old client set `retryStrategy: () => null`, so a Redis that came up *after*
 * the process started was never used, and a connection that dropped mid-run stayed dead forever
 * (the broken client was cached). Now ioredis keeps a bounded-backoff reconnection loop, and the
 * `end` handler clears the cache so the next call rebuilds — Redis appearing or recovering is
 * actually picked up.
 */
export function getRedisClient(): Redis | null {
  if (sharedClient !== undefined) return sharedClient;

  const url = process.env.REDIS_URL;
  if (!url) {
    sharedClient = null;
    return sharedClient;
  }

  try {
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      // Reconnect with capped backoff (was `() => null`, which never reconnected — H10).
      retryStrategy: (times: number) => Math.min(times * 100, 2000),
      lazyConnect: false,
      enableOfflineQueue: false,
    });
    client.on("error", () => {
      // Swallow — ioredis retries; callers treat a command rejection as "unavailable".
      // (ioredis requires an 'error' listener or it throws unhandled errors.)
    });
    client.on("end", () => {
      // Drop the cache so a later call can rebuild if the server comes back (H10).
      if (sharedClient === client) sharedClient = undefined;
    });
    sharedClient = client;
  } catch {
    sharedClient = null;
  }

  return sharedClient;
}

/** True when a Redis URL is configured (drives the default fail-open-vs-closed choice). */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the current window resets. */
  resetInSec: number;
  /** True when Redis was unavailable and the check fail-opened (allowed by default). */
  failedOpen: boolean;
  /** True when Redis was expected but the check failed and it fail-CLOSED (denied). */
  failedClosed?: boolean;
}

export interface RateLimitOptions {
  /** Fail CLOSED (deny) on a Redis command error — for the server, where the limiter is a control. */
  failClosed?: boolean;
  /** Injectable client so the atomicity/failure semantics are unit-testable without Redis. */
  client?: { eval?: (script: string, numKeys: number, ...args: any[]) => Promise<any>; ttl?: (k: string) => Promise<number> } | null;
}

/**
 * H5 (Phase 42): the counter bump and the TTL set must be ONE atomic step. The old
 * `INCR` then (only if count===1) `EXPIRE` was two round-trips — a crash between them left a
 * TTL-less key, so `count` kept climbing forever = permanent lockout. This Lua runs INCR+EXPIRE
 * +TTL in a single atomic EVAL, so a key is never created without its expiry.
 */
const ATOMIC_WINDOW_LUA =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
  "return { c, redis.call('TTL', KEYS[1]) }";

/**
 * Fixed-window rate limiter backed by an atomic Redis EVAL (INCR + first-write EXPIRE).
 *
 * @param key       Bucket key, e.g. `model:${sessionId}`
 * @param limit     Max operations within the window.
 * @param windowSec Window size in seconds.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number,
  opts: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const client = opts.client !== undefined ? opts.client : getRedisClient();

  if (!client) {
    // Redis not configured at all → the CLI / local-dev case: fail OPEN (never block a solo user
    // on missing infra), warned once.
    if (!warnedOpenOnce && isRedisConfigured() === false) {
      console.warn("[cache] REDIS_URL not set — rate limiting is INACTIVE (fail-open). Fine for the CLI; the server should configure Redis.");
      warnedOpenOnce = true;
    }
    return { allowed: true, remaining: limit, limit, resetInSec: windowSec, failedOpen: true };
  }

  try {
    const redisKey = `inflynx:ratelimit:${key}`;
    const res = await client.eval!(ATOMIC_WINDOW_LUA, 1, redisKey, String(windowSec));
    const count = Number(Array.isArray(res) ? res[0] : res);
    const ttl = Number(Array.isArray(res) ? res[1] : -1);
    const resetInSec = ttl > 0 ? ttl : windowSec;
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetInSec,
      failedOpen: false,
    };
  } catch {
    // Redis was expected but the command failed. The server treats the limiter as a control and
    // fails CLOSED (deny); the CLI fails open so a Redis blip never wedges a live session.
    if (opts.failClosed) {
      return { allowed: false, remaining: 0, limit, resetInSec: windowSec, failedOpen: false, failedClosed: true };
    }
    return { allowed: true, remaining: limit, limit, resetInSec: windowSec, failedOpen: true };
  }
}

/** Abort-aware sleep that removes its own listener (G9: a leaked 'abort' listener per retry). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface WaitOutOptions {
  budgetMs?: number;
  signal?: AbortSignal;
  /** Injectable sleep so the wait loop is unit-testable without real wall-clock time. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable RNG for deterministic jitter in tests. */
  random?: () => number;
}

/**
 * H6 (Phase 42): a model rate limit is a *pause*, not a failure. This waits out the window and
 * re-checks until the limiter allows a call, a total budget is spent, the caller aborts, or Redis
 * reports a fail-CLOSED control error (which waiting cannot fix). Returns the last result, so the
 * caller only fails the session if it is still not `allowed`. `sleepFn`/`random` are injectable so
 * the loop is deterministic offline; the bounded jitter stops N concurrent sessions from all
 * retrying on the exact reset second.
 */
export async function waitOutRateLimit(
  recheck: () => Promise<RateLimitResult>,
  opts: WaitOutOptions = {}
): Promise<RateLimitResult> {
  const budgetMs = opts.budgetMs ?? 90_000;
  const doSleep = opts.sleepFn ?? sleep;
  const random = opts.random ?? Math.random;
  const signal = opts.signal;

  let current = await recheck();
  const started = Date.now();
  while (!current.allowed && !current.failedClosed && !signal?.aborted && Date.now() - started < budgetMs) {
    const waitSec = Math.max(1, current.resetInSec || 5);
    const remain = Math.max(0, budgetMs - (Date.now() - started));
    const base = Math.min(waitSec * 1000, remain);
    const jitter = Math.floor(random() * Math.min(500, base || 1));
    await doSleep(base + jitter, signal);
    current = await recheck();
  }
  return current;
}

/**
 * Publishes a JSON-serializable event on a Redis channel. No-ops silently if
 * Redis is unavailable. Intended for future multi-process event fan-out
 * (`apps/server`); the in-process `AgentEventBus` remains the source of truth
 * for CLI.
 */
export async function publishEvent(channel: string, payload: unknown): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.publish(channel, JSON.stringify(payload));
  } catch {
    // best-effort only
  }
}

export async function closeRedisClient(): Promise<void> {
  if (sharedClient) {
    try {
      await sharedClient.quit();
    } catch {
      // ignore
    }
  }
  sharedClient = undefined;
}

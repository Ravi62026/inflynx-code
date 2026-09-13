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

/**
 * Returns a shared ioredis client, or `null` if REDIS_URL is not configured
 * or the client failed to connect. Never throws.
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
      retryStrategy: () => null, // do not keep retrying forever — fail open quickly
      lazyConnect: false,
      enableOfflineQueue: false,
    });
    client.on("error", () => {
      // Swallow connection errors — callers treat a null/unavailable client as "fail open".
      // (ioredis requires an 'error' listener or it throws unhandled errors.)
    });
    sharedClient = client;
  } catch {
    sharedClient = null;
  }

  return sharedClient;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the current window resets. */
  resetInSec: number;
  /** True when Redis was unavailable and the check fail-opened. */
  failedOpen: boolean;
}

/**
 * Fixed-window token-bucket rate limiter backed by Redis INCR + EXPIRE.
 *
 * @param key       Unique bucket key, e.g. `ratelimit:tool:execute_shell:${sessionId}`
 * @param limit     Max allowed operations within the window.
 * @param windowSec Window size in seconds.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  const client = getRedisClient();

  if (!client) {
    // Redis not configured/available — fail open so local single-user CLI
    // usage is never blocked by missing infrastructure.
    return { allowed: true, remaining: limit, limit, resetInSec: windowSec, failedOpen: true };
  }

  try {
    const redisKey = `inflynx:ratelimit:${key}`;
    const count = await client.incr(redisKey);
    if (count === 1) {
      await client.expire(redisKey, windowSec);
    }
    const ttl = await client.ttl(redisKey);
    const resetInSec = ttl > 0 ? ttl : windowSec;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetInSec,
      failedOpen: false,
    };
  } catch {
    return { allowed: true, remaining: limit, limit, resetInSec: windowSec, failedOpen: true };
  }
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

/**
 * CLI auth client — the device-authorization flow (RFC 8628 client) + local token store.
 *
 * Deliberately transport-only and dependency-injected (`fetch`, sleep, a token-store path) so it is
 * unit-testable against a fake server with no network. The token is stored under the same ~/.inflynx
 * home the credential store uses (respects INFLYNX_CONFIG_HOME for tests), mode 0600. The CLI only
 * *presents* this token to the backend; whether the backend enforces it is `INFLYNX_AUTH_ENFORCED`,
 * default-off — so the local BYOK flow is unchanged until login is turned on for real.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface StoredToken {
  accessToken: string;
  savedAt: number;
}

function authFilePath(): string {
  const home = process.env.INFLYNX_CONFIG_HOME || path.join(homedir(), ".inflynx");
  return path.join(home, "auth.json");
}

export function saveToken(token: string): void {
  const file = authFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ accessToken: token, savedAt: Date.now() }), { mode: 0o600 });
}

export function loadToken(): string | null {
  try {
    const file = authFilePath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.accessToken === "string" ? parsed.accessToken : null;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  try { rmSync(authFilePath(), { force: true }); } catch { /* already gone */ }
}

export interface LoginDeps {
  baseUrl: string;
  fetch: typeof fetch;
  /** Opens the browser; injected so tests don't spawn one. */
  open?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock so the expiry path is testable without waiting in real time. */
  now?: () => number;
  /** Poll interval floor (ms) so tests run fast; production uses the server's `interval`. */
  minIntervalMs?: number;
}

export type LoginResult =
  | { ok: true; accessToken: string; userCode: string }
  | { ok: false; error: string };

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the whole device flow: request a code, show the user the URL + code, open the browser, then
 * poll until the user approves (or the code expires). On success the token is persisted and returned.
 */
export async function runDeviceLogin(deps: LoginDeps): Promise<LoginResult> {
  const doSleep = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const base = deps.baseUrl.replace(/\/+$/, "");
  let start: DeviceStart;
  try {
    const res = await deps.fetch(`${base}/auth/device/start`, { method: "POST" });
    if (!res.ok) return { ok: false, error: `login start failed (HTTP ${res.status})` };
    start = (await res.json()) as DeviceStart;
  } catch (e) {
    return { ok: false, error: `cannot reach ${base}: ${(e as Error).message}` };
  }

  await deps.open?.(start.verification_uri_complete);

  const deadline = now() + (start.expires_in || 600) * 1000;
  const intervalMs = Math.max(deps.minIntervalMs ?? 0, (start.interval || 5) * 1000);
  while (now() < deadline) {
    await doSleep(intervalMs);
    let res: Response;
    try {
      res = await deps.fetch(`${base}/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
      });
    } catch (e) {
      return { ok: false, error: `poll failed: ${(e as Error).message}` };
    }
    const payload = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (res.ok && payload.access_token) {
      saveToken(payload.access_token);
      return { ok: true, accessToken: payload.access_token, userCode: start.user_code };
    }
    if (payload.error === "authorization_pending") continue; // keep polling
    if (payload.error === "slow_down") { await doSleep(intervalMs); continue; }
    return { ok: false, error: payload.error || `token exchange failed (HTTP ${res.status})` };
  }
  return { ok: false, error: "code_expired" };
}

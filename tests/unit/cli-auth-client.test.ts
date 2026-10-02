/**
 * Phase 4 CLI auth client — device flow + token store, against a fake fetch (no network, no server).
 * Confirms the poll/authorization_pending loop, that a granted token is persisted (0600) + reloaded,
 * and the failure paths (start fails, code expires, slow_down then success).
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDeviceLogin, loadToken, clearToken, saveToken } from "../../apps/cli/src/auth-client.js";
import { cleanupOnExit } from "../helpers/tmp.js";

console.log("=== cli auth client ===");

// point the token store at a temp dir
const home = cleanupOnExit(fs.mkdtempSync(path.join(os.tmpdir(), "cliauth-")));
process.env.INFLYNX_CONFIG_HOME = home;

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, async json() { return body; } }) as unknown as Response;

function fakeFetch(script: Array<() => Response | Promise<Response>> | ((url: string, n: number) => Response)) {
  let n = 0;
  return (async (_url: string, _init?: RequestInit) => {
    const r = typeof script === "function" ? script(String(_url), n++) : script[n++]();
    return r;
  }) as unknown as typeof fetch;
}
const start = (over = {}) => json({ device_code: "d1", user_code: "ABCD-1234", verification_uri_complete: "https://app/activate?user_code=ABCD-1234", expires_in: 300, interval: 0, ...over });

async function main() {
  // 1 --- pending, then approved → token saved + reloadable.
  {
    clearToken();
    const f = fakeFetch([() => start(), () => json({ error: "authorization_pending" }, false, 400), () => json({ access_token: "tok-abc" })]);
    const r = await runDeviceLogin({ baseUrl: "https://api.test", fetch: f, sleep: async () => {} });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.accessToken, "tok-abc");
    assert.equal(loadToken(), "tok-abc", "token persisted");
    const st = fs.statSync(path.join(home, "auth.json"));
    assert.equal(st.mode & 0o777, 0o600, "auth.json is 0600");
    console.log("  ✓ device flow: pending -> approved, token saved 0600 + reloaded");
  }
  // 2 --- start fails cleanly.
  {
    const f = fakeFetch([() => json({ error: "boom" }, false, 500)]);
    const r = await runDeviceLogin({ baseUrl: "https://api.test", fetch: f, sleep: async () => {} });
    assert.equal(r.ok, false);
    console.log("  ✓ failed start -> ok:false (no throw)");
  }
  // 3 --- expiry: a short TTL (2s) with an advancing clock reaches code_expired.
  {
    let clock = 0;
    const f = fakeFetch((url) =>
      url.endsWith("/start") ? start({ expires_in: 2, interval: 1 }) : json({ error: "authorization_pending" }, false, 400));
    const r = await runDeviceLogin({
      baseUrl: "https://api.test",
      fetch: f,
      sleep: async () => { clock += 1000; },
      now: () => clock,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "code_expired");
    console.log("  ✓ expired grant -> code_expired");
  }
  // 4 --- slow_down then success.
  {
    const f = fakeFetch([() => start(), () => json({ error: "slow_down" }, false, 400), () => json({ access_token: "tok-2" })]);
    const r = await runDeviceLogin({ baseUrl: "https://api.test", fetch: f, sleep: async () => {} });
    assert.equal(r.ok, true);
    console.log("  ✓ slow_down handled, then token");
  }
  // 5 --- saveToken/loadToken/clearToken round trip.
  {
    saveToken("manual");
    assert.equal(loadToken(), "manual");
    clearToken();
    assert.equal(loadToken(), null);
    console.log("  ✓ token store save/load/clear");
  }

  console.log("\n=== cli auth client results:", 0, "failures ===");
  process.exit(0);
}
main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

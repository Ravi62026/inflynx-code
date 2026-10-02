/**
 * Phase 1 (auth foundation) — offline checks.
 *
 * The credit/identity SQL only runs against real Postgres (see the CI-gated integration test);
 * this file checks the parts that must hold without a DB: the migration is registered and names
 * the tables + the anti-abuse columns, the Postgres store exposes the identity/credit methods, and
 * the local fallback correctly does NOT (callers feature-detect, per the optional interface).
 */
import { strict as assert } from "node:assert";
import { MIGRATIONS } from "../../packages/session-store/src/migrations.js";
import { PostgresSessionStore } from "../../packages/session-store/src/PostgresSessionStore.js";
import { LocalJsonSessionStore } from "../../packages/session-store/src/LocalJsonSessionStore.js";
import * as os from "node:os";
import * as path from "node:path";

console.log("=== auth foundation (offline) ===");

// 1 --- the auth migration exists + declares every table and the anti-abuse signals.
{
  const m = MIGRATIONS.find((x) => x.id === "0005_auth_users_credits");
  assert.ok(m, "0005_auth_users_credits migration must be present");
  for (const t of ["CREATE TABLE IF NOT EXISTS users", "credit_ledger", "account_links", "signup_attempts", "device_codes"]) {
    assert.ok(m!.sql.includes(t), `migration missing ${t}`);
  }
  // The abuse-control columns the plan depends on.
  for (const col of ["signup_ip", "last_ip", "device_fingerprint", "flagged", "credits"]) {
    assert.ok(m!.sql.includes(col), `users table missing anti-abuse/credit column ${col}`);
  }
  // user_id wired onto sessions + the legacy backfill so historical rows are not orphaned.
  assert.ok(m!.sql.includes("ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS user_id"));
  assert.ok(m!.sql.includes("'00000000-0000-0000-0000-000000000000'"), "must create/backfill the synthetic legacy user");
  console.log("  ✓ migration: users/credit_ledger/account_links/signup_attempts/device_codes + session user_id");
}

// 2 --- the Postgres store exposes the identity/credit surface.
{
  // Constructor requires a string but does not connect; we only assert the methods exist.
  const store = new PostgresSessionStore("postgresql://nope/nope");
  const anyStore = store as any;
  for (const fn of ["createUser", "getUser", "getUserBySubject", "listSessionsByUser", "grantCredits", "debitCredits", "recordSignupAttempt", "countSignupSignals", "markUserFlagged", "setUserDisabled"]) {
    assert.equal(typeof anyStore[fn], "function", `PostgresSessionStore.${fn} must be implemented`);
  }
  await anyStore.close?.();
  console.log("  ✓ PostgresSessionStore implements createUser/debit/grant/list-by-user/signup-signals");
}

// 3 --- the local JSON dev fallback deliberately does NOT implement auth (optional interface).
{
  const local = new LocalJsonSessionStore(path.join(os.tmpdir(), `auth-offline-${Date.now()}`));
  assert.equal((local as any).createUser, undefined, "LocalJson must not pretend to do identity");
  assert.equal((local as any).debitCredits, undefined);
  console.log("  ✓ LocalJsonSessionStore leaves identity methods undefined (callers feature-detect)");
}

console.log("\n=== auth foundation results:", 0, "failures ===");
process.exit(0);

/**
 * Portal auth glue for the device-approve flow. Deliberately uses only the framework-agnostic
 * `window.Clerk` global (which the Clerk React SDK *or* a clerk-js script tag sets) instead of
 * importing `@clerk/clerk-react`. Why: (a) the marketing portal keeps building green with no Clerk
 * dependency / lockfile churn, exactly like the backend's ambient Clerk seam; (b) hooks-free, so this
 * page needs no `ClerkProvider` wrapper. Once any Clerk client is loaded, `window.Clerk` appears and
 * this page starts working with zero code change. If Clerk is absent, callers get null and show a
 * "sign-in not active" state — never a crash, never a fake success.
 */

/** Backend origin the CLI/device endpoints live on. Falls back to the local server. */
export function getApiBase() {
  return (import.meta.env.VITE_INFLYNX_API_URL || 'http://localhost:4000').replace(/\/+$/, '')
}

/** Is a Clerk client actually loaded in this browser right now? */
export function clerkLoaded() {
  return typeof window !== 'undefined' && !!window.Clerk
}

/**
 * A stable per-browser device fingerprint for the abuse signal — a random uuid persisted in
 * localStorage. Best-effort: if storage is unavailable we return null and the backend simply counts
 * that signup without a fingerprint (fail-soft, never blocks login).
 */
export function getDeviceFingerprint() {
  try {
    const KEY = 'inflynx.device_id'
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return null
  }
}

/** Session token for our backend, or null if signed out / Clerk not loaded. */
export async function getSessionToken() {
  if (!clerkLoaded() || !window.Clerk.session) return null
  try {
    return (await window.Clerk.session.getToken({ skipCache: true })) || null
  } catch {
    return null
  }
}

/** Open Clerk's sign-in modal (only meaningful once Clerk is loaded). */
export function openSignIn() {
  if (clerkLoaded() && window.Clerk.openSignIn) window.Clerk.openSignIn()
}

export function currentUserSummary() {
  const u = clerkLoaded() ? window.Clerk.user : null
  if (!u) return null
  return { name: u.fullName || u.primaryEmailAddress?.emailAddress || u.username || 'Signed in', email: u.primaryEmailAddress?.emailAddress || null }
}

/**
 * POST an approve for `userCode` to the backend, presenting the Clerk session token. The backend
 * maps that identity to a user and marks the device code; the CLI's poll then completes. Denying is
 * purely local (the code simply expires unapproved) — there is no deny endpoint, so we never call one.
 * Returns { ok, status, body }.
 */
export async function approveDeviceCode({ userCode, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${getApiBase()}/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ user_code: userCode, device_fingerprint: getDeviceFingerprint() }),
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
}

/**
 * The single identity seam. Everything else in the backend consumes `VerifyIdentity`; only this
 * file knows Clerk exists. Verification reads `CLERK_SECRET_KEY` at call time, so the code ships
 * now and the ONLY remaining step is pasting the key — no rework. `@clerk/backend` is dynamically
 * imported and ambient-declared (see auth/clerk.d.ts) so the repo typechecks/builds before it is
 * installed; the import resolves at runtime once the dep + key are present.
 */
export interface IdentityPrincipal {
  authProvider: string;
  authSubject: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export type VerifyIdentity = (bearerSessionToken: string) => Promise<IdentityPrincipal | null>;

export const verifyClerkIdentity: VerifyIdentity = async (bearer) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is not set — cannot verify the sign-in session. Add it to .env.");
  }
  if (!bearer) return null;
  const { verifyToken } = await import("@clerk/backend");
  const claims = (await verifyToken(bearer, { secretKey })) as any;
  if (!claims?.sub) return null;
  const email =
    (Array.isArray(claims.email_addresses) && claims.email_addresses[0]?.email_address) ||
    (typeof claims.email === "string" ? claims.email : null) ||
    null;
  return {
    authProvider: "clerk",
    authSubject: String(claims.sub),
    email: email ?? null,
    displayName: claims.name ?? null,
    avatarUrl: claims.picture ?? null,
  };
};

/** Chosen by env so a future self-hosted provider is a new branch here, not a rewrite. */
export function getIdentityVerifier(): VerifyIdentity {
  const provider = (process.env.AUTH_PROVIDER || "clerk").trim().toLowerCase();
  if (provider === "clerk") return verifyClerkIdentity;
  throw new Error(`Unsupported AUTH_PROVIDER "${provider}" (only "clerk" is wired).`);
}

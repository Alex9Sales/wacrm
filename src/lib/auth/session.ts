// ============================================================
// Session resolution — Phase 1 TEMPORARY stub.
//
// The Supabase auth session was removed along with RLS. Better Auth
// lands in Phase 2 and replaces the body of `getSessionUserId()`
// with a real cookie-session lookup; every caller keeps its shape.
//
// Until then, dev runs authenticate as a fixed seed user:
//   DEV_SEED_USER_ID must be set in .env.local (see scripts/seed-dev.ts,
//   which prints it after seeding). Missing var = 401 everywhere,
//   which is the correct failure mode outside dev.
// ============================================================

/**
 * Resolve the calling user's id from the request session.
 * Returns null when unauthenticated.
 *
 * PHASE 2: replace the body with Better Auth's `auth.api.getSession()`.
 */
export async function getSessionUserId(): Promise<string | null> {
  if (process.env.NODE_ENV === "production" && !process.env.DEV_AUTH_ALLOW) {
    // Hard stop: the stub must never authenticate anyone in prod.
    return null;
  }
  return process.env.DEV_SEED_USER_ID ?? null;
}

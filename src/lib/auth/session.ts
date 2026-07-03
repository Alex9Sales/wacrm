// ============================================================
// Session resolution — Better Auth (Phase 2).
//
// `getSessionUserId()` reads the caller's user id from the Better
// Auth cookie session. The Phase-1 dev fallback survives as a
// SECONDARY path: when there's no real session AND DEV_SEED_USER_ID
// is set AND we're not in production, it returns the seed user so
// existing dev flows / tests keep working. In prod the fallback is
// off unless DEV_AUTH_ALLOW is explicitly set (it never should be).
// ============================================================

import { headers } from "next/headers";

import { auth } from "@/lib/auth";

/**
 * Resolve the calling user's id from the request session.
 * Returns null when unauthenticated.
 */
export async function getSessionUserId(): Promise<string | null> {
  // Primary: real Better Auth cookie session.
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (session?.user?.id) {
      return session.user.id;
    }
  } catch (err) {
    // getSession can throw outside a request scope (e.g. some test
    // harnesses). Fall through to the dev fallback rather than 500.
    console.error("[getSessionUserId] getSession failed:", err);
  }

  // Secondary (dev only): seed-user fallback so pre-login dev flows
  // and tests keep authenticating. Hard-off in prod unless explicitly
  // allowed.
  if (process.env.NODE_ENV === "production" && !process.env.DEV_AUTH_ALLOW) {
    return null;
  }
  return process.env.DEV_SEED_USER_ID ?? null;
}

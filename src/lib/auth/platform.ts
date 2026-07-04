// ============================================================
// Platform-admin gate — the super-admin (SaaS operator) layer
// (Phase 8). This is ABOVE org tenancy: a platform admin (Alex /
// Fluxia) is NOT an org role (owner/admin/agent/viewer). Access is
// gated by an env allowlist of emails — there is no UI to grant it.
//
//   isPlatformAdmin(email)    — pure allowlist check.
//   requirePlatformAdmin()    — resolves the session + user email,
//                               throws Unauthorized/Forbidden.
//
// /admin pages and /api/admin/* routes MUST call requirePlatformAdmin
// server-side (middleware only checks the session cookie — it can't
// read the DB or the allowlist reliably at the edge).
// ============================================================

import { eq } from "drizzle-orm";

import { db, user } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { getSessionUserId } from "./session";
import { UnauthorizedError, ForbiddenError } from "./account";

/**
 * Parse `PLATFORM_ADMIN_EMAILS` into a normalized Set (lowercased,
 * trimmed, empties dropped). Read fresh each call so tests / rotations
 * don't need a process restart.
 */
function allowlist(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/**
 * Is `email` on the platform-admin allowlist? Case-insensitive,
 * whitespace-trimmed. Null/undefined/empty → false.
 */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowlist().has(email.trim().toLowerCase());
}

/** Resolved platform-admin identity. */
export interface PlatformAdminContext {
  userId: string;
  email: string;
}

/**
 * Resolve the caller and enforce platform-admin.
 *
 * Throws `UnauthorizedError` if there's no session, `ForbiddenError`
 * if the session's email isn't on the allowlist.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const userId = await getSessionUserId();
  if (!userId) {
    throw new UnauthorizedError();
  }

  const row = firstOrNull(
    await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
  );

  if (!row || !isPlatformAdmin(row.email)) {
    throw new ForbiddenError("Platform admin access required");
  }

  return { userId, email: row.email };
}

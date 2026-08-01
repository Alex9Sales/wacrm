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

import { eq, inArray, sql } from "drizzle-orm";

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

/** A platform admin resolved to a real user row (for the /admin "Responsável"
 *  picker). Only allowlisted emails that actually have a user account appear. */
export interface PlatformAdminUser {
  id: string;
  name: string;
  email: string;
}

/**
 * Every platform admin that has a real user account, resolved from the
 * `PLATFORM_ADMIN_EMAILS` allowlist. Used to populate the "Responsável"
 * dropdown and to validate reassignment. An allowlisted email with no user
 * row (never logged in) is simply omitted.
 */
export async function listPlatformAdmins(): Promise<PlatformAdminUser[]> {
  const emails = [...allowlist()];
  if (emails.length === 0) return [];
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(sql`lower(${user.email})`, emails));
  return rows.map((r) => ({ id: r.id, name: r.name ?? "", email: r.email }));
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

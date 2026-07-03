// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account and verifies
// role on demand.
//
// Post-Supabase: queries run through the shared Drizzle client
// (`@/db`) and the session comes from `@/lib/auth/session`
// (Phase 1 stub → Better Auth in Phase 2). There is no RLS —
// every downstream query MUST be scoped by `ctx.accountId`.
//
// Calling convention
// ------------------
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.userId / ctx.accountId / ctx.role / ctx.account
//     // queries: import { db } from "@/db"
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, accounts, profiles } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { getSessionUserId } from "./session";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Unknown errors collapse to 500 with the generic
 * message — we never leak `err.message` for non-classified errors.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** The calling user's id. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role.
 *
 * Throws `UnauthorizedError` if there's no session.
 * Throws `ForbiddenError` if the profile is missing account fields
 * (defensive guard against rows inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const userId = await getSessionUserId();
  if (!userId) {
    throw new UnauthorizedError();
  }

  const profile = firstOrNull(
    await db
      .select({
        accountId: profiles.accountId,
        accountRole: profiles.accountRole,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1),
  );

  if (!profile || !profile.accountId || !profile.accountRole) {
    // Profile missing or never linked to an account — the user is
    // authenticated but the app has no way to scope their queries.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(profile.accountRole)) {
    // The DB enum should make this impossible, but a future migration
    // that broadens the enum without updating TS would hit this —
    // surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${profile.accountRole}`);
  }

  const account = firstOrNull(
    await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId))
      .limit(1),
  );

  if (!account) {
    // account_id points at no account row — orphaned profile.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  return {
    userId,
    accountId: profile.accountId,
    role: profile.accountRole,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}

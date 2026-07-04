// ============================================================
// GET /api/me — the current session's profile + account summary.
//
// Client code can't touch the DB (Drizzle/pg is server-only), so the
// auth context is hydrated from this endpoint. Post-Better-Auth the
// "profile" is synthesised from the Better Auth `user` row + the
// caller's active-organization membership; the `account` is the
// active `organization` row.
//
// Response (snake_case — matches use-auth's Profile/AccountSummary):
//   { profile: { id, full_name, email, avatar_url, role,
//                beta_features, account_id, account_role,
//                is_platform_admin, suspended },
//     account: { id, name, default_currency } | null }
// 401 when unauthenticated.
//
// Phase 8: `is_platform_admin` gates the /admin link in the header;
// `suspended` (true when the active org's billing is 'suspended') lets
// the dashboard show a friendly "conta suspensa" screen instead of a
// broken page (getCurrentAccount throws AccountSuspendedError there).
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, user as userTable } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { getSessionUserId } from "@/lib/auth/session";
import {
  getCurrentAccount,
  UnauthorizedError,
  ForbiddenError,
  AccountSuspendedError,
} from "@/lib/auth/account";
import { isPlatformAdmin } from "@/lib/auth/platform";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userRow = firstOrNull(
    await db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
      })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1),
  );

  if (!userRow) {
    // Authenticated id with no user row — treat as signed-out-ish.
    return NextResponse.json({ profile: null, account: null });
  }

  // Resolve the active organization + role. A user with no org
  // membership is authenticated but not yet scoped — return the
  // profile with null account fields rather than erroring.
  let accountId: string | null = null;
  let accountRole: string | null = null;
  let account: { id: string; name: string; default_currency: string } | null =
    null;
  // Phase 8: true when the active org's billing is 'suspended'. The
  // dashboard uses this to render a friendly full-page suspended screen.
  let suspended = false;

  try {
    const ctx = await getCurrentAccount();
    accountId = ctx.accountId;
    accountRole = ctx.role;
    account = {
      id: ctx.account.id,
      name: ctx.account.name,
      default_currency: ctx.defaultCurrency ?? "USD",
    };
  } catch (err) {
    if (err instanceof AccountSuspendedError) {
      // Authenticated but the org is suspended — flag it so the client
      // shows the "conta suspensa" screen. Account fields stay null.
      suspended = true;
    } else if (
      !(err instanceof ForbiddenError || err instanceof UnauthorizedError)
    ) {
      throw err;
    }
    // No active org / membership — leave account fields null.
  }

  const profile = {
    id: userRow.id,
    full_name: userRow.name,
    email: userRow.email,
    avatar_url: userRow.image,
    role: "user" as const,
    beta_features: [] as string[],
    account_id: accountId,
    account_role: accountRole,
    // Phase 8 super-admin: gates the /admin link in the header.
    is_platform_admin: isPlatformAdmin(userRow.email),
    // Phase 8 suspension: drives the dashboard's suspended screen.
    suspended,
  };

  return NextResponse.json({ profile, account });
}

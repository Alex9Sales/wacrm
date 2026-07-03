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
//                beta_features, account_id, account_role },
//     account: { id, name, default_currency } | null }
// 401 when unauthenticated.
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
} from "@/lib/auth/account";

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
    if (!(err instanceof ForbiddenError || err instanceof UnauthorizedError)) {
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
  };

  return NextResponse.json({ profile, account });
}

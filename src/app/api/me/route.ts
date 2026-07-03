// ============================================================
// GET /api/me — the current session's profile + account summary.
//
// Replaces the browser Supabase reads that use-auth.tsx used to do
// directly. Client code can't touch the DB anymore (Drizzle/pg is
// server-only), so the auth context is hydrated from this endpoint.
//
// Response (snake_case — matches use-auth's Profile/AccountSummary):
//   { profile: { id, full_name, email, avatar_url, role,
//                beta_features, account_id, account_role },
//     account: { id, name, default_currency } | null }
// 401 when unauthenticated.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, accounts, profiles } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { getSessionUserId } from "@/lib/auth/session";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = firstOrNull(
    await db
      .select({
        id: profiles.id,
        full_name: profiles.fullName,
        email: profiles.email,
        avatar_url: profiles.avatarUrl,
        role: profiles.role,
        beta_features: profiles.betaFeatures,
        account_id: profiles.accountId,
        account_role: profiles.accountRole,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1),
  );

  if (!profile) {
    // Authenticated but no profile row — client treats this as a
    // signed-out-ish state (least-privileged), same as before.
    return NextResponse.json({ profile: null, account: null });
  }

  const account = firstOrNull(
    await db
      .select({
        id: accounts.id,
        name: accounts.name,
        default_currency: accounts.defaultCurrency,
      })
      .from(accounts)
      .where(eq(accounts.id, profile.account_id))
      .limit(1),
  );

  return NextResponse.json({ profile, account });
}

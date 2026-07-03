// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db, profiles } from "@/db";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // No RLS anymore — the account scope is the explicit filter below.
    let data;
    try {
      data = await db
        .select({
          user_id: profiles.userId,
          full_name: profiles.fullName,
          email: profiles.email,
          avatar_url: profiles.avatarUrl,
          account_role: profiles.accountRole,
          created_at: profiles.createdAt,
        })
        .from(profiles)
        .where(eq(profiles.accountId, ctx.accountId))
        .orderBy(asc(profiles.createdAt));
    } catch (err) {
      console.error("[GET /api/account/members] fetch error:", err);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = data.flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at ?? "",
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

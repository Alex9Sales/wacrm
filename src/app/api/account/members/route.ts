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

import { db, member, user, memberTags, tags } from "@/db";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

interface TagLite {
  id: string;
  name: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // No RLS anymore — the account scope is the explicit filter below.
    let data;
    try {
      data = await db
        .select({
          user_id: member.userId,
          full_name: user.name,
          email: user.email,
          avatar_url: user.image,
          account_role: member.role,
          created_at: member.createdAt,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, ctx.accountId))
        .orderBy(asc(member.createdAt));
    } catch (err) {
      console.error("[GET /api/account/members] fetch error:", err);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    // Etiquetas no atendente (Fase B) — só quem administra membros vê/edita.
    const tagsByUser: Record<string, TagLite[]> = {};
    let accountTags: TagLite[] = [];
    if (canSeeEmails) {
      try {
        const mtRows = await db
          .select({ userId: member.userId, id: tags.id, name: tags.name })
          .from(memberTags)
          .innerJoin(member, eq(member.id, memberTags.memberId))
          .innerJoin(tags, eq(tags.id, memberTags.tagId))
          .where(eq(member.organizationId, ctx.accountId));
        for (const r of mtRows) {
          (tagsByUser[r.userId] ??= []).push({ id: r.id, name: r.name });
        }
        accountTags = await db
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(eq(tags.accountId, ctx.accountId))
          .orderBy(asc(tags.name));
      } catch (err) {
        console.error("[GET /api/account/members] tags fetch error:", err);
      }
    }

    const members: (AccountMember & { tags: TagLite[] })[] = data.flatMap((row) => {
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
          tags: tagsByUser[row.user_id] ?? [],
        },
      ];
    });

    return NextResponse.json({ members, account_tags: accountTags });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// POST /api/account/transfer-ownership
//
// Owner-only. Hands the account to another member: the target is
// promoted to `owner` and the current owner is demoted to `admin`.
//
// Better Auth's organization plugin exposes no dedicated transfer
// endpoint, so we implement it as two `updateMemberRole` calls
// (promote target → owner, demote caller → admin). Body:
//   { user_id: string }  — the target member's user id.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, member } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { auth } from "@/lib/auth";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

async function resolveMemberId(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
      )
      .limit(1),
  );
  return row?.id ?? null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const targetUserId = (body as { user_id?: unknown })?.user_id;
    if (typeof targetUserId !== "string" || !targetUserId) {
      return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    }
    if (targetUserId === ctx.userId) {
      return NextResponse.json(
        { error: "Cannot transfer ownership to yourself" },
        { status: 400 },
      );
    }

    const targetMemberId = await resolveMemberId(targetUserId, ctx.accountId);
    if (!targetMemberId) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const callerMemberId = await resolveMemberId(ctx.userId, ctx.accountId);
    if (!callerMemberId) {
      return NextResponse.json(
        { error: "Current owner membership not found" },
        { status: 404 },
      );
    }

    // Promote the target to owner, then demote the current owner.
    await auth.api.updateMemberRole({
      body: {
        memberId: targetMemberId,
        role: "owner",
        organizationId: ctx.accountId,
      },
      headers: request.headers,
    });
    await auth.api.updateMemberRole({
      body: {
        memberId: callerMemberId,
        role: "admin",
        organizationId: ctx.accountId,
      },
      headers: request.headers,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

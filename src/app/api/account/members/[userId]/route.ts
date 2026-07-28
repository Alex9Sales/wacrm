// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Reimplemented on Better Auth organizations (Phase 2).
//   PATCH  → auth.api.updateMemberRole({ body: { memberId, role } })
//   DELETE → auth.api.removeMember({ body: { memberIdOrEmail } })
//
// The route is keyed by `user_id`, but Better Auth's member
// endpoints key on the `member` row id, so we resolve the target
// user's membership in the caller's active organization first.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, member } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { auth } from "@/lib/auth";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole, hasMinRole } from "@/lib/auth/roles";

/**
 * Resolve the `member` row id for a given user within an org.
 * Returns null when the user is not a member of that org.
 */
async function resolveMember(
  userId: string,
  organizationId: string,
): Promise<{ id: string; role: string } | null> {
  const row = firstOrNull(
    await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(
        and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
      )
      .limit(1),
  );
  return row ?? null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("supervisor");
    const { userId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const role = (body as { role?: unknown })?.role;
    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "Invalid role" },
        { status: 400 },
      );
    }

    const target = await resolveMember(userId, ctx.accountId);
    if (!target) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Only admin+ may touch elevated roles — a supervisor can't promote to
    // admin/supervisor nor demote an existing admin/owner (privilege escalation).
    const callerIsAdmin = hasMinRole(ctx.role, "admin");
    const touchesElevated =
      role === "admin" ||
      role === "owner" ||
      role === "supervisor" ||
      target.role === "admin" ||
      target.role === "owner";
    if (touchesElevated && !callerIsAdmin) {
      return NextResponse.json(
        { error: "Só um admin pode alterar papéis de admin/supervisor." },
        { status: 403 },
      );
    }

    const result = await auth.api.updateMemberRole({
      body: { memberId: target.id, role, organizationId: ctx.accountId },
      headers: request.headers,
    });

    return NextResponse.json({ member: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("supervisor");
    const { userId } = await context.params;

    const target = await resolveMember(userId, ctx.accountId);
    if (!target) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // A supervisor may remove agents/viewers/supervisors but not an admin/owner.
    if (
      (target.role === "admin" || target.role === "owner") &&
      !hasMinRole(ctx.role, "admin")
    ) {
      return NextResponse.json(
        { error: "Só um admin pode remover um admin." },
        { status: 403 },
      );
    }

    await auth.api.removeMember({
      body: { memberIdOrEmail: target.id, organizationId: ctx.accountId },
      headers: request.headers,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

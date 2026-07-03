// ============================================================
// GET /api/invitations/[token]/peek
//
// PUBLIC — no session required. Returns just enough invitation
// metadata for the /join page to render (org name, invited email,
// role, status, expiry).
//
// `token` = the Better Auth invitation id.
//
// Better Auth's `auth.api.getInvitation` requires a session AND that
// the caller be the invitation recipient, so it can't serve a public
// peek. We read the `invitation` row (joined to `organization`)
// directly and expose only non-sensitive fields.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, invitation, organization } from "@/db";
import { firstOrNull } from "@/db/helpers";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;

    const row = firstOrNull(
      await db
        .select({
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          organizationName: organization.name,
        })
        .from(invitation)
        .innerJoin(
          organization,
          eq(invitation.organizationId, organization.id),
        )
        .where(eq(invitation.id, token))
        .limit(1),
    );

    if (!row) {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      invitation: {
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: row.expiresAt,
        organizationName: row.organizationName,
      },
    });
  } catch (err) {
    console.error("[GET /api/invitations/[token]/peek] error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

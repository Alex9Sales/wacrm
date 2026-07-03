// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (pending) invites.  Any member.
//   POST — create a new invite.                 Admin+.
//
// Reimplemented on Better Auth organizations (Phase 2).
//   GET  → auth.api.listInvitations()   (scoped to active org)
//   POST → auth.api.createInvitation({ body: { email, role } })
//
// The invitation email link is logged to the console in dev by the
// `sendInvitationEmail` hook in src/lib/auth.ts — we do not resend.
// ============================================================

import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";

export async function GET() {
  try {
    // Any member may view the roster of pending invites.
    await getCurrentAccount();

    const invitations = await auth.api.listInvitations({
      headers: await headers(),
    });

    // Only surface still-actionable invites.
    const pending = (invitations ?? []).filter(
      (inv) => inv.status === "pending",
    );

    return NextResponse.json({ invitations: pending });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireRole("admin");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const email = (body as { email?: unknown })?.email;
    const role = (body as { role?: unknown })?.role;

    if (typeof email !== "string" || !email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }
    if (!isAccountRole(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const invitation = await auth.api.createInvitation({
      body: { email, role },
      headers: request.headers,
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

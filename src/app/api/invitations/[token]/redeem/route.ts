// ============================================================
// POST /api/invitations/[token]/redeem
//
// Requires a session. Accepts the invitation for the logged-in user
// (whose email must match the invite's recipient — enforced by
// Better Auth). `token` = the invitation id.
//
// Reimplemented on Better Auth organizations (Phase 2):
//   auth.api.acceptInvitation({ body: { invitationId } })
// ============================================================

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const userId = await getSessionUserId();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { token } = await context.params;

    const result = await auth.api.acceptInvitation({
      body: { invitationId: token },
      headers: request.headers,
    });

    return NextResponse.json({
      member: result?.member ?? null,
      invitation: result?.invitation ?? null,
    });
  } catch (err) {
    console.error("[POST /api/invitations/[token]/redeem] error:", err);
    // Better Auth throws an APIError with a `.status` for known cases
    // (invitation not found / not the recipient). Surface a 400 for
    // those; anything else is a 500.
    const status =
      typeof (err as { statusCode?: number })?.statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 400;
    return NextResponse.json(
      { error: "Failed to accept invitation" },
      { status: status >= 400 && status < 600 ? status : 400 },
    );
  }
}

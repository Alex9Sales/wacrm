// ============================================================
// DELETE /api/account/invitations/[id]
//
// Revoke / cancel a pending invitation. Admin+.
//
// Reimplemented on Better Auth organizations (Phase 2):
//   auth.api.cancelInvitation({ body: { invitationId } })
// ============================================================

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole("admin");
    const { id } = await context.params;

    await auth.api.cancelInvitation({
      body: { invitationId: id },
      headers: request.headers,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// DELETE /api/account/invitations/[id]
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation deleted rows from the
// `account_invitations` table, which no longer exists in the
// Drizzle baseline (Better Auth organizations replaces the whole
// invitation flow in Phase 2). Returns 501 until then.
// ============================================================

import { NextResponse } from "next/server";

export async function DELETE(
  _request: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return NextResponse.json(
    { error: "Temporarily disabled during auth migration (Phase 2)" },
    { status: 501 },
  );
}

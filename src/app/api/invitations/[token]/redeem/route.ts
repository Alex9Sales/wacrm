// ============================================================
// POST /api/invitations/[token]/redeem
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation relied on the old auth session lookup
// and the SECURITY DEFINER RPC `redeem_invitation` (migration 019)
// against the `account_invitations` table; none of these exist in
// the Drizzle baseline (Better Auth organizations replaces the
// whole invitation flow in Phase 2). Returns 501 until then.
// ============================================================

import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  _context: { params: Promise<{ token: string }> },
) {
  return NextResponse.json(
    { error: "Temporarily disabled during auth migration (Phase 2)" },
    { status: 501 },
  );
}

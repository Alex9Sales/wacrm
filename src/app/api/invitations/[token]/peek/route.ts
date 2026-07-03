// ============================================================
// GET /api/invitations/[token]/peek
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation called the SECURITY DEFINER RPC
// `peek_invitation` against the `account_invitations` table;
// neither exists in the Drizzle baseline (Better Auth
// organizations replaces the whole invitation flow in Phase 2).
// Returns 501 until then.
// ============================================================

import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  _context: { params: Promise<{ token: string }> },
) {
  return NextResponse.json(
    { error: "Temporarily disabled during auth migration (Phase 2)" },
    { status: 501 },
  );
}

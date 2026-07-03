// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation delegated to the SECURITY DEFINER
// RPCs `set_member_role` / `remove_account_member` (Supabase
// migration 018), which no longer exist in the Drizzle baseline.
// Member management returns 501 until Better Auth organizations
// lands in Phase 2.
// ============================================================

import { NextResponse } from "next/server";

const DISABLED = {
  error: "Temporarily disabled during auth migration (Phase 2)",
} as const;

export async function PATCH(
  _request: Request,
  _context: { params: Promise<{ userId: string }> },
) {
  return NextResponse.json(DISABLED, { status: 501 });
}

export async function DELETE(
  _request: Request,
  _context: { params: Promise<{ userId: string }> },
) {
  return NextResponse.json(DISABLED, { status: 501 });
}

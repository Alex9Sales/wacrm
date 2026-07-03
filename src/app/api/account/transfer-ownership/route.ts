// ============================================================
// POST /api/account/transfer-ownership
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation delegated the atomic demote/promote/
// repoint to the SECURITY DEFINER RPC `transfer_account_ownership`
// (Supabase migration 018), which no longer exists in the Drizzle
// baseline. Ownership transfer returns 501 until Better Auth
// organizations lands in Phase 2.
// ============================================================

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Temporarily disabled during auth migration (Phase 2)" },
    { status: 501 },
  );
}

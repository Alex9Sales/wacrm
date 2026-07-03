// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (un-redeemed, non-expired) invites.
//   POST — create a new invite link.
//
// TODO(fase-2): reimplement on Better Auth organizations.
// The previous implementation read/wrote the `account_invitations`
// table, which no longer exists in the Drizzle baseline (Better
// Auth organizations replaces the whole invitation flow in
// Phase 2). Both verbs return 501 until then.
// ============================================================

import { NextResponse } from "next/server";

const DISABLED = {
  error: "Temporarily disabled during auth migration (Phase 2)",
} as const;

export async function GET() {
  return NextResponse.json(DISABLED, { status: 501 });
}

export async function POST() {
  return NextResponse.json(DISABLED, { status: 501 });
}

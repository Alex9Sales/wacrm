// ============================================================
// GET /api/admin/overview — status counters across all orgs (Phase 8).
//
// Platform-admin only (requirePlatformAdmin). Returns the ClientOverview
// shape { total, active, suspended, trial, overdue } for the /admin
// dashboard's overview cards.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getClientOverview } from "@/lib/admin/clients";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const overview = await getClientOverview();
    return NextResponse.json(overview);
  } catch (err) {
    return toErrorResponse(err);
  }
}

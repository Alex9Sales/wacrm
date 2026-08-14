// ============================================================
// GET /api/admin/support — setor Suporte do painel /admin.
//
// Platform-admin only (requirePlatformAdmin). Lê TODOS os chamados
// (across orgs) + org + autor, e os contadores por status em um round-trip.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { listAllTickets, getSupportOverview } from "@/lib/support/queries";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const [tickets, overview] = await Promise.all([
      listAllTickets(),
      getSupportOverview(),
    ]);
    return NextResponse.json({ tickets, overview });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// GET /api/admin/clients/[orgId]/history — histórico de billing do cliente.
// Platform-admin only. Retorna os eventos (mais novos primeiro) pro modal.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { listBillingEvents } from "@/lib/admin/billing-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { orgId } = await params;
    const events = await listBillingEvents(orgId);
    return NextResponse.json({ events });
  } catch (err) {
    return toErrorResponse(err);
  }
}

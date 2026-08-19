// ============================================================
// POST /api/admin/clients/[orgId]/delete — exclui a conta (soft-delete).
// Platform-admin only. Body: { reason? }. Marca deleted_at, cancela a
// assinatura no Asaas e mantém o registro + histórico. Reversível (reactivate).
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, organization } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { deleteClient, LifecycleError } from "@/lib/admin/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const admin = await requirePlatformAdmin();
    const { orgId } = await params;

    const org = firstOrNull(
      await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1),
    );
    if (!org) {
      return NextResponse.json(
        { error: "Organização não encontrada." },
        { status: 404 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason =
      typeof body.reason === "string" ? body.reason.trim() || null : null;

    const result = await deleteClient(
      orgId,
      { userId: admin.userId, email: admin.email },
      { reason },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

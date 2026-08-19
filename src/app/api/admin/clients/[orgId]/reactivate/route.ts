// ============================================================
// POST /api/admin/clients/[orgId]/reactivate — reativa a conta.
// Platform-admin only. Restaura o acesso (status='active', limpa cancel_at e
// deleted_at). NÃO recria a assinatura no Asaas (o cliente reassina se precisar).
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, organization } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { reactivateClient, LifecycleError } from "@/lib/admin/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
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

    const result = await reactivateClient(orgId, {
      userId: admin.userId,
      email: admin.email,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

// ============================================================
// PATCH /api/admin/support/[id] — muda o status de um chamado (setor Suporte).
//
// Platform-admin only. Body: { status: 'open' | 'in_progress' | 'resolved' }.
// Chamado inexistente → 404.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, supportTickets } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { isSupportTicketStatus } from "@/lib/support/types";
import { serializeTicket } from "@/lib/support/queries";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      status?: unknown;
    };
    if (!isSupportTicketStatus(body.status)) {
      return NextResponse.json(
        {
          error:
            "status inválido (use 'open', 'in_progress' ou 'resolved').",
        },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const row = firstOrNull(
      await db
        .update(supportTickets)
        .set({ status: body.status, updatedAt: now })
        .where(eq(supportTickets.id, id))
        .returning(),
    );

    if (!row) {
      return NextResponse.json(
        { error: "Chamado não encontrado." },
        { status: 404 },
      );
    }

    return NextResponse.json({ ticket: serializeTicket(row) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

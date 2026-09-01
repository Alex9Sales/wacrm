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
import {
  isSupportTicketStatus,
  normalizeSupportWhatsapp,
} from "@/lib/support/types";
import { serializeTicket } from "@/lib/support/queries";
import { sendTicketResolvedToClient } from "@/lib/support/alert";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      status?: unknown;
      resolution_note?: unknown;
      whatsapp?: unknown;
    };
    // Chamado antigo (aberto antes do campo existir) pode receber o número
    // aqui, na hora de resolver — assim o cliente é avisado mesmo assim.
    const typedWhatsapp = normalizeSupportWhatsapp(body.whatsapp);
    const note =
      typeof body.resolution_note === "string"
        ? body.resolution_note.trim().slice(0, 600) || null
        : null;
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
    let row = firstOrNull(
      await db
        .update(supportTickets)
        .set({
          status: body.status,
          updatedAt: now,
          ...(note ? { resolutionNote: note } : {}),
          ...(typedWhatsapp ? { whatsapp: typedWhatsapp } : {}),
        })
        .where(eq(supportTickets.id, id))
        .returning(),
    );

    if (!row) {
      return NextResponse.json(
        { error: "Chamado não encontrado." },
        { status: 404 },
      );
    }

    // Resolveu → avisa o cliente no WhatsApp dele. Só uma vez (reabrir e
    // resolver de novo não dispara outra mensagem) e só se ele informou o
    // número. Best-effort: falhar aqui NÃO desfaz a resolução.
    let clientNotified: { sent: boolean; error?: string } | null = null;
    if (body.status === "resolved" && row.whatsapp && !row.clientNotifiedAt) {
      const ctx = (row.context ?? {}) as { userName?: string };
      clientNotified = await sendTicketResolvedToClient({
        to: row.whatsapp,
        subject: row.subject,
        clientName: ctx.userName ?? null,
        resolutionNote: note ?? row.resolutionNote ?? null,
      });
      if (clientNotified.sent) {
        row =
          firstOrNull(
            await db
              .update(supportTickets)
              .set({ clientNotifiedAt: new Date().toISOString() })
              .where(eq(supportTickets.id, id))
              .returning(),
          ) ?? row;
      }
    }

    return NextResponse.json({
      ticket: serializeTicket(row),
      clientNotified,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

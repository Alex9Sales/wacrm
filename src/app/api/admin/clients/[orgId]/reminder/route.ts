// ============================================================
// POST /api/admin/clients/[orgId]/reminder — WhatsApp billing reminder
// (Phase 8).
//
// Platform-admin only (requirePlatformAdmin). Sends a pt-BR billing
// reminder to the client's billing_phone using a FLUXIA-owned channel.
//
// The sending channel id comes from env PLATFORM_BILLING_CHANNEL_ID (a
// channel owned by Fluxia's own org). If unset → 400 with a clear
// message telling the operator to configure it. On success the billing
// row's last_reminder_at is bumped to now.
//
// Errors: no billing_phone → 400; env unset → 400; channel not found
// → 400. Everything else collapses via toErrorResponse.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, organization, organizationBilling } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { loadChannel } from "@/lib/channels/channels";
import { getProvider } from "@/lib/channels/registry";
import { enviarRegistrando } from "@/lib/billing/reminder-send";
import { brlSimples, daysUntil, diaBr } from "@/lib/billing/reminders";
import { firstNameForGreeting } from "@/lib/cdl/names";

/**
 * Compose the pt-BR billing reminder. Keeps it simple + friendly and
 * folds in the plan label + due date when available.
 */
function composeReminder(input: {
  orgName: string;
  plan: string | null;
  dueAt: string | null;
}): string {
  const planPart = input.plan ? ` do plano ${input.plan}` : "";
  let duePart = "";
  if (input.dueAt) {
    const d = new Date(input.dueAt);
    if (!Number.isNaN(d.getTime())) {
      // DD/MM/YYYY in pt-BR.
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = d.getUTCFullYear();
      duePart = ` vence em ${dd}/${mm}/${yyyy}`;
    }
  }
  return (
    `Olá! Aqui é da Fluxia. Passando para lembrar que a sua assinatura do CRM` +
    `${planPart}${duePart}.` +
    ` Para manter o acesso ativo, por favor regularize o pagamento.` +
    ` Qualquer dúvida, é só responder por aqui. Obrigado! 🙏`
  );
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { orgId } = await params;

    // Load the org + its billing satellite (name for the message,
    // billing_phone for the destination).
    const client = firstOrNull(
      await db
        .select({
          name: organization.name,
          billingPhone: organizationBilling.billingPhone,
          plan: organizationBilling.plan,
          dueAt: organizationBilling.dueAt,
          monthlyValue: organizationBilling.monthlyValue,
        })
        .from(organization)
        .leftJoin(
          organizationBilling,
          eq(organizationBilling.organizationId, organization.id),
        )
        .where(eq(organization.id, orgId))
        .limit(1),
    );

    if (!client) {
      return NextResponse.json(
        { error: "Organização não encontrada." },
        { status: 404 },
      );
    }

    const billingPhone = client.billingPhone?.trim();
    if (!billingPhone) {
      return NextResponse.json(
        {
          error:
            "Cliente sem telefone de cobrança (billing_phone). Cadastre um número para enviar o lembrete.",
        },
        { status: 400 },
      );
    }

    // The Fluxia-owned sending channel. Without it we cannot send.
    const platformChannelId = process.env.PLATFORM_BILLING_CHANNEL_ID?.trim();
    if (!platformChannelId) {
      return NextResponse.json(
        {
          error:
            "Configure PLATFORM_BILLING_CHANNEL_ID (canal da Fluxia) para enviar lembretes.",
        },
        { status: 400 },
      );
    }

    const channel = await loadChannel(platformChannelId);
    if (!channel) {
      return NextResponse.json(
        {
          error:
            "Canal da Fluxia (PLATFORM_BILLING_CHANNEL_ID) não encontrado. Verifique o id configurado.",
        },
        { status: 400 },
      );
    }

    const message = composeReminder({
      orgName: client.name,
      plan: client.plan,
      dueAt: client.dueAt,
    });

    // 29/09: vai pela CONVERSA, igual ao lembrete automático. Antes era
    // provider.sendText direto — a Meta aceitava, devolvia um id, e o id
    // morria ali: a mensagem não entrava no histórico do cliente e não havia
    // como responder "foi entregue?". enviarRegistrando cai para o envio
    // direto se o contato não puder ser criado, e diz no log qual caminho
    // usou. Lança em falha de verdade → 500 via toErrorResponse.
    const provider = getProvider(channel.provider);
    // 29/09: leva o template aprovado do degrau certo. Sem ele, fora da janela
    // de 24 h a Meta recusa — foi o que aconteceu no vencimento da Appia, que
    // nunca tinha conversado com o nosso número e por isso não tinha janela.
    // O degrau é escolhido pelo vencimento, como no automático.
    const dias = client.dueAt ? daysUntil(client.dueAt, new Date()) : NaN;
    const step = dias > 0 ? -5 : dias === 0 ? 0 : 3;
    const valor = Number(client.monthlyValue);
    const via = await enviarRegistrando(
      channel,
      provider,
      billingPhone,
      message,
      client.name,
      {
        step,
        params: [
          firstNameForGreeting(client.name) || client.name,
          Number.isFinite(valor) && valor > 0 ? brlSimples(valor) : 'a mensalidade',
          client.dueAt ? diaBr(client.dueAt) : '',
        ],
      },
    );
    console.log(`[admin/reminder] lembrete de "${client.name}" enviado · ${via}`);

    // Record the reminder timestamp (upsert-safe: the row exists because
    // billing_phone came from it).
    const now = new Date().toISOString();
    await db
      .update(organizationBilling)
      .set({ lastReminderAt: now, updatedAt: now })
      .where(eq(organizationBilling.organizationId, orgId));

    return NextResponse.json({ ok: true, lastReminderAt: now });
  } catch (err) {
    return toErrorResponse(err);
  }
}

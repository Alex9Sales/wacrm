// ============================================================
// Webhook do Asaas — confirmação de pagamento da assinatura do FluxiaCRM.
//   • POST — recebe o evento; se for pagamento confirmado, vira o billing da
//            org pra status='active' (some a tela de "trial acabou").
//   • GET  — health check (200).
//
// Autenticação: o Asaas manda o token configurado no cadastro do webhook no
// header `asaas-access-token`. Validamos contra ASAAS_WEBHOOK_TOKEN. Sem env
// (piloto), processa com aviso. Responde 200 rápido e ativa em `after`.
// ============================================================

import { NextResponse, after } from 'next/server'
import { and, eq, isNull, ne, or } from 'drizzle-orm'

import { db, billingEvents, organization, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { logBillingEvent } from '@/lib/admin/billing-events'
import {
  isActivateEvent,
  extractOrgRef,
  nextDueForCycle,
} from '@/lib/billing/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const expected = process.env.ASAAS_WEBHOOK_TOKEN
  const provided = request.headers.get('asaas-access-token')
  if (expected) {
    if (provided !== expected) {
      console.warn('[webhooks/asaas] rejected: bad asaas-access-token')
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
  } else {
    console.warn(
      '[webhooks/asaas] sem ASAAS_WEBHOOK_TOKEN no ambiente — processando SEM ' +
        'validar o token (piloto). Configure o token p/ fechar.',
    )
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const b = body as { event?: unknown; payment?: unknown } | null
  if (!isActivateEvent(b?.event)) {
    // Outros eventos (criado, vencido, etc.) — ignorados por ora (v1 só ativa).
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  after(() => activateFromPayment(b?.payment))

  return NextResponse.json({ status: 'received' }, { status: 200 })
}


/**
 * Agradece o pagamento — uma vez por pagamento, nunca duas.
 *
 * A trava é o próprio banco: o UPDATE só passa se o `thanked_payment_id` ainda
 * NÃO for este. Um boleto gera dois eventos (CONFIRMED hoje, RECEIVED amanhã) e
 * o Asaas reenvia quando desconfia da entrega — sem isso o cliente ouviria
 * "obrigado" três vezes pelo mesmo boleto. Quem consegue marcar, manda.
 *
 * Se o envio falhar, a marca volta para null: o segundo evento do boleto vira a
 * retentativa natural, sem nenhum código de retry.
 *
 * O valor vem do PRÓPRIO evento, não do cadastro: é o que ele pagou. Num
 * contrato semestral são os R$ 780, não os R$ 130 de mensalidade.
 */
/** Degrau que NÃO existe nos lembretes — o agradecimento não tem template
 *  próprio ainda, então cai no texto livre quando a janela está aberta. */
const OBRIGADO = 99

async function agradecerPagamento(
  orgId: string,
  payment: Record<string, unknown>,
): Promise<void> {
  const paymentId = typeof payment.id === 'string' ? payment.id : null
  if (!paymentId) return

  const channelId = process.env.PLATFORM_BILLING_CHANNEL_ID?.trim()
  if (!channelId) return

  // Compare-and-swap: só um evento vence a corrida.
  const ganhou = await db
    .update(organizationBilling)
    .set({ thankedPaymentId: paymentId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(organizationBilling.organizationId, orgId),
        or(
          isNull(organizationBilling.thankedPaymentId),
          ne(organizationBilling.thankedPaymentId, paymentId),
        ),
      ),
    )
    .returning({ id: organizationBilling.organizationId })
  if (!ganhou.length) return // já agradecemos este pagamento

  try {
    const dados = firstOrNull(
      await db
        .select({
          nome: organization.name,
          fone: organizationBilling.billingPhone,
        })
        .from(organizationBilling)
        .innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
        .where(eq(organizationBilling.organizationId, orgId))
        .limit(1),
    )
    if (!dados?.fone) return // sem telefone não há a quem agradecer

    const [{ loadChannel }, { getProvider }, { enviarRegistrando }, { firstNameForGreeting }] =
      await Promise.all([
        import('@/lib/channels/channels'),
        import('@/lib/channels/registry'),
        import('@/lib/billing/reminder-send'),
        import('@/lib/cdl/names'),
      ])
    const channel = await loadChannel(channelId)
    if (!channel) return

    const valor = Number(payment.value)
    const valorBr =
      Number.isFinite(valor) && valor > 0
        ? valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00A0/g, ' ')
        : ''
    const primeiro = firstNameForGreeting(dados.nome) || dados.nome
    const texto =
      `Olá, ${primeiro}! Aqui é da Fluxia. Recebemos o seu pagamento` +
      `${valorBr ? ` de ${valorBr}` : ''} — obrigado! Está tudo certo por aqui, ` +
      `qualquer coisa é só me chamar.`

    const via = await enviarRegistrando(
      channel,
      getProvider(channel.provider),
      dados.fone.replace(/\D/g, ''),
      texto,
      dados.nome,
      { step: OBRIGADO, params: [primeiro, valorBr, ''] },
    )
    console.log(`[webhooks/asaas] obrigado enviado a "${dados.nome}" · ${via}`)

    await logBillingEvent({
      organizationId: orgId,
      event: 'payment_received',
      toStatus: 'active',
      actorType: 'system',
      actorLabel: 'Asaas',
      metadata: { paymentId, value: payment.value ?? null, dueDate: payment.dueDate ?? null },
    })
  } catch (err) {
    // Devolve a marca: o próximo evento do mesmo boleto tenta de novo.
    await db
      .update(organizationBilling)
      .set({ thankedPaymentId: null })
      .where(
        and(
          eq(organizationBilling.organizationId, orgId),
          eq(organizationBilling.thankedPaymentId, paymentId),
        ),
      )
      .catch(() => {})
    throw err
  }
}

/** Ativa a conta cujo pagamento foi confirmado. Best-effort (não derruba). */
async function activateFromPayment(payment: unknown): Promise<void> {
  try {
    const { externalReference, subscriptionId } = extractOrgRef(payment)
    const orgId = await resolveOrgId(externalReference, subscriptionId)
    if (!orgId) {
      console.warn('[webhooks/asaas] pagamento sem org correspondente', {
        externalReference,
        subscriptionId,
      })
      return
    }
    const p = (payment ?? {}) as Record<string, unknown>
    // O próximo vencimento depende do CICLO: quem pagou um semestral de uma vez
    // só volta a dever em seis meses. Somar um mês aqui faria o lembrete cobrar
    // em outubro um contrato pago até março.
    const atual = firstOrNull(
      await db
        .select({
          cycle: organizationBilling.billingCycle,
          status: organizationBilling.status,
          suspendReason: organizationBilling.suspendReason,
        })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, orgId))
        .limit(1),
    )
    const dueAt = nextDueForCycle(
      typeof p.dueDate === 'string' ? p.dueDate : undefined,
      atual?.cycle,
    )
    const set: Partial<typeof organizationBilling.$inferInsert> = {
      status: 'active',
      dueAt,
      // Pagamento confirmado → limpa qualquer cancelamento pendente/vencido
      // (ex.: cliente cancelado que reassinou). deleted_at NÃO é mexido aqui
      // (exclusão é decisão do admin; o gate bloqueia por deleted_at de todo jeito).
      cancelAt: null,
      // Pagou → sai da trava. As três colunas da suspensão (0200) somem junto,
      // senão a próxima suspensão nasceria com o link da fatura antiga.
      suspendedAt: null,
      suspendReason: null,
      suspendInvoiceUrl: null,
      updatedAt: new Date().toISOString(),
    }
    if (subscriptionId) set.asaasSubscriptionId = subscriptionId
    await db
      .update(organizationBilling)
      .set(set)
      .where(eq(organizationBilling.organizationId, orgId))
    console.log('[webhooks/asaas] conta ativada:', orgId)

    // Estava suspensa? Deixa rastro: sem isso, a reativação pelo pagamento era
    // invisível no histórico — só se via o status mudar, sem saber por quê.
    if (atual?.status === 'suspended') {
      await db
        .insert(billingEvents)
        .values({
          organizationId: orgId,
          event: 'reactivated',
          fromStatus: 'suspended',
          toStatus: 'active',
          actorType: 'system',
          actorLabel: 'pagamento confirmado (Asaas)',
          reason: atual.suspendReason
            ? `pagamento confirmado — estava suspensa por ${atual.suspendReason}`
            : 'pagamento confirmado',
          metadata: { paymentId: p.id ?? null, value: p.value ?? null },
        })
        .catch((err) => console.error('[webhooks/asaas] evento de reativação não gravou:', err))
      console.log('[webhooks/asaas] conta REATIVADA pelo pagamento:', orgId)
    }

    // 📣 Obrigado pelo pagamento (29/09). Até aqui, quem pagava não ouvia nada:
    // o webhook ativava a conta e ia embora. Roda DEPOIS da ativação — o aviso
    // é cortesia, e cortesia nunca pode custar a ativação.
    void agradecerPagamento(orgId, p).catch((err) =>
      console.error('[webhooks/asaas] agradecimento falhou:', err),
    )
  } catch (err) {
    console.error('[webhooks/asaas] activate error:', err)
  }
}

/** Acha a org: 1º pela externalReference (id da org), senão pela assinatura. */
async function resolveOrgId(
  externalReference: string | null,
  subscriptionId: string | null,
): Promise<string | null> {
  if (externalReference && UUID_RE.test(externalReference)) {
    const row = firstOrNull(
      await db
        .select({ id: organizationBilling.organizationId })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, externalReference))
        .limit(1),
    )
    if (row) return row.id
  }
  if (subscriptionId) {
    const row = firstOrNull(
      await db
        .select({ id: organizationBilling.organizationId })
        .from(organizationBilling)
        .where(eq(organizationBilling.asaasSubscriptionId, subscriptionId))
        .limit(1),
    )
    if (row) return row.id
  }
  return null
}

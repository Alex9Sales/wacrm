// ============================================================
// 🔒 Trava por inadimplência — a rodada que suspende de verdade.
//
// Roda no mesmo tick do lembrete da mensalidade (de hora em hora), mas FORA da
// janela de envio: suspender não manda mensagem, então não tem horário
// comercial. As regras moram em suspension.ts; aqui é só banco e Asaas.
//
// Três portas antes de trancar alguém:
//   1. calendário (decideCalendario): ativo, ligado ao Asaas, já venceu;
//   2. Asaas (situacaoDaCobranca): existe cobrança VENCIDA naquele vínculo;
//   3. compare-and-swap: só suspende quem AINDA está ativo — se o webhook do
//      pagamento chegou um segundo antes, o UPDATE não pega ninguém.
//
// Liberar é do webhook: pagamento confirmado → status 'active' na hora, e as
// colunas de suspensão são limpas (ver /api/webhooks/asaas).
//
// Sem 'server-only': roda no worker.
// ============================================================

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { db, billingEvents, organization, organizationBilling } from '@/db'
import { decideCalendario, decideComAsaas, DIAS_DE_TOLERANCIA } from './suspension'
import { canSendNow } from './reminders'

export type SuspensionResult = {
  candidatas: number
  suspensas: number
  webhookPerdido: number
  reativadas: number
  erros: number
}

export async function runBillingSuspensions(now = new Date()): Promise<SuspensionResult> {
  const result: SuspensionResult = { candidatas: 0, suspensas: 0, webhookPerdido: 0, reativadas: 0, erros: 0 }

  // LIBERAR primeiro, e a qualquer hora: quem pagou não espera o horário
  // comercial para entrar.
  await reconciliarSuspensas(now, result)

  // TRANCAR só em dia útil, das 9h às 18h de São Paulo. À meia-noite ou no
  // domingo não há ninguém da Fluxia para atender quem foi trancado — e o
  // boleto pago na véspera ganha a manhã para compensar.
  if (!canSendNow(now)) return result

  // Pré-filtro barato e GENEROSO no SQL (vencimento até amanhã): a conta
  // exata, no fuso de SP, é de decideCalendario. Aqui só não traz quem
  // obviamente ainda não venceu.
  const corte = new Date(now.getTime() - (DIAS_DE_TOLERANCIA - 1) * 86_400_000).toISOString()
  let rows: {
    orgId: string
    name: string
    status: string
    dueAt: string | null
    cancelAt: string | null
    deletedAt: string | null
    asaasSubscriptionId: string | null
    asaasPaymentId: string | null
    suspendReason: string | null
    suspendedAt: string | null
  }[]
  try {
    rows = await db
      .select({
        orgId: organization.id,
        name: organization.name,
        status: organizationBilling.status,
        dueAt: organizationBilling.dueAt,
        cancelAt: organizationBilling.cancelAt,
        deletedAt: organizationBilling.deletedAt,
        asaasSubscriptionId: organizationBilling.asaasSubscriptionId,
        asaasPaymentId: organizationBilling.asaasPaymentId,
        suspendReason: organizationBilling.suspendReason,
        suspendedAt: organizationBilling.suspendedAt,
      })
      .from(organizationBilling)
      .innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
      .where(
        and(
          eq(organizationBilling.status, 'active'),
          isNull(organizationBilling.deletedAt),
          isNotNull(organizationBilling.dueAt),
          lt(organizationBilling.dueAt, corte),
          or(
            isNotNull(organizationBilling.asaasSubscriptionId),
            isNotNull(organizationBilling.asaasPaymentId),
          ),
        ),
      )
  } catch (err) {
    console.error('[billing-suspensions] leitura falhou:', err)
    result.erros++
    return result
  }

  for (const row of rows) {
    const cal = decideCalendario(row, now)
    if (!cal.suspender) continue
    result.candidatas++

    try {
      const { situacaoDaCobranca } = await import('./asaas')
      const situacao = await situacaoDaCobranca(
        { subscriptionId: row.asaasSubscriptionId, paymentId: row.asaasPaymentId },
        row.dueAt ? new Date(row.dueAt).toISOString().slice(0, 10) : null,
      )
      const decisao = decideComAsaas(
        situacao,
        now,
        row.suspendReason === 'liberada_manual' ? row.suspendedAt : null,
      )

      if (situacao.tipo === 'paga') {
        // O cliente pagou e o banco não soube. Não tranca — e grita, porque o
        // vencimento ficou para trás e o próximo ciclo vai ser cobrado errado.
        result.webhookPerdido++
        console.error(
          `[billing-suspensions] "${row.name}": PAGO no Asaas mas o banco segue no vencimento ` +
            `${row.dueAt} — webhook perdido? Não suspendi. Conferir no /admin.`,
        )
        continue
      }
      if (!decisao.suspender || situacao.tipo !== 'vencida') {
        console.log(`[billing-suspensions] "${row.name}": não suspendi — ${decisao.motivo}`)
        continue
      }

      // Compare-and-swap: só quem AINDA está ativo. Se o pagamento chegou
      // agora, o webhook já pôs 'active' com novo vencimento — mas o status
      // sozinho não diferencia; por isso a condição inclui o vencimento lido.
      const suspensa = await db
        .update(organizationBilling)
        .set({
          status: 'suspended',
          suspendedAt: now.toISOString(),
          suspendReason: 'inadimplencia',
          suspendInvoiceUrl: situacao.invoiceUrl,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(organizationBilling.organizationId, row.orgId),
            eq(organizationBilling.status, 'active'),
            row.dueAt ? eq(organizationBilling.dueAt, row.dueAt) : sql`true`,
          ),
        )
        .returning({ id: organizationBilling.organizationId })

      if (suspensa.length === 0) {
        console.log(`[billing-suspensions] "${row.name}": mudou no meio do caminho (pagou?) — mantida`)
        continue
      }

      result.suspensas++
      console.log(`[billing-suspensions] "${row.name}" SUSPENSA — ${decisao.motivo}`)
      await db
        .insert(billingEvents)
        .values({
          organizationId: row.orgId,
          event: 'suspended',
          fromStatus: 'active',
          toStatus: 'suspended',
          actorType: 'system',
          actorLabel: 'trava de inadimplência',
          reason: decisao.motivo,
          metadata: {
            paymentId: situacao.paymentId,
            dueDate: situacao.dueDate,
            invoiceUrl: situacao.invoiceUrl,
            diasDeAtraso: cal.diasDeAtraso,
          },
        })
        .catch((err) => console.error('[billing-suspensions] evento não gravou:', err))
    } catch (err) {
      // Falha ao consultar o Asaas = NÃO suspende. Errar para o lado de deixar
      // o cliente entrar: trancar alguém por uma falha de rede nossa é pior.
      result.erros++
      console.error(`[billing-suspensions] "${row.name}": consulta falhou, não suspendi:`, err)
    }
  }

  if (result.candidatas > 0 || result.erros > 0 || result.reativadas > 0) {
    console.log(
      `[billing-suspensions] candidatas=${result.candidatas} suspensas=${result.suspensas} ` +
        `webhookPerdido=${result.webhookPerdido} reativadas=${result.reativadas} erros=${result.erros}`,
    )
  }
  return result
}

/**
 * Reconciliação: quem está suspenso por inadimplência e NÃO deve mais nada.
 *
 * O caminho normal de liberar é o webhook do Asaas. Mas ele responde 200 antes
 * de ativar a conta, engole o próprio erro, e já passou um mês sem estar
 * cadastrado (até 29/09). Se ele se perder, o cliente que pagou fica trancado
 * para sempre — e a tela promete "o acesso volta sozinho". Esta rodada cumpre a
 * promessa: de hora em hora pergunta ao Asaas e libera quem quitou.
 *
 * Também é o que destranca o boleto pago no 5º dia que só compensou no 6º.
 *
 * Erro na consulta → não mexe. Aqui o erro seguro é o contrário da trava:
 * deixar como está e tentar na próxima hora.
 */
async function reconciliarSuspensas(now: Date, result: SuspensionResult): Promise<void> {
  let suspensas: {
    orgId: string
    name: string
    dueAt: string | null
    asaasSubscriptionId: string | null
    asaasPaymentId: string | null
  }[]
  try {
    suspensas = await db
      .select({
        orgId: organization.id,
        name: organization.name,
        dueAt: organizationBilling.dueAt,
        asaasSubscriptionId: organizationBilling.asaasSubscriptionId,
        asaasPaymentId: organizationBilling.asaasPaymentId,
      })
      .from(organizationBilling)
      .innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
      .where(
        and(
          eq(organizationBilling.status, 'suspended'),
          eq(organizationBilling.suspendReason, 'inadimplencia'),
          isNull(organizationBilling.deletedAt),
        ),
      )
  } catch (err) {
    console.error('[billing-suspensions] leitura das suspensas falhou:', err)
    result.erros++
    return
  }

  for (const row of suspensas) {
    try {
      const { situacaoDaCobranca } = await import('./asaas')
      const situacao = await situacaoDaCobranca(
        { subscriptionId: row.asaasSubscriptionId, paymentId: row.asaasPaymentId },
        row.dueAt ? new Date(row.dueAt).toISOString().slice(0, 10) : null,
      )
      if (decideComAsaas(situacao, now).suspender) continue // ainda deve: fica

      const liberada = await db
        .update(organizationBilling)
        .set({
          status: 'active',
          suspendedAt: null,
          suspendReason: null,
          suspendInvoiceUrl: null,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(organizationBilling.organizationId, row.orgId),
            eq(organizationBilling.status, 'suspended'),
            eq(organizationBilling.suspendReason, 'inadimplencia'),
          ),
        )
        .returning({ id: organizationBilling.organizationId })
      if (liberada.length === 0) continue

      result.reativadas++
      console.error(
        `[billing-suspensions] "${row.name}" REATIVADA pela conciliação — o Asaas não tem mais ` +
          `fatura vencida, mas o webhook não liberou (${situacao.tipo}). Webhook perdido?`,
      )
      await db
        .insert(billingEvents)
        .values({
          organizationId: row.orgId,
          event: 'reactivated',
          fromStatus: 'suspended',
          toStatus: 'active',
          actorType: 'system',
          actorLabel: 'conciliação horária (webhook perdido)',
          reason: `Asaas: ${situacao.tipo}`,
          metadata: {},
        })
        .catch((err) => console.error('[billing-suspensions] evento não gravou:', err))
    } catch (err) {
      result.erros++
      console.error(`[billing-suspensions] "${row.name}": conciliação falhou, deixei como está:`, err)
    }
  }
}

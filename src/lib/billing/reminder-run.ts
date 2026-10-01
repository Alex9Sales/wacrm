// ============================================================
// A rodada dos lembretes de mensalidade — a parte que fala com o banco e
// com o WhatsApp. As decisões (qual degrau, que horas, o texto) são puras e
// moram em ./reminders, testadas lá.
// ============================================================

import { and, eq, isNull } from 'drizzle-orm'

import { db, organization, organizationBilling } from '@/db'
import { loadChannel } from '@/lib/channels/channels'
import { enviarRegistrando } from './reminder-send'
import { firstNameForGreeting } from '@/lib/cdl/names'
import { CYCLES, type BillingCycle } from '@/lib/billing/cycle'
import { getProvider } from '@/lib/channels/registry'

import {
  canSendNow,
  dueStep,
  reminderText,
  type ReminderCandidate,
  type ReminderStep,
  valorDoLembrete,
  diaBr,} from './reminders'

export interface ReminderRunResult {
  checked: number
  sent: number
  skipped: number
  failed: number
}

/** A chave do vencimento dentro de reminders_sent: 'AAAA-MM-DD'. */
export function dueKey(dueAt: string): string {
  return new Date(dueAt).toISOString().slice(0, 10)
}

export function stepsFor(raw: unknown, key: string): number[] {
  if (!raw || typeof raw !== 'object') return []
  const v = (raw as Record<string, unknown>)[key]
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []
}

export async function runBillingReminders(now = new Date()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { checked: 0, sent: 0, skipped: 0, failed: 0 }
  if (!canSendNow(now)) return result

  const channelId = process.env.PLATFORM_BILLING_CHANNEL_ID?.trim()
  if (!channelId) {
    console.warn('[billing-reminders] PLATFORM_BILLING_CHANNEL_ID não configurado — nada enviado.')
    return result
  }
  const channel = await loadChannel(channelId)
  if (!channel) {
    console.error(`[billing-reminders] canal ${channelId} não encontrado — nada enviado.`)
    return result
  }
  const provider = getProvider(channel.provider)

  let rows: {
    orgId: string
    name: string
    billingPhone: string | null
    asaasCustomerId: string | null
    asaasSubscriptionId: string | null
    asaasPaymentId: string | null
    plan: string | null
    monthlyValue: string | null
    billingCycle: string | null
    dueAt: string | null
    status: string
    remindersSent: unknown
  }[]
  try {
    rows = await db
      .select({
        orgId: organization.id,
        name: organization.name,
        billingPhone: organizationBilling.billingPhone,
        asaasCustomerId: organizationBilling.asaasCustomerId,
        asaasSubscriptionId: organizationBilling.asaasSubscriptionId,
        asaasPaymentId: organizationBilling.asaasPaymentId,
        plan: organizationBilling.plan,
        monthlyValue: organizationBilling.monthlyValue,
        billingCycle: organizationBilling.billingCycle,
        dueAt: organizationBilling.dueAt,
        status: organizationBilling.status,
        remindersSent: organizationBilling.remindersSent,
      })
      .from(organizationBilling)
      .innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
      .where(and(eq(organizationBilling.status, 'active'), isNull(organizationBilling.deletedAt)))
  } catch (err) {
    console.error('[billing-reminders] leitura falhou:', err)
    return result
  }

  for (const row of rows) {
    if (!row.dueAt) continue
    const key = dueKey(row.dueAt)
    const candidate: ReminderCandidate = {
      orgId: row.orgId,
      name: row.name,
      billingPhone: row.billingPhone,
      plan: row.plan,
      monthlyValue: row.monthlyValue === null ? null : Number(row.monthlyValue),
      dueAt: row.dueAt,
      status: row.status,
      sentSteps: stepsFor(row.remindersSent, key),
    }
    const step = dueStep(candidate, now)
    if (step === null) {
      result.skipped++
      continue
    }
    result.checked++

    try {
      const texto = reminderText(candidate, step)
      const fone = candidate.billingPhone!.replace(/\D/g, '')
      // Os params do template aprovado: {{1}} nome, {{2}} valor, {{3}} dia.
      // Mesmos dados do texto livre — o corpo do template repete a frase dele.
      // A cobrança em aberto vira o botão "Pagar agora" (quando o template com
      // link estiver aprovado). Falhar aqui não pode custar o lembrete: sem o
      // link ele sai igual, só sem botão.
      let invoiceUrl: string | null = null
      let chargeValue: number | null = null
      if (row.asaasSubscriptionId || row.asaasPaymentId || row.asaasCustomerId) {
        try {
          // Pela ASSINATURA, não pelo cliente: o mesmo cliente no Asaas pode
          // ter cobranças de outro produto (ver openChargeForBilling). No degrau
          // de "em aberto" a mensalidade já venceu, então a vencida conta.
          const { openChargeForBilling } = await import('./asaas')
          const cobranca = await openChargeForBilling(
            {
              subscriptionId: row.asaasSubscriptionId,
              paymentId: row.asaasPaymentId,
              customerId: row.asaasCustomerId,
            },
            { includeOverdue: step > 0 },
          )
          invoiceUrl = cobranca?.invoiceUrl ?? null
          // O valor do BOLETO, não o mensal — ver valorDoLembrete.
          chargeValue = cobranca ? Number(cobranca.value) : null
          // "Em aberto" de quem tem assinatura e NADA vencido no Asaas: a
          // fatura foi paga e o webhook não avançou o vencimento. Mandar
          // "sua mensalidade está em aberto" a quem pagou é o pior lembrete
          // possível. Não manda e não carimba — a trava também não vai agir
          // (ela confere o mesmo no Asaas).
          if (step === 3 && !cobranca && (row.asaasSubscriptionId || row.asaasPaymentId)) {
            console.error(
              `[billing-reminders] "${row.name}": nada vencido no Asaas para o vencimento ${key} — ` +
                `pago e o webhook não avançou? Não mandei o "em aberto".`,
            )
            result.skipped++
            continue
          }
        } catch (err) {
          console.warn(`[billing-reminders] cobrança de "${row.name}" não veio:`, err)
        }
      }
      const valorTexto = valorDoLembrete({
        chargeValue,
        monthlyValue: candidate.monthlyValue,
        cycleMonths: row.billingCycle ? (CYCLES[row.billingCycle as BillingCycle]?.months ?? 1) : 1,
      })
      const via = await enviarRegistrando(channel, provider, fone, texto, row.name, {
        invoiceUrl,
        step,
        params: [
          firstNameForGreeting(row.name) || row.name,
          valorTexto,
          candidate.dueAt ? diaBr(candidate.dueAt) : '',
        ],
      })
      // "não enviado (sem template aprovado…)" volta como string, não como
      // erro. Carimbar isso como enviado mentiria duas vezes: o lembrete não
      // sairia de novo, e a trava acharia que o cliente foi avisado.
      if (via.startsWith('não enviado')) {
        result.failed++
        console.error(`[billing-reminders] "${row.name}" degrau ${step} NÃO saiu: ${via}`)
        continue
      }
      await markSent(row.orgId, row.remindersSent, key, step, now)
      result.sent++
      console.log(
        `[billing-reminders] "${row.name}" — degrau ${step} enviado (vence ${key}) · ${via}`,
      )
    } catch (err) {
      result.failed++
      // Não marca como enviado: a próxima rodada tenta de novo. Falha de rede
      // não pode custar o lembrete inteiro.
      console.error(`[billing-reminders] "${row.name}" falhou no degrau ${step}:`, err)
    }
  }

  if (result.sent > 0 || result.failed > 0) {
    console.log(
      `[billing-reminders] ${result.sent} enviado(s), ${result.failed} falha(s), ${result.skipped} fora de degrau`,
    )
  }
  return result
}


async function markSent(
  orgId: string,
  current: unknown,
  key: string,
  step: ReminderStep,
  now: Date,
): Promise<void> {
  const base = (current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {}) as Record<
    string,
    number[]
  >
  // Só guarda o vencimento atual: sem isto o json cresceria pra sempre.
  const next = { [key]: [...new Set([...(base[key] ?? []), step])] }
  await db
    .update(organizationBilling)
    .set({ remindersSent: next, lastReminderAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(organizationBilling.organizationId, orgId))
}

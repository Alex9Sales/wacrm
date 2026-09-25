// ============================================================
// A rodada dos lembretes de mensalidade — a parte que fala com o banco e
// com o WhatsApp. As decisões (qual degrau, que horas, o texto) são puras e
// moram em ./reminders, testadas lá.
// ============================================================

import { and, eq, isNull } from 'drizzle-orm'

import { db, organization, organizationBilling } from '@/db'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'

import {
  canSendNow,
  dueStep,
  reminderText,
  type ReminderCandidate,
  type ReminderStep,
} from './reminders'

export interface ReminderRunResult {
  checked: number
  sent: number
  skipped: number
  failed: number
}

/** A chave do vencimento dentro de reminders_sent: 'AAAA-MM-DD'. */
function dueKey(dueAt: string): string {
  return new Date(dueAt).toISOString().slice(0, 10)
}

function stepsFor(raw: unknown, key: string): number[] {
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
    plan: string | null
    monthlyValue: string | null
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
        plan: organizationBilling.plan,
        monthlyValue: organizationBilling.monthlyValue,
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
      await provider.sendText(channel, candidate.billingPhone!.replace(/\D/g, ''), reminderText(candidate, step))
      await markSent(row.orgId, row.remindersSent, key, step, now)
      result.sent++
      console.log(`[billing-reminders] "${row.name}" — degrau ${step} enviado (vence ${key})`)
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

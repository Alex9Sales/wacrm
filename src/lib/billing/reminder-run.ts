// ============================================================
// A rodada dos lembretes de mensalidade — a parte que fala com o banco e
// com o WhatsApp. As decisões (qual degrau, que horas, o texto) são puras e
// moram em ./reminders, testadas lá.
// ============================================================

import { and, eq, isNull } from 'drizzle-orm'

import { db, member, organization, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
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
      const texto = reminderText(candidate, step)
      const fone = candidate.billingPhone!.replace(/\D/g, '')
      const via = await enviarRegistrando(channel, provider, fone, texto, row.name)
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


/**
 * Envia o lembrete DENTRO de uma conversa do CRM (29/09) — e cai para o envio
 * direto se não der.
 *
 * Por que isto importa: antes o lembrete saía por `provider.sendText`, que fala
 * com a Meta e pronto. A Meta aceitava e devolvia um id, mas esse id não era
 * guardado em lugar nenhum — então a mensagem não aparecia na conversa, o
 * webhook de status (entregue/lido) não tinha onde pousar, e a única prova de
 * que algo saiu era uma linha de log. O Alex perguntou "por que não dá para
 * saber se foi enviado?" e a resposta era essa: dava para saber que a Meta
 * aceitou, não que o cliente recebeu.
 *
 * Mandando pela conversa, o lembrete vira uma mensagem como qualquer outra:
 * aparece no histórico do cliente, recebe os ticks de entrega e pode ser
 * respondida — o que também abre a janela de 24h para a conversa seguinte.
 *
 * O fallback existe porque lembrete de cobrança não pode deixar de sair por
 * causa de um contato que não pôde ser criado. Mas ele AVISA no log qual
 * caminho foi usado, para que "não achei a mensagem" tenha resposta.
 */
async function enviarRegistrando(
  channel: Awaited<ReturnType<typeof loadChannel>> & object,
  provider: ReturnType<typeof getProvider>,
  fone: string,
  texto: string,
  nomeCliente: string,
): Promise<string> {
  try {
    const { findOrCreateContact } = await import('@/lib/api/v1/contacts')
    const { findOrCreateConversation } = await import('@/lib/channels/inbound')
    const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message')

    const dono = await ownerUserIdOf(channel.accountId)
    if (!dono) throw new Error('conta do canal sem usuário para auditoria')

    const contato = await findOrCreateContact(channel.accountId, dono, {
      phone: `+${fone}`,
      name: nomeCliente,
    })
    const conv = await findOrCreateConversation(
      channel.accountId,
      dono,
      contato.id,
      channel.id,
    )
    if (!conv) throw new Error('conversa não resolvida')

    await sendMessageToConversation(channel.accountId, {
      conversationId: conv.conversation.id,
      messageType: 'text',
      contentText: texto,
    })
    return 'na conversa'
  } catch (err) {
    console.warn(
      `[billing-reminders] não consegui registrar na conversa (${
        err instanceof Error ? err.message : 'erro'
      }) — mandando direto pelo canal.`,
    )
    await provider.sendText(channel, fone, texto)
    return 'direto pelo canal (sem registro na conversa)'
  }
}

/** Um usuário da conta do canal, só para assinar a criação do contato. */
async function ownerUserIdOf(accountId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, accountId))
      .limit(1),
  )
  return row?.userId ?? null
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

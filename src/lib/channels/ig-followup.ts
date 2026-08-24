// ============================================================
// ⏰ Follow-up pós-DM da automação de comentários (social selling).
//
// REALIDADE DA API: a Meta permite UMA resposta privada por comentário; quem
// nunca respondeu a DM não pode receber outra mensagem. Então a cutucada vai
// SÓ pra quem RESPONDEU (janela de 24h aberta) e depois sumiu:
//   evento com DM enviado → a pessoa respondeu DEPOIS do DM → a última
//   mensagem da conversa é NOSSA → silêncio >= N horas → ainda dentro da
//   janela (última msg dela < 23h) → 1 cutucada por evento, claim atômico.
// Trava de horário: 8h-20h59 no fuso da conta. Rodada pelo worker (tick 10min).
// SEM 'server-only' — worker-reachable.
// ============================================================

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import {
  db,
  contacts,
  conversations,
  instagramCommentAutomations,
  instagramCommentEvents,
  messages,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel } from './channels'
import { instagramProvider } from './providers/instagram'
import { getAccountSettings } from '@/lib/settings/account-settings'

const FOLLOW_UP_DEFAULT =
  'Oi! 👋 Ficou alguma dúvida sobre o que te mandei? Estou por aqui! 😊'

/** Hora local (0-23) num fuso IANA; falha → hora do servidor. */
function hourIn(tz: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hour12: false,
        timeZone: tz,
      }).format(new Date()),
    )
  } catch {
    return new Date().getHours()
  }
}

export async function runIgFollowUpSweep(): Promise<{ sent: number }> {
  let sent = 0

  // Candidatos: eventos recentes com DM enviado, follow-up ligado na regra,
  // sem cutucada ainda, com idade >= N horas da regra (teto 48h de varredura).
  const candidates = await db
    .select({
      eventId: instagramCommentEvents.id,
      accountId: instagramCommentEvents.accountId,
      channelId: instagramCommentEvents.channelId,
      igUserId: instagramCommentEvents.commenterIgsid,
      eventAt: instagramCommentEvents.createdAt,
      hours: instagramCommentAutomations.followUpHours,
      message: instagramCommentAutomations.followUpMessage,
    })
    .from(instagramCommentEvents)
    .innerJoin(
      instagramCommentAutomations,
      eq(instagramCommentAutomations.id, instagramCommentEvents.automationId),
    )
    .where(
      and(
        eq(instagramCommentAutomations.followUpEnabled, true),
        eq(instagramCommentEvents.dmSent, true),
        isNull(instagramCommentEvents.followUpSentAt),
        sql`${instagramCommentEvents.createdAt} > now() - interval '48 hours'`,
        sql`${instagramCommentEvents.createdAt} <= now() - (${instagramCommentAutomations.followUpHours} * interval '1 hour')`,
      ),
    )
    .limit(50)
  if (!candidates.length) return { sent }

  // Trava de horário por conta (cache no loop).
  const hourOkByAccount = new Map<string, boolean>()

  for (const c of candidates) {
    try {
      if (!c.igUserId) continue

      let hourOk = hourOkByAccount.get(c.accountId)
      if (hourOk === undefined) {
        const settings = await getAccountSettings(c.accountId).catch(() => null)
        const h = hourIn(settings?.businessTimezone || 'America/Sao_Paulo')
        hourOk = h >= 8 && h < 21
        hourOkByAccount.set(c.accountId, hourOk)
      }
      if (!hourOk) continue

      // Contato pelo IGSID — sem contato = nunca mandou DM pra gente = janela
      // fechada (a API recusaria). Fica pro próximo tick (até 48h).
      const contact = firstOrNull(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.accountId, c.accountId),
              eq(contacts.externalId, c.igUserId),
            ),
          )
          .limit(1),
      )
      if (!contact) continue

      const conversation = firstOrNull(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.channelId, c.channelId),
              eq(conversations.contactId, contact.id),
            ),
          )
          .orderBy(desc(conversations.createdAt))
          .limit(1),
      )
      if (!conversation) continue

      const stats = firstOrNull(
        await db
          .select({
            lastCustomer: sql<string | null>`max(${messages.createdAt}) FILTER (WHERE ${messages.senderType} = 'customer')`,
            lastSender: sql<string | null>`(array_agg(${messages.senderType} ORDER BY ${messages.createdAt} DESC))[1]`,
          })
          .from(messages)
          .where(eq(messages.conversationId, conversation.id)),
      )
      const lastCustomer = stats?.lastCustomer
        ? new Date(stats.lastCustomer).getTime()
        : null
      if (!lastCustomer) continue

      const now = Date.now()
      const hoursMs = c.hours * 3_600_000
      const respondeuDepoisDoDm = lastCustomer > new Date(c.eventAt).getTime()
      const janelaAberta = now - lastCustomer < 23 * 3_600_000 // margem de 1h
      const sumiu = now - lastCustomer >= hoursMs
      const ultimaENossa = stats?.lastSender !== 'customer'
      if (!respondeuDepoisDoDm || !janelaAberta || !sumiu || !ultimaENossa) {
        continue
      }

      // Claim atômico ANTES do envio (dois ticks não cutucam 2x).
      const claimed = firstOrNull(
        await db
          .update(instagramCommentEvents)
          .set({ followUpSentAt: new Date().toISOString() })
          .where(
            and(
              eq(instagramCommentEvents.id, c.eventId),
              isNull(instagramCommentEvents.followUpSentAt),
            ),
          )
          .returning({ id: instagramCommentEvents.id }),
      )
      if (!claimed) continue

      const channel = await loadChannel(c.channelId)
      if (!channel) continue
      try {
        await instagramProvider.sendText(
          channel,
          c.igUserId,
          (c.message ?? '').trim() || FOLLOW_UP_DEFAULT,
        )
        sent++
      } catch (err) {
        console.error('[ig-followup] envio falhou:', err)
        // devolve o claim — tenta no próximo tick (dentro das 48h)
        await db
          .update(instagramCommentEvents)
          .set({ followUpSentAt: null })
          .where(eq(instagramCommentEvents.id, c.eventId))
      }
    } catch (err) {
      console.error('[ig-followup] candidato falhou:', err)
    }
  }
  return { sent }
}

// ============================================================
// Quem cria o disparo passa a ENXERGAR as conversas que ele gera.
//
// 15/09 (GoLink): cada envio cria a conversa no número do disparo, sem
// responsável; num número dedicado a outra pessoa, quem disparou não via
// nenhuma. Participante (conversation_participants) já vence a regra de canal
// dedicado na lista e na leitura (lib/sectors/access.ts) — sem trocar o
// responsável nem o número. Worker-safe (sem 'server-only').
//
// Chamado pelo worker logo depois de marcar o destinatário como enviado. A
// conversa é garantida pelo MESMO findOrCreateConversation do eco do WhatsApp
// (inbound.ts): uma por (conta, contato, canal), setor herdado do canal, e a
// corrida com o eco cai no índice único e reaproveita a vencedora. Autoria da
// conversa = a mesma que o eco usaria (dono do contato), não quem disparou.
// Se ESTA chamada criou a conversa, emite o conversation.created que o eco
// deixaria de emitir (webhook + tempo real). Canais de e-mail ficam fora (a
// conversa de e-mail nasce pela resposta). Nunca lança.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels, contacts, conversationParticipants } from '@/db'
import { firstOrNull } from '@/db/helpers'

export async function linkBroadcastConversation(input: {
  accountId: string
  channelId: string
  contactId: string
  creatorUserId: string
}): Promise<void> {
  const { accountId, channelId, contactId, creatorUserId } = input
  if (!accountId || !channelId || !contactId || !creatorUserId) return
  const where = { accountId, channelId, contactId, creatorUserId }
  try {
    const channel = firstOrNull(
      await db
        .select({ accountId: channels.accountId, provider: channels.provider })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1),
    )
    if (!channel || channel.accountId !== accountId) return
    if (channel.provider === 'email' || channel.provider === 'gmail') return

    const contact = firstOrNull(
      await db
        .select({ userId: contacts.userId })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
    if (!contact) return

    // Import tardio: inbound.ts puxa IA/fluxos/automações — só carrega quando
    // o primeiro envio sai, e não cria ciclo no boot do worker.
    const { findOrCreateConversation } = await import('@/lib/channels/inbound')
    const conv = await findOrCreateConversation(accountId, contact.userId, contactId, channelId)
    if (!conv) {
      console.error('[broadcast-link] conversa não resolvida', where)
      return
    }

    await db
      .insert(conversationParticipants)
      .values({ conversationId: conv.conversation.id, userId: creatorUserId })
      .onConflictDoNothing({
        target: [conversationParticipants.conversationId, conversationParticipants.userId],
      })

    if (conv.created) {
      try {
        const [{ dispatchWebhookEvent }, { publishEvent }] = await Promise.all([
          import('@/lib/webhooks/deliver'),
          import('@/lib/events/publish'),
        ])
        await dispatchWebhookEvent(
          accountId,
          'conversation.created',
          { conversation_id: conv.conversation.id, contact_id: contactId },
          channelId,
        )
        await publishEvent(accountId, {
          type: 'conversation.created',
          conversationId: conv.conversation.id,
        })
      } catch (evErr) {
        console.error('[broadcast-link] aviso de conversa criada falhou', where, evErr)
      }
    }
  } catch (err) {
    console.error('[broadcast-link] vincular quem disparou falhou', where, err)
  }
}

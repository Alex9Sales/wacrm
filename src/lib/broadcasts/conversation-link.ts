// ============================================================
// Quem cria o disparo passa a ENXERGAR as conversas que ele gera.
//
// 15/09 (GoLink): cada envio cria a conversa no número do disparo, sem
// responsável; num número dedicado a outra pessoa, quem disparou não via
// nenhuma. Vira participante com source='broadcast' (migr 0175) — vence setor e
// canal dedicado na lista e na leitura (lib/sectors/access.ts) sem trocar o
// responsável nem o número. Worker-safe (sem 'server-only').
//
// ⚠️ Revisão 15/09: dá leitura do histórico INTEIRO, então só vale pra conversa
// que NASCEU do disparo (ver whyNotBornFromBroadcast). Conversa com histórico
// anterior nunca ganha participante por disparo: quem criou pede atribuição.
// Conferência 15/09: o acesso por disparo cai quando a conversa vira privada
// ou alguém a pega (access.ts confere na hora) — @menção continua vencendo.
//
// Chamado pelo worker logo depois de marcar o destinatário como enviado.
//   • Canal COM eco (WAHA/Evolution/IG/Messenger): a conversa é garantida pelo
//     MESMO findOrCreateConversation do eco (inbound.ts) — uma por (conta,
//     contato, canal), setor herdado do canal, corrida com o eco cai no índice
//     único. Autoria = dono do contato (igual ao eco). Se ESTA chamada criou a
//     conversa, emite o conversation.created que o eco deixaria de emitir.
//   • Canal SEM eco (meta = API oficial; evogo descarta fromMe): NÃO cria
//     conversa — nasceria vazia no topo da caixa, dispararia o webhook e
//     roubaria o rodízio (routeNewConversation) da 1ª resposta. Só usa conversa
//     que já existe; senão quem liga é linkBroadcastCreatorsOnFirstReply,
//     chamado pelo inbound quando a resposta do cliente cria a conversa.
//   • E-mail/Gmail: fora (a conversa de e-mail nasce pela resposta).
// Nunca lança.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, channels, contacts, conversations, conversationParticipants } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** Canais cujo envio NÃO volta como eco (fromMe) pelo webhook. */
const NO_ECHO_PROVIDERS = new Set(['meta', 'evogo'])

/** Onde a conversa só nasce na resposta do cliente (ver linkBroadcastCreatorsOnFirstReply). */
const FIRST_REPLY_PROVIDERS_SQL = sql.raw(
  [...NO_ECHO_PROVIDERS, 'email', 'gmail'].map((p) => `'${p}'`).join(', '),
)

/** Janela em que a resposta do cliente ainda "é" resposta ao disparo. */
const FIRST_REPLY_WINDOW = sql.raw(`interval '7 days'`)

/**
 * Folga antes do envio pra aceitar o eco. O eco do WhatsApp é gravado enquanto
 * a chamada ao provedor ainda não voltou (sent_at só é gravado depois) e o
 * relógio do worker pode diferir do banco. Sem essa folga, disparo AGENDADO
 * (created_at dias antes do envio) deixaria passar a conversa que surgiu entre
 * a criação e o envio.
 */
const ECHO_SLACK = sql.raw(`interval '10 minutes'`)

/**
 * Folga pra fala do cliente/robô. sent_at só é gravado quando o provedor
 * responde; a auto-resposta do cliente (robô de boas-vindas, comum em B2B)
 * pode entrar antes disso — com envio lento ou nova tentativa, segundos antes
 * do sent_at. Sem a folga, ela contaria como histórico e quem disparou nunca
 * ganharia o acesso (conferência 15/09).
 */
const REPLY_SLACK = sql.raw(`interval '2 minutes'`)

/**
 * Mensagem `m` que prova histórico ANTERIOR ao disparo `b` (enviado em
 * `sentAt`): qualquer uma antes do corte (created_at do disparo, apertado pra
 * envio − folga no agendado), ou fala do cliente/robô antes do envio (− folga)
 * — o eco é sempre 'agent', e fala do cliente DEPOIS do envio é a resposta ao
 * disparo. Sem envio registrado, qualquer fala do cliente conta.
 */
function priorHistory(sentAt: string) {
  const sent = sql.raw(sentAt)
  return sql`(
    m."created_at" < GREATEST(b."created_at", ${sent} - ${ECHO_SLACK})
    OR (m."sender_type" <> 'agent' AND m."created_at" < COALESCE(${sent} - ${REPLY_SLACK}, 'infinity'::timestamptz))
  )`
}

type ConversationGate = {
  id: string
  isPrivate: boolean
  assignedAgentId: string | null
}

export async function linkBroadcastConversation(input: {
  accountId: string
  channelId: string
  contactId: string
  creatorUserId: string
  /** Disparo que gerou o envio: só vincula conversa nascida dele (revisão 15/09). */
  broadcastId?: string
}): Promise<void> {
  const { accountId, channelId, contactId, creatorUserId, broadcastId } = input
  if (!accountId || !channelId || !contactId || !creatorUserId) return
  const where = { accountId, channelId, contactId, creatorUserId, broadcastId }
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

    let conv: ConversationGate | null
    let created = false
    if (NO_ECHO_PROVIDERS.has(channel.provider)) {
      // Sem eco: só procura. Não existe → a 1ª resposta cria e liga (inbound).
      conv = firstOrNull(
        await db
          .select({
            id: conversations.id,
            isPrivate: conversations.isPrivate,
            assignedAgentId: conversations.assignedAgentId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.accountId, accountId),
              eq(conversations.contactId, contactId),
              eq(conversations.channelId, channelId),
            ),
          )
          .limit(1),
      )
      if (!conv) return
    } else {
      // Import tardio: inbound.ts puxa IA/fluxos/automações — só carrega quando
      // o primeiro envio sai, e não cria ciclo no boot do worker.
      const { findOrCreateConversation } = await import('@/lib/channels/inbound')
      const res = await findOrCreateConversation(accountId, contact.userId, contactId, channelId)
      if (!res) {
        console.error('[broadcast-link] conversa não resolvida', where)
        return
      }
      conv = res.conversation
      created = res.created
    }

    // Conversa que esta chamada criou nasceu do disparo por definição. A que já
    // existia (eco chegou antes, ou canal sem eco) passa pela regra completa.
    if (!created) {
      const skip = await whyNotBornFromBroadcast(conv, { accountId, contactId, creatorUserId, broadcastId })
      if (skip) {
        console.log(`[broadcast-link] sem participante (${skip})`, {
          conversationId: conv.id,
          broadcastId,
          creatorUserId,
        })
        return
      }
    }

    // DO NOTHING: quem já estava por @menção continua com o acesso de menção.
    await db
      .insert(conversationParticipants)
      .values({ conversationId: conv.id, userId: creatorUserId, source: 'broadcast' })
      .onConflictDoNothing({
        target: [conversationParticipants.conversationId, conversationParticipants.userId],
      })

    if (created) {
      try {
        const [{ dispatchWebhookEvent }, { publishEvent }] = await Promise.all([
          import('@/lib/webhooks/deliver'),
          import('@/lib/events/publish'),
        ])
        await dispatchWebhookEvent(
          accountId,
          'conversation.created',
          { conversation_id: conv.id, contact_id: contactId },
          channelId,
        )
        await publishEvent(accountId, {
          type: 'conversation.created',
          conversationId: conv.id,
        })
      } catch (evErr) {
        console.error('[broadcast-link] aviso de conversa criada falhou', where, evErr)
      }
    }
  } catch (err) {
    console.error('[broadcast-link] vincular quem disparou falhou', where, err)
  }
}

/**
 * Conversa que JÁ EXISTIA só conta como "nova do disparo" quando: não é
 * privada; está sem responsável (ou com o próprio criador); e não tem nenhuma
 * mensagem anterior ao disparo nem fala do cliente/robô. Devolve o motivo de
 * NÃO vincular, ou null quando pode.
 *
 * O corte (priorHistory) é o created_at do disparo — cobre a corrida com o eco
 * do WhatsApp, que cria a conversa ~1 s depois do envio — apertado pra (último
 * envio pra esse contato − folga) no disparo agendado; fala do cliente/robô
 * antes do envio também é histórico.
 */
async function whyNotBornFromBroadcast(
  conv: ConversationGate,
  ctx: { accountId: string; contactId: string; creatorUserId: string; broadcastId?: string },
): Promise<string | null> {
  if (conv.isPrivate) return 'privada'
  if (conv.assignedAgentId && conv.assignedAgentId !== ctx.creatorUserId) return 'atribuída a outra pessoa'
  if (!ctx.broadcastId) return 'sem disparo pra comparar'
  const res = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."conversation_id" = ${conv.id}::uuid
        AND ${priorHistory('r."last_sent_at"')}
    ) AS "has_history"
    FROM "broadcasts" b
    LEFT JOIN LATERAL (
      SELECT max(br."sent_at") AS "last_sent_at"
      FROM "broadcast_recipients" br
      WHERE br."broadcast_id" = b."id" AND br."contact_id" = ${ctx.contactId}::uuid
    ) r ON true
    WHERE b."id" = ${ctx.broadcastId}::uuid AND b."account_id" = ${ctx.accountId}::uuid
    LIMIT 1
  `)
  const row = (res.rows as { has_history?: unknown }[])[0]
  if (!row) return 'disparo não encontrado'
  if (row.has_history === true || row.has_history === 't') return 'histórico anterior'
  return null
}

/**
 * Canal SEM eco (meta/evogo) — e e-mail, pelo mesmo motivo: a conversa só nasce
 * quando o cliente responde. O inbound chama isto quando a mensagem do CLIENTE
 * acabou de CRIAR a conversa (depois do rodízio, que continua mandando no
 * responsável): quem mandou disparo pra esse contato por esse número nos
 * últimos 7 dias entra como participante. Conversa recém-criada = sem histórico
 * anterior, então a regra de linkBroadcastConversation vale sem consulta extra
 * (só confere conta e privacidade). Nunca lança; import leve (só @/db).
 *
 * Conferência 15/09: só nesses provedores. Nos canais COM eco o worker já
 * decidiu no envio — uma conversa recriada depois (a antiga foi excluída) não
 * pode passar por cima de um "não" dado lá.
 */
export async function linkBroadcastCreatorsOnFirstReply(input: {
  accountId: string
  conversationId: string
  contactId: string
  channelId: string | null | undefined
}): Promise<void> {
  const { accountId, conversationId, contactId, channelId } = input
  if (!accountId || !conversationId || !contactId || !channelId) return
  try {
    const res = await db.execute(sql`
      INSERT INTO "conversation_participants" ("conversation_id", "user_id", "source")
      SELECT DISTINCT c."id", b."user_id", 'broadcast'
      FROM "conversations" c
      JOIN "channels" ch ON ch."id" = c."channel_id"
        AND ch."provider" IN (${FIRST_REPLY_PROVIDERS_SQL})
      JOIN "broadcasts" b ON b."account_id" = c."account_id" AND b."channel_id" = c."channel_id"
        AND b."user_id" IS NOT NULL
      JOIN "broadcast_recipients" r ON r."broadcast_id" = b."id"
        AND r."contact_id" = c."contact_id"
        AND r."sent_at" IS NOT NULL
        AND r."sent_at" >= now() - ${FIRST_REPLY_WINDOW}
      WHERE c."id" = ${conversationId}::uuid
        AND c."account_id" = ${accountId}::uuid
        AND c."contact_id" = ${contactId}::uuid
        AND c."channel_id" = ${channelId}::uuid
        AND c."is_private" = false
      ON CONFLICT ("conversation_id", "user_id") DO NOTHING
      RETURNING "user_id"
    `)
    if (res.rows.length === 0) return
    // A lista de quem acabou de ganhar acesso já recebeu o conversation.created
    // antes do vínculo; repete o ping pra conversa aparecer sem recarregar.
    try {
      const { publishEvent } = await import('@/lib/events/publish')
      await publishEvent(accountId, { type: 'conversation.created', conversationId })
    } catch (evErr) {
      console.error('[broadcast-link] aviso da 1ª resposta falhou', { conversationId }, evErr)
    }
  } catch (err) {
    console.error('[broadcast-link] vincular na 1ª resposta falhou', { accountId, conversationId, channelId }, err)
  }
}

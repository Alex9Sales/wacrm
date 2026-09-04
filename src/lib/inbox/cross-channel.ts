// ============================================================
// 🔀 O mesmo cliente falando com MAIS DE UM canal da mesma conta.
//
// Nasceu do caso Jordy (04/09, Família do Gás): ele perguntou o preço na
// Família do Gás 1, depois no Aliança Gás e no Aliança Gás 2. Como o contato é
// UM SÓ entre os canais, a IA já reconhece e aplica a política de preço que o
// cliente configurou — isso já funcionava e não se mexe aqui.
//
// O que faltava era o time SABER. Este módulo só avisa, por nota interna:
// nada é enviado ao cliente, nada muda no atendimento, nenhum preço é tocado.
//
// Parte pura (texto e decisão) separada do banco, para ter teste.
// Sem 'server-only' — o inbound roda no worker.
// ============================================================

import { and, desc, eq, ne, sql } from 'drizzle-orm'

import { db, channels, contacts, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** Uma conversa desse mesmo contato em OUTRO canal. */
export interface OtherChannelTouch {
  conversationId: string
  channelName: string
  /** Última mensagem do cliente lá (ISO). */
  lastCustomerAt: string
  /** O que NÓS respondemos por último naquele canal (para o time comparar). */
  lastOutboundText: string | null
}

/** Quanto tempo para trás conta como "está falando com os dois agora". */
export const CROSS_CHANNEL_WINDOW_HOURS = 24

/** Não repete o aviso na mesma conversa dentro deste prazo. */
export const CROSS_CHANNEL_NOTE_COOLDOWN_HOURS = 12

function quandoRelativo(iso: string, agora = new Date()): string {
  const ms = agora.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'há pouco'
  const min = Math.floor(ms / 60_000)
  if (min < 2) return 'agora há pouco'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h}h`
  return `há ${Math.floor(h / 24)}d`
}

/**
 * A nota que o time vê. Escrita para ser lida em dois segundos no meio de um
 * atendimento: quem, onde, quando e o que a gente já respondeu lá.
 */
export function crossChannelNote(
  contactName: string | null,
  others: OtherChannelTouch[],
  agora = new Date(),
): string | null {
  if (others.length === 0) return null

  const quem = (contactName || 'Este cliente').trim()
  const linhas = others.map((o) => {
    const resposta = o.lastOutboundText
      ? ` — respondemos lá: "${o.lastOutboundText.replace(/\s+/g, ' ').slice(0, 110)}"`
      : ''
    return `• ${o.channelName}, ${quandoRelativo(o.lastCustomerAt, agora)}${resposta}`
  })

  const cabeca =
    others.length === 1
      ? `🔀 ${quem} também está falando com outro canal seu:`
      : `🔀 ${quem} também está falando com outros ${others.length} canais seus:`

  return (
    `${cabeca}\n${linhas.join('\n')}\n\n` +
    'É a mesma pessoa (mesmo telefone), então o histórico e a política de preço já valem nos dois lados. ' +
    'Este aviso é só para você — o cliente não vê nada.'
  )
}

// ------------------------------------------------------------------ banco

/**
 * Avisa (por nota interna) quando o mesmo contato está ativo em outro canal.
 * Best-effort de ponta a ponta: qualquer falha aqui NÃO pode atrapalhar a
 * entrega da mensagem que acabou de chegar.
 */
export async function noteCrossChannelActivity(args: {
  accountId: string
  contactId: string
  conversationId: string
}): Promise<boolean> {
  try {
    // Já avisamos nesta conversa há pouco? Não repete a cada mensagem.
    const jaAvisou = firstOrNull(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, args.conversationId),
            eq(messages.isInternal, true),
            sql`${messages.contentText} LIKE '🔀 %'`,
            sql`${messages.createdAt} >= now() - (${CROSS_CHANNEL_NOTE_COOLDOWN_HOURS} || ' hours')::interval`,
          ),
        )
        .limit(1),
    )
    if (jaAvisou) return false

    // O canal desta conversa, para não comparar com ele mesmo.
    const atual = firstOrNull(
      await db
        .select({ channelId: conversations.channelId })
        .from(conversations)
        .where(eq(conversations.id, args.conversationId))
        .limit(1),
    )
    if (!atual?.channelId) return false

    // Outras conversas DESTE contato, em canais diferentes, com mensagem do
    // cliente dentro da janela.
    const outras = await db
      .select({
        conversationId: conversations.id,
        channelName: channels.name,
        lastCustomerAt: sql<string>`(
          SELECT max(m.created_at) FROM messages m
          WHERE m.conversation_id = ${conversations.id} AND m.sender_type = 'customer'
        )`,
      })
      .from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(
        and(
          eq(conversations.accountId, args.accountId),
          eq(conversations.contactId, args.contactId),
          ne(conversations.id, args.conversationId),
          ne(conversations.channelId, atual.channelId),
        ),
      )
      .limit(10)

    const agora = Date.now()
    const dentroDaJanela = outras.filter(
      (o) =>
        o.lastCustomerAt &&
        agora - new Date(o.lastCustomerAt).getTime() <= CROSS_CHANNEL_WINDOW_HOURS * 3_600_000,
    )
    if (dentroDaJanela.length === 0) return false

    // O que respondemos por último em cada um — é o que o time quer comparar
    // (foi 125 lá e 120 aqui?).
    const touches: OtherChannelTouch[] = []
    for (const o of dentroDaJanela.slice(0, 3)) {
      const ultima = firstOrNull(
        await db
          .select({ text: messages.contentText })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, o.conversationId),
              ne(messages.senderType, 'customer'),
              eq(messages.isInternal, false),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(1),
      )
      touches.push({
        conversationId: o.conversationId,
        channelName: o.channelName ?? 'outro canal',
        lastCustomerAt: o.lastCustomerAt,
        lastOutboundText: ultima?.text ?? null,
      })
    }

    const contato = firstOrNull(
      await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, args.contactId)).limit(1),
    )
    const texto = crossChannelNote(contato?.name ?? null, touches)
    if (!texto) return false

    await db.insert(messages).values({
      conversationId: args.conversationId,
      senderType: 'bot',
      contentType: 'text',
      contentText: texto,
      isInternal: true,
      status: 'sent',
    })
    return true
  } catch (err) {
    console.error('[cross-channel] aviso falhou:', err instanceof Error ? err.message : err)
    return false
  }
}

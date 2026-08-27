import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { db, messages, conversations } from '@/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

const AUDIO_KINDS = ['audio', 'voice', 'ptt']
const IMAGE_KINDS = ['image']
const DOC_KINDS = ['document']

/**
 * Carimbo "[DD/MM HH:mm] " da mensagem no fuso da conta — para a IA raciocinar
 * sobre QUANDO cada mensagem foi dita (há quanto tempo, se um horário agendado
 * já passou). Defensivo: sem createdAt válido, devolve '' (não carimba) — assim
 * os testes sem timestamp e qualquer linha estranha não quebram.
 */
function stampFor(createdAt: unknown, timezone: string): string {
  if (typeof createdAt !== 'string' || !createdAt) return ''
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const day = get('day')
    const month = get('month')
    if (!day || !month) return ''
    return `[${day}/${month} ${get('hour')}:${get('minute')}] `
  } catch {
    return ''
  }
}

/**
 * Remove um carimbo "[DD/MM HH:mm]" que o modelo às vezes COPIA do histórico
 * pro início da própria resposta — o carimbo é metadata só pra ele raciocinar,
 * e vazava feio pro cliente ("[16/08 11:00] Sim, é bem prático…"). Tira só do
 * início (não mexe em datas legítimas no meio do texto). Idempotente.
 */
export function stripLeadingTimestamp(text: string): string {
  return text.replace(/^\s*\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\]\s*/, '')
}

/**
 * Fetch the last N text/audio/image messages of a conversation and map them to
 * the provider-neutral chat shape. Customer messages become `user`; agent and
 * bot messages become `assistant`.
 *
 * Áudio: usa a TRANSCRIÇÃO (quando a transcrição de áudio está ligada nas
 * configurações), prefixada com "[áudio]" nas mensagens do cliente para a IA
 * saber que a pessoa mandou áudio. Imagem: usa a DESCRIÇÃO de visão (guardada na
 * transcrição no recebimento), prefixada com "[imagem]" — só entra quando há
 * descrição. Vídeo/doc ficam de fora. Notas internas nunca entram (vazariam).
 *
 * Ordered oldest-first (chronological) so the transcript reads naturally and
 * the most recent customer message lands last.
 */
/**
 * "Não perde venda" — resumo do que este MESMO contato falou em OUTRAS conversas
 * (ex.: mandou mensagem pra outro número de WhatsApp da loja). O contato é o
 * mesmo (mesmo telefone → mesmo contato na conta), então dá pra dar continuidade:
 * se o cliente já perguntou preço e recuou num número, a IA reconhece no outro e
 * já oferece o desconto. Devolve um bloco de texto (Cliente/Atendimento carimbado)
 * ou null quando não há histórico em outras conversas. Best-effort: erro → null.
 */
export async function loadContactHistoryDigest(
  accountId: string,
  contactId: string | null,
  currentConversationId: string,
  timezone: string = 'America/Sao_Paulo',
  limit = 14,
): Promise<string | null> {
  if (!contactId) return null
  let rows: {
    senderType: string
    contentType: string
    contentText: string | null
    transcription: string | null
    createdAt: string | null
  }[]
  try {
    rows = await db
      .select({
        senderType: messages.senderType,
        contentType: messages.contentType,
        contentText: messages.contentText,
        transcription: messages.transcription,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.contactId, contactId),
          ne(conversations.id, currentConversationId),
          eq(messages.isInternal, false),
          inArray(messages.contentType, ['text', ...AUDIO_KINDS, ...IMAGE_KINDS]),
          gte(messages.createdAt, sql`now() - interval '30 days'`),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)
  } catch {
    return null
  }
  const lines = rows
    .reverse()
    .map((m) => {
      const isMedia =
        AUDIO_KINDS.includes(m.contentType) || IMAGE_KINDS.includes(m.contentType)
      const raw = ((isMedia ? m.transcription : m.contentText) ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 160)
      if (!raw) return null
      const who = m.senderType === 'customer' ? 'Cliente' : 'Atendimento'
      return `${stampFor(m.createdAt, timezone)}${who}: ${raw}`
    })
    .filter((l): l is string => l !== null)
  return lines.length ? lines.join('\n') : null
}

export async function buildConversationContext(
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  timezone: string = 'America/Sao_Paulo',
): Promise<ChatMessage[]> {
  const rows = await db
    .select({
      senderType: messages.senderType,
      contentType: messages.contentType,
      contentText: messages.contentText,
      transcription: messages.transcription,
      createdAt: messages.createdAt,
      replyToMessageId: messages.replyToMessageId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.contentType, [
          'text',
          ...AUDIO_KINDS,
          ...IMAGE_KINDS,
          ...DOC_KINDS,
        ]),
        eq(messages.isInternal, false),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)

  // Citações: quando a msg RESPONDE outra (reply do WhatsApp), busca o texto
  // citado pra IA saber a que o "Sim"/"Isso"/"Não" se refere. Sem isso o modelo
  // recebia a resposta solta, ficava inseguro e transferia à toa (26/08:
  // Vanuza/Glauciane/Wagner — venda pronta travando no reply).
  const quotedIds = Array.from(
    new Set(
      rows
        .map((r) => r.replyToMessageId)
        .filter((id): id is string => typeof id === 'string' && !!id),
    ),
  )
  const quotePrefixById = new Map<string, string>()
  if (quotedIds.length > 0) {
    try {
      const quoted = await db
        .select({
          id: messages.id,
          senderType: messages.senderType,
          contentText: messages.contentText,
          transcription: messages.transcription,
        })
        .from(messages)
        .where(inArray(messages.id, quotedIds))
      for (const q of quoted) {
        const txt = (q.contentText || q.transcription || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120)
        if (!txt) continue
        const who = q.senderType === 'customer' ? 'do cliente' : 'sua'
        quotePrefixById.set(q.id, `[em resposta à mensagem ${who}: "${txt}"] `)
      }
    } catch {
      /* best-effort — sem a citação o contexto segue como antes */
    }
  }

  return rows
    .reverse()
    .map((m) => {
      const isAudio = AUDIO_KINDS.includes(m.contentType)
      const isImage = IMAGE_KINDS.includes(m.contentType)
      const isDoc = DOC_KINDS.includes(m.contentType)
      // Áudio/imagem/doc → transcrição (descrição de visão/resumo do doc); texto → texto.
      const raw =
        (isAudio || isImage || isDoc ? m.transcription : m.contentText) ?? ''
      let trimmed = raw.trim()
      const isCustomer = m.senderType === 'customer'
      // Mídia do cliente SEM leitura (visão/extração desligada ou falhou): não
      // descarta — sinaliza que chegou, senão a IA responde como se nada tivesse
      // vindo e pede de novo (bug real visto em produção).
      if (!trimmed && isImage && isCustomer) {
        trimmed = 'o cliente enviou uma foto (sem descrição disponível)'
      }
      if (!trimmed && isDoc && isCustomer) {
        trimmed = 'o cliente enviou um documento (sem leitura disponível)'
      }
      if (!trimmed) return null
      // Marca o canal p/ a IA reconhecer (útil p/ decidir responder em áudio
      // quando a pessoa mandou áudio, e p/ saber que a pessoa mandou uma foto/doc).
      const prefix =
        isCustomer && isAudio
          ? '[áudio] '
          : isCustomer && isImage
            ? '[imagem] '
            : isCustomer && isDoc
              ? '[documento] '
              : ''
      // Carimbo de data/hora no início (metadata p/ a IA; o prompt manda não repetir).
      const stamp = stampFor(m.createdAt, timezone)
      const quote = m.replyToMessageId
        ? (quotePrefixById.get(m.replyToMessageId) ?? '')
        : ''
      return {
        role: isCustomer ? ('user' as const) : ('assistant' as const),
        content: `${stamp}${prefix}${quote}${trimmed}`,
      }
    })
    .filter((m): m is ChatMessage => m !== null)
}

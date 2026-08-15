import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, messages } from '@/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

const AUDIO_KINDS = ['audio', 'voice', 'ptt']
const IMAGE_KINDS = ['image']

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
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.contentType, ['text', ...AUDIO_KINDS, ...IMAGE_KINDS]),
        eq(messages.isInternal, false),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)

  return rows
    .reverse()
    .map((m) => {
      const isAudio = AUDIO_KINDS.includes(m.contentType)
      const isImage = IMAGE_KINDS.includes(m.contentType)
      // Áudio/imagem → transcrição (descrição de visão p/ imagem); texto → texto.
      const raw = (isAudio || isImage ? m.transcription : m.contentText) ?? ''
      let trimmed = raw.trim()
      const isCustomer = m.senderType === 'customer'
      // Imagem do cliente SEM descrição (visão desligada/falhou): não descarta —
      // sinaliza que uma foto chegou, senão a IA responde como se nada tivesse
      // vindo e acaba pedindo a imagem de novo (bug real visto em produção).
      if (!trimmed && isImage && isCustomer) {
        trimmed = 'o cliente enviou uma foto (sem descrição disponível)'
      }
      if (!trimmed) return null
      // Marca o canal p/ a IA reconhecer (útil p/ decidir responder em áudio
      // quando a pessoa mandou áudio, e p/ saber que a pessoa mandou uma foto).
      const prefix =
        isCustomer && isAudio ? '[áudio] ' : isCustomer && isImage ? '[imagem] ' : ''
      // Carimbo de data/hora no início (metadata p/ a IA; o prompt manda não repetir).
      const stamp = stampFor(m.createdAt, timezone)
      return {
        role: isCustomer ? ('user' as const) : ('assistant' as const),
        content: `${stamp}${prefix}${trimmed}`,
      }
    })
    .filter((m): m is ChatMessage => m !== null)
}

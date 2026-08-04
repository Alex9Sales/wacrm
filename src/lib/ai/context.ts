import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, messages } from '@/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

const AUDIO_KINDS = ['audio', 'voice', 'ptt']
const IMAGE_KINDS = ['image']

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
): Promise<ChatMessage[]> {
  const rows = await db
    .select({
      senderType: messages.senderType,
      contentType: messages.contentType,
      contentText: messages.contentText,
      transcription: messages.transcription,
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
      const trimmed = raw.trim()
      if (!trimmed) return null
      const isCustomer = m.senderType === 'customer'
      // Marca o canal p/ a IA reconhecer (útil p/ decidir responder em áudio
      // quando a pessoa mandou áudio, e p/ saber que a pessoa mandou uma foto).
      const prefix =
        isCustomer && isAudio ? '[áudio] ' : isCustomer && isImage ? '[imagem] ' : ''
      return {
        role: isCustomer ? ('user' as const) : ('assistant' as const),
        content: `${prefix}${trimmed}`,
      }
    })
    .filter((m): m is ChatMessage => m !== null)
}

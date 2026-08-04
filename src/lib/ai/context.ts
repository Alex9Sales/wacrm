import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, messages } from '@/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

const AUDIO_KINDS = ['audio', 'voice', 'ptt']

/**
 * Fetch the last N text/audio messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent and bot
 * messages become `assistant`.
 *
 * Áudio: usa a TRANSCRIÇÃO (quando a transcrição de áudio está ligada nas
 * configurações), prefixada com "[áudio]" nas mensagens do cliente para a IA
 * saber que a pessoa mandou áudio. Outras mídias (imagem/vídeo/doc) ficam de
 * fora — não carregam texto. Notas internas nunca entram (vazariam na resposta).
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
        inArray(messages.contentType, ['text', ...AUDIO_KINDS]),
        eq(messages.isInternal, false),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)

  return rows
    .reverse()
    .map((m) => {
      const isAudio = AUDIO_KINDS.includes(m.contentType)
      // Áudio → transcrição; texto → o próprio texto.
      const raw = (isAudio ? m.transcription : m.contentText) ?? ''
      const trimmed = raw.trim()
      if (!trimmed) return null
      const isCustomer = m.senderType === 'customer'
      return {
        role: isCustomer ? ('user' as const) : ('assistant' as const),
        // Marca o áudio do cliente pra IA reconhecer o canal (útil pra decidir
        // responder em áudio quando a pessoa mandou áudio).
        content: isAudio && isCustomer ? `[áudio] ${trimmed}` : trimmed,
      }
    })
    .filter((m): m is ChatMessage => m !== null)
}

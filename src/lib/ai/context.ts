import { and, desc, eq } from 'drizzle-orm'
import { db, messages } from '@/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const rows = await db
    .select({
      senderType: messages.senderType,
      contentText: messages.contentText,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.contentType, 'text'),
        // NEVER feed internal notes to the AI: they're team-only and would
        // otherwise leak to the customer in the model's reply.
        eq(messages.isInternal, false),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)

  return rows
    .reverse()
    .filter((m) => m.contentText && m.contentText.trim())
    .map((m) => ({
      role: m.senderType === 'customer' ? ('user' as const) : ('assistant' as const),
      content: m.contentText!.trim(),
    }))
}

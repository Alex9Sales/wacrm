// ============================================================
// 👀 "Visto" pro cliente quando alguém ABRE a conversa no CRM — como no
// WhatsApp Web. 19/09 (GoLink): respondendo pelo CRM, o cliente nunca via que
// a mensagem dele tinha sido lida. Só engines com a operação (WAHA); grupo
// fica de fora; nunca lança (é cosmético, não pode travar a tela).
// Sem 'server-only' — alcançável pelo worker.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

export async function sendSeenForConversation(accountId: string, conversationId: string): Promise<void> {
  try {
    const row = firstOrNull(
      await db
        .select({ channelId: conversations.channelId, phone: contacts.phone, isGroup: contacts.isGroup })
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
        .limit(1),
    )
    if (!row?.channelId || !row.phone || row.isGroup) return
    const channel = await loadChannel(row.channelId)
    if (!channel || channel.accountId !== accountId) return
    const provider = getProvider(channel.provider)
    if (!provider.sendSeen) return
    await provider.sendSeen(channel, sanitizePhoneForMeta(row.phone))
  } catch (err) {
    console.warn('[send-seen] falhou:', err instanceof Error ? err.message : err)
  }
}

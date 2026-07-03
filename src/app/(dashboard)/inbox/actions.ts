'use server'

// ============================================================
// Server actions for the Inbox page shell. Replaces the Supabase
// browser-client queries page.tsx used pre-Drizzle (conversation
// hydration + WhatsApp connection check). Account-scoped — there
// is no RLS anymore.
// ============================================================

import { and, eq } from 'drizzle-orm'
import { db, contacts, contactTags, conversations, tags, whatsappConfig } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Contact, Conversation, ConversationStatus, Tag } from '@/types'

/**
 * One conversation with its contact (and the contact's tags) embedded —
 * the same normalized shape the old `CONVERSATION_SELECT` +
 * `normalizeConversation` pipeline produced. Returns null when the
 * conversation doesn't exist or belongs to another account.
 */
export async function getConversationWithContact(
  conversationId: string,
): Promise<Conversation | null> {
  const ctx = await getCurrentAccount()

  const row = firstOrNull(
    await db
      .select({
        id: conversations.id,
        user_id: conversations.userId,
        account_id: conversations.accountId,
        contact_id: conversations.contactId,
        status: conversations.status,
        assigned_agent_id: conversations.assignedAgentId,
        last_message_text: conversations.lastMessageText,
        last_message_at: conversations.lastMessageAt,
        unread_count: conversations.unreadCount,
        ai_autoreply_disabled: conversations.aiAutoreplyDisabled,
        ai_reply_count: conversations.aiReplyCount,
        created_at: conversations.createdAt,
        updated_at: conversations.updatedAt,
        contact: {
          id: contacts.id,
          user_id: contacts.userId,
          account_id: contacts.accountId,
          phone: contacts.phone,
          phone_normalized: contacts.phoneNormalized,
          name: contacts.name,
          email: contacts.email,
          company: contacts.company,
          avatar_url: contacts.avatarUrl,
          created_at: contacts.createdAt,
          updated_at: contacts.updatedAt,
        },
      })
      .from(conversations)
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!row) return null

  let contactTagsList: Tag[] = []
  if (row.contact?.id) {
    contactTagsList = (await db
      .select({
        id: tags.id,
        user_id: tags.userId,
        account_id: tags.accountId,
        name: tags.name,
        color: tags.color,
        created_at: tags.createdAt,
      })
      .from(contactTags)
      .innerJoin(tags, eq(contactTags.tagId, tags.id))
      .where(eq(contactTags.contactId, row.contact.id))) as unknown as Tag[]
  }

  const { contact, ...conv } = row
  return {
    ...conv,
    status: conv.status as ConversationStatus,
    unread_count: conv.unread_count ?? 0,
    contact: contact?.id
      ? ({ ...contact, tags: contactTagsList } as unknown as Contact)
      : undefined,
  } as unknown as Conversation
}

/**
 * Whether the caller's account has a connected WhatsApp config.
 * whatsapp_config is one-row-per-account post-multi-user.
 */
export async function getWhatsappConnected(): Promise<boolean> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({ status: whatsappConfig.status })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, ctx.accountId))
      .limit(1),
  )
  return row?.status === 'connected'
}

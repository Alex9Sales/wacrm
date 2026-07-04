'use server'

// ============================================================
// Server actions for the Inbox page shell. Replaces the Supabase
// browser-client queries page.tsx used pre-Drizzle (conversation
// hydration + WhatsApp connection check). Account-scoped — there
// is no RLS anymore.
// ============================================================

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  db,
  contactNotes,
  contacts,
  contactTags,
  conversations,
  deals,
  member,
  messageReactions,
  messageTemplates,
  messages,
  pipelineStages,
  tags,
  user,
  channels,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type {
  Contact,
  Conversation,
  ConversationStatus,
  ContactNote,
  Deal,
  Message,
  MessageReaction,
  MessageTemplate,
  Profile,
  Tag,
} from '@/types'

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
 * Whether the caller's account has a connected WhatsApp channel.
 * Backed by the `channels` table (Phase 4) — connected when any
 * channel on the account is live.
 */
export async function getWhatsappConnected(): Promise<boolean> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({ status: channels.status })
      .from(channels)
      .where(
        and(
          eq(channels.accountId, ctx.accountId),
          eq(channels.status, 'connected'),
        ),
      )
      .limit(1),
  )
  return row?.status === 'connected'
}

// ============================================================
// Column maps (camelCase Drizzle → snake_case component shapes).
// ============================================================

const conversationColumns = {
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
}

const contactColumns = {
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
}

const tagColumns = {
  id: tags.id,
  user_id: tags.userId,
  account_id: tags.accountId,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
}

const messageColumns = {
  id: messages.id,
  conversation_id: messages.conversationId,
  sender_type: messages.senderType,
  sender_id: messages.senderId,
  content_type: messages.contentType,
  content_text: messages.contentText,
  media_url: messages.mediaUrl,
  template_name: messages.templateName,
  message_id: messages.messageId,
  status: messages.status,
  reply_to_message_id: messages.replyToMessageId,
  interactive_reply_id: messages.interactiveReplyId,
  created_at: messages.createdAt,
}

const reactionColumns = {
  id: messageReactions.id,
  message_id: messageReactions.messageId,
  conversation_id: messageReactions.conversationId,
  actor_type: messageReactions.actorType,
  actor_id: messageReactions.actorId,
  emoji: messageReactions.emoji,
  created_at: messageReactions.createdAt,
}

const noteColumns = {
  id: contactNotes.id,
  contact_id: contactNotes.contactId,
  user_id: contactNotes.userId,
  note_text: contactNotes.noteText,
  created_at: contactNotes.createdAt,
}

const dealColumns = {
  id: deals.id,
  user_id: deals.userId,
  account_id: deals.accountId,
  pipeline_id: deals.pipelineId,
  stage_id: deals.stageId,
  contact_id: deals.contactId,
  conversation_id: deals.conversationId,
  assigned_to: deals.assignedTo,
  title: deals.title,
  value: deals.value,
  currency: deals.currency,
  notes: deals.notes,
  expected_close_date: deals.expectedCloseDate,
  status: deals.status,
  created_at: deals.createdAt,
  updated_at: deals.updatedAt,
}

const templateColumns = {
  id: messageTemplates.id,
  user_id: messageTemplates.userId,
  account_id: messageTemplates.accountId,
  name: messageTemplates.name,
  category: messageTemplates.category,
  language: messageTemplates.language,
  header_type: messageTemplates.headerType,
  header_content: messageTemplates.headerContent,
  header_handle: messageTemplates.headerHandle,
  header_media_url: messageTemplates.headerMediaUrl,
  body_text: messageTemplates.bodyText,
  footer_text: messageTemplates.footerText,
  buttons: messageTemplates.buttons,
  sample_values: messageTemplates.sampleValues,
  status: messageTemplates.status,
  meta_template_id: messageTemplates.metaTemplateId,
  rejection_reason: messageTemplates.rejectionReason,
  quality_score: messageTemplates.qualityScore,
  submission_error: messageTemplates.submissionError,
  created_at: messageTemplates.createdAt,
  updated_at: messageTemplates.updatedAt,
}

// ============================================================
// Conversation list (ConversationList component)
// ============================================================

/**
 * All of the account's conversations, ordered by last activity (desc),
 * each with its contact and the contact's tags embedded — the normalized
 * shape the old `CONVERSATION_SELECT` + `normalizeConversations` pipeline
 * produced for the inbox list. Account-scoped.
 */
export async function listConversations(): Promise<Conversation[]> {
  const ctx = await getCurrentAccount()

  const rows = await db
    .select({ ...conversationColumns, contact: contactColumns })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(eq(conversations.accountId, ctx.accountId))
    .orderBy(desc(conversations.lastMessageAt))

  const contactIds = Array.from(
    new Set(rows.map((r) => r.contact?.id).filter((id): id is string => !!id)),
  )

  // One round-trip for every contact's tags, then bucket by contact_id.
  const tagsByContact = new Map<string, Tag[]>()
  if (contactIds.length > 0) {
    const tagRows = await db
      .select({ contact_id: contactTags.contactId, ...tagColumns })
      .from(contactTags)
      .innerJoin(tags, eq(contactTags.tagId, tags.id))
      .where(inArray(contactTags.contactId, contactIds))
    for (const { contact_id, ...tag } of tagRows) {
      const bucket = tagsByContact.get(contact_id)
      if (bucket) bucket.push(tag as unknown as Tag)
      else tagsByContact.set(contact_id, [tag as unknown as Tag])
    }
  }

  return rows.map((row) => {
    const { contact, ...conv } = row
    return {
      ...conv,
      status: conv.status as ConversationStatus,
      unread_count: conv.unread_count ?? 0,
      contact: contact?.id
        ? ({
            ...contact,
            tags: tagsByContact.get(contact.id) ?? [],
          } as unknown as Contact)
        : undefined,
    } as unknown as Conversation
  })
}

/** All of the account's tags, ordered by name (inbox filter picker). */
export async function listTags(): Promise<Tag[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(tagColumns)
    .from(tags)
    .where(eq(tags.accountId, ctx.accountId))
    .orderBy(asc(tags.name))
  return rows as unknown as Tag[]
}

// ============================================================
// Message thread (MessageThread component)
// ============================================================

/** Guard: verify a conversation belongs to the caller's account. */
async function assertConversationInAccount(
  conversationId: string,
  accountId: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1),
  )
  return !!row
}

/**
 * All members of the caller's account, mapped into the legacy Profile
 * shape (assignee dropdown). Assignments target `user.id`, so `user_id`
 * — the value the UI matches against `conversations.assigned_agent_id`
 * — is the user's id. Account tenancy comes from `member.organizationId`
 * and the role from `member.role`.
 */
export async function listProfiles(): Promise<Profile[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: user.id,
      user_id: user.id,
      full_name: user.name,
      email: user.email,
      avatar_url: user.image,
      role: member.role,
      account_id: member.organizationId,
      account_role: member.role,
      created_at: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.accountId))
    .orderBy(asc(user.name))
  return rows as unknown as Profile[]
}

/** Messages for one conversation, ascending by creation time. */
export async function listMessages(conversationId: string): Promise<Message[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertConversationInAccount(conversationId, ctx.accountId))) {
    return []
  }
  const rows = await db
    .select(messageColumns)
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
  return rows as unknown as Message[]
}

/** Reactions for one conversation. */
export async function listReactions(
  conversationId: string,
): Promise<MessageReaction[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertConversationInAccount(conversationId, ctx.accountId))) {
    return []
  }
  const rows = await db
    .select(reactionColumns)
    .from(messageReactions)
    .where(eq(messageReactions.conversationId, conversationId))
  return rows as unknown as MessageReaction[]
}

/** Reset a conversation's unread_count to 0 (mark read). Account-scoped. */
export async function markConversationRead(
  conversationId: string,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
}

/** Update a conversation's status. Account-scoped. */
export async function updateConversationStatus(
  conversationId: string,
  status: ConversationStatus,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(conversations)
    .set({ status })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
}

/** Assign / unassign a conversation. Account-scoped. */
export async function updateConversationAssignment(
  conversationId: string,
  assignedAgentId: string | null,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(conversations)
    .set({ assignedAgentId })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
}

// ============================================================
// Contact sidebar (ContactSidebar component)
// ============================================================

/** Deals for a contact (with stage embedded), newest first. Account-scoped. */
export async function listContactDeals(contactId: string): Promise<Deal[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      ...dealColumns,
      stage: {
        id: pipelineStages.id,
        pipeline_id: pipelineStages.pipelineId,
        name: pipelineStages.name,
        position: pipelineStages.position,
        color: pipelineStages.color,
        created_at: pipelineStages.createdAt,
      },
    })
    .from(deals)
    .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
    .where(and(eq(deals.contactId, contactId), eq(deals.accountId, ctx.accountId)))
    .orderBy(desc(deals.createdAt))
  return rows.map((r) => {
    const { stage, ...deal } = r
    return {
      ...deal,
      value: Number(deal.value),
      stage: stage?.id ? stage : undefined,
    }
  }) as unknown as Deal[]
}

/** Notes for a contact, newest first. Account-scoped. */
export async function listContactNotes(
  contactId: string,
): Promise<ContactNote[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(noteColumns)
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.contactId, contactId),
        eq(contactNotes.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(contactNotes.createdAt))
  return rows as unknown as ContactNote[]
}

/** Tags on a contact, each carrying its contact_tag row id. Account-scoped. */
export async function listContactTagsWithJoinId(
  contactId: string,
): Promise<(Tag & { contact_tag_id: string })[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ contact_tag_id: contactTags.id, ...tagColumns })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
    .where(
      and(
        eq(contactTags.contactId, contactId),
        eq(contacts.accountId, ctx.accountId),
      ),
    )
  return rows as unknown as (Tag & { contact_tag_id: string })[]
}

/**
 * Insert a note on a contact. Author (user_id) + account are derived from
 * the caller's session — the client never passes them. Returns the created
 * row, or null when the contact isn't in the caller's account.
 */
export async function addContactNote(
  contactId: string,
  noteText: string,
): Promise<ContactNote | null> {
  const ctx = await getCurrentAccount()
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!owned) return null

  const inserted = firstOrNull(
    await db
      .insert(contactNotes)
      .values({
        contactId,
        userId: ctx.userId,
        accountId: ctx.accountId,
        noteText,
      })
      .returning(noteColumns),
  )
  return (inserted as unknown as ContactNote) ?? null
}

// ============================================================
// Template picker (TemplatePicker component)
// ============================================================

/** Approved WhatsApp templates for the account, newest first. Account-scoped. */
export async function listApprovedTemplates(): Promise<MessageTemplate[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(templateColumns)
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.accountId, ctx.accountId),
        eq(messageTemplates.status, 'APPROVED'),
      ),
    )
    .orderBy(desc(messageTemplates.createdAt))
  return rows as unknown as MessageTemplate[]
}

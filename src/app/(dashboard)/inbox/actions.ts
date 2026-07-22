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
  groupParticipantNames,
  messageReactions,
  messageTemplates,
  messages,
  pipelineStages,
  tags,
  user,
  channels,
  sectors,
  quickReplies,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  requireRole,
  type AccountContext,
} from '@/lib/auth/account'
import {
  conversationVisibility,
  canSeeConversation,
} from '@/lib/sectors/access'
import { formatConversationPreview } from '@/lib/inbox/preview'
import type {
  ChannelProvider,
  Contact,
  Conversation,
  ConversationChannel,
  ConversationPriority,
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
        priority: conversations.priority,
        assigned_agent_id: conversations.assignedAgentId,
        sector_id: conversations.sectorId,
        transfer_note: conversations.transferNote,
        transfer_note_at: conversations.transferNoteAt,
        transfer_note_by: conversations.transferNoteBy,
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
        channel: channelColumns,
      })
      .from(conversations)
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .leftJoin(channels, eq(conversations.channelId, channels.id))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!row) return null
  // Sector privacy: hide a conversation an agent isn't allowed to see.
  if (
    !(await canSeeConversation(
      ctx.role,
      ctx.userId,
      row.sector_id,
      row.assigned_agent_id,
      conversationId,
    ))
  ) {
    return null
  }

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

  // Resolve who wrote the handoff note (for the transfer banner).
  let transferNoteByName: string | null = null
  if (row.transfer_note && row.transfer_note_by) {
    const u = firstOrNull(
      await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, row.transfer_note_by))
        .limit(1),
    )
    transferNoteByName = u?.name ?? null
  }

  const { contact, channel, ...conv } = row
  return {
    ...conv,
    status: conv.status as ConversationStatus,
    priority: (conv.priority ?? 'none') as ConversationPriority,
    unread_count: conv.unread_count ?? 0,
    transfer_note_by_name: transferNoteByName,
    contact: contact?.id
      ? ({ ...contact, tags: contactTagsList } as unknown as Contact)
      : undefined,
    channel: normalizeChannel(channel),
  } as unknown as Conversation
}

/** Shape the joined `channels` row into the client `ConversationChannel`,
 *  or `undefined` for a legacy NULL channel_id. A leftJoin yields every
 *  column null (typed non-null per column by Drizzle) when there's no
 *  match, so we defensively null-check each field. */
function normalizeChannel(
  channel: { id: string; provider: string; name: string } | null,
): ConversationChannel | undefined {
  if (!channel?.id || !channel.provider) return undefined
  return {
    id: channel.id,
    provider: channel.provider as ChannelProvider,
    name: channel.name ?? '',
  }
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
  priority: conversations.priority,
  assigned_agent_id: conversations.assignedAgentId,
  sector_id: conversations.sectorId,
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
  is_group: contacts.isGroup,
  created_at: contacts.createdAt,
  updated_at: contacts.updatedAt,
}

// The conversation's channel — provider drives composer capability
// gating (templates/interactive) and the inbox channel badge (Wave 4B).
const channelColumns = {
  id: channels.id,
  provider: channels.provider,
  name: channels.name,
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
  transcription: messages.transcription,
  view_once: messages.viewOnce,
  is_internal: messages.isInternal,
  author_key: messages.authorKey,
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

  // Sector privacy: non-admins only see general (null-sector) conversations
  // plus the ones in sectors they belong to.
  const visibility = await conversationVisibility(ctx.role, ctx.userId)

  const rows = await db
    .select({
      ...conversationColumns,
      contact: contactColumns,
      channel: channelColumns,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(channels, eq(conversations.channelId, channels.id))
    .where(and(eq(conversations.accountId, ctx.accountId), visibility))
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
    const { contact, channel, ...conv } = row
    return {
      ...conv,
      status: conv.status as ConversationStatus,
      priority: (conv.priority ?? 'none') as ConversationPriority,
      unread_count: conv.unread_count ?? 0,
      contact: contact?.id
        ? ({
            ...contact,
            tags: tagsByContact.get(contact.id) ?? [],
          } as unknown as Contact)
        : undefined,
      channel: normalizeChannel(channel),
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

/** Guard: verify a conversation is in the caller's account AND visible to
 *  them under sector privacy (admins see all; agents only their sectors +
 *  the general queue). */
async function assertConversationInAccount(
  conversationId: string,
  ctx: AccountContext,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({
        id: conversations.id,
        sectorId: conversations.sectorId,
        assignedAgentId: conversations.assignedAgentId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!row) return false
  return canSeeConversation(
    ctx.role,
    ctx.userId,
    row.sectorId,
    row.assignedAgentId,
    conversationId,
  )
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
  if (!(await assertConversationInAccount(conversationId, ctx))) {
    return []
  }
  const rows = (await db
    .select(messageColumns)
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))) as unknown as Message[]

  // Resolve each group author's re-hosted photo (group_participant_names,
  // keyed by wa_key) in ONE batch query and attach it per message, so the inbox
  // can render a per-sender avatar. No-op for 1:1 threads (no author_key set).
  const authorKeys = Array.from(
    new Set(rows.map((r) => r.author_key).filter((k): k is string => !!k)),
  )
  if (authorKeys.length > 0) {
    const avatars = await db
      .select({
        waKey: groupParticipantNames.waKey,
        avatarUrl: groupParticipantNames.avatarUrl,
      })
      .from(groupParticipantNames)
      .where(
        and(
          eq(groupParticipantNames.accountId, ctx.accountId),
          inArray(groupParticipantNames.waKey, authorKeys),
        ),
      )
    const byKey = new Map(avatars.map((a) => [a.waKey, a.avatarUrl]))
    for (const r of rows) {
      if (r.author_key) r.author_avatar_url = byKey.get(r.author_key) ?? null
    }
  }
  return rows
}

/** Reactions for one conversation. */
export async function listReactions(
  conversationId: string,
): Promise<MessageReaction[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertConversationInAccount(conversationId, ctx))) {
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

/** Update a conversation's status. Account-scoped. Closing a conversation
 *  triggers the CSAT survey (when enabled). */
export async function updateConversationStatus(
  conversationId: string,
  status: ConversationStatus,
): Promise<void> {
  const ctx = await getCurrentAccount()
  // Was it open before this? Only survey on an open→closed transition.
  const prev = firstOrNull(
    await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  await db
    .update(conversations)
    .set({ status })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
  if (status === 'closed' && prev && prev.status !== 'closed') {
    const { sendCsatSurveyIfEnabled } = await import('@/lib/csat/csat')
    await sendCsatSurveyIfEnabled(ctx.accountId, conversationId)
  }
}

/**
 * Delete a conversation (and, via the `messages.conversation_id` ON DELETE
 * CASCADE FK, all of its messages + reactions). Account-scoped: the WHERE
 * clause pins both the id and the caller's account, so one account can
 * never delete another's conversation. Requires the 'agent' role or higher.
 * broadcast_recipients reference contacts, not conversations, so they're
 * unaffected. Returns `{ ok: true }`.
 */
export async function deleteConversation(
  conversationId: string,
): Promise<{ ok: true }> {
  const ctx = await requireRole('agent')
  await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
  return { ok: true }
}

/** Update a conversation's priority. Account-scoped. */
export async function updateConversationPriority(
  conversationId: string,
  priority: ConversationPriority,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(conversations)
    .set({ priority })
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
    .set({
      assignedAgentId,
      // Reset the SLA clock on (re)assignment so the new agent gets the
      // full window before auto-reassign can consider it again.
      assignedAt: assignedAgentId ? new Date().toISOString() : null,
    })
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

// ============================================================
// Sectors (departments) — pickers + moving a conversation.
// ============================================================

/** All sectors in the account (for the conversation picker + filter). */
export async function listSectors(): Promise<
  { id: string; name: string; color: string }[]
> {
  const ctx = await getCurrentAccount()
  return db
    .select({ id: sectors.id, name: sectors.name, color: sectors.color })
    .from(sectors)
    .where(eq(sectors.accountId, ctx.accountId))
    .orderBy(asc(sectors.name))
}

/** Move a conversation to a sector (or null = general queue). Agent+. */
export async function updateConversationSector(
  conversationId: string,
  sectorId: string | null,
): Promise<void> {
  const ctx = await requireRole('agent')
  if (sectorId) {
    const s = firstOrNull(
      await db
        .select({ id: sectors.id })
        .from(sectors)
        .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!s) throw new Error('Setor inválido.')
  }
  await db
    .update(conversations)
    .set({ sectorId })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
}

// ------------------------------------------------------------
// Quick replies (respostas rápidas) — read for the composer.
// Available to any member of the account (agents use them daily).
// Management (create/update/delete) lives in settings actions (admin).
// ------------------------------------------------------------

export interface QuickReplyOption {
  id: string
  shortcut: string
  content: string
}

export async function listQuickReplies(): Promise<QuickReplyOption[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: quickReplies.id,
      shortcut: quickReplies.shortcut,
      content: quickReplies.content,
    })
    .from(quickReplies)
    .where(eq(quickReplies.accountId, ctx.accountId))
    .orderBy(asc(quickReplies.shortcut))
  return rows
}

// ------------------------------------------------------------
// Lightweight preview for the new-message pop-up (contact name + snippet).
// Respects sector privacy — returns null for a conversation the caller
// isn't allowed to see (so no leaking a hidden sector's contact name).
// ------------------------------------------------------------

export interface ConversationPreview {
  name: string
  preview: string
}

export async function getConversationPreview(
  conversationId: string,
): Promise<ConversationPreview | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        sectorId: conversations.sectorId,
        assignedAgentId: conversations.assignedAgentId,
        lastMessageText: conversations.lastMessageText,
        contactName: contacts.name,
        contactPhone: contacts.phone,
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
  if (
    !(await canSeeConversation(
      ctx.role,
      ctx.userId,
      row.sectorId,
      row.assignedAgentId,
      conversationId,
    ))
  )
    return null
  // Friendly type label (🎤 Áudio / 📷 Foto / 📄 Documento …) for media whose
  // last_message_text is a bare `[kind]` placeholder; real text passes through.
  const label = formatConversationPreview(row.lastMessageText)
  return {
    name: row.contactName?.trim() || row.contactPhone || 'Cliente',
    preview: label === 'Nenhuma mensagem ainda' ? '' : label.slice(0, 80),
  }
}

// ------------------------------------------------------------
// Transfer a conversation to a sector — with an optional handoff note and
// auto-assignment to the least-loaded agent of that sector.
// ------------------------------------------------------------

export async function transferConversation(
  conversationId: string,
  sectorId: string,
  note?: string,
): Promise<void> {
  const ctx = await getCurrentAccount()

  const conv = firstOrNull(
    await db
      .select({
        id: conversations.id,
        sectorId: conversations.sectorId,
        assignedAgentId: conversations.assignedAgentId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!conv) throw new Error('Conversa não encontrada.')
  // Only someone who can see the conversation may transfer it.
  if (
    !(await canSeeConversation(
      ctx.role,
      ctx.userId,
      conv.sectorId,
      conv.assignedAgentId,
      conversationId,
    ))
  ) {
    throw new Error('Sem permissão para esta conversa.')
  }

  const sector = firstOrNull(
    await db
      .select({ id: sectors.id })
      .from(sectors)
      .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!sector) throw new Error('Setor inválido.')

  const { pickLeastLoadedSectorAgent } = await import('@/lib/sectors/routing')
  const assignedAgentId = await pickLeastLoadedSectorAgent(
    ctx.accountId,
    sectorId,
  )

  const trimmedNote = note?.trim() || null
  await db
    .update(conversations)
    .set({
      sectorId,
      ...(assignedAgentId
        ? { assignedAgentId, assignedAt: new Date().toISOString() }
        : {}),
      transferNote: trimmedNote,
      transferNoteAt: trimmedNote ? new Date().toISOString() : null,
      transferNoteBy: trimmedNote ? ctx.userId : null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )

  const { publishEvent } = await import('@/lib/events/publish')
  await publishEvent(ctx.accountId, {
    type: 'message.received',
    conversationId,
    fromMe: true, // internal change — no notification sound/pop-up
  })
}

/** Clear a conversation's handoff note (the receiving agent read it). */
export async function dismissTransferNote(
  conversationId: string,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(conversations)
    .set({ transferNote: null, transferNoteAt: null, transferNoteBy: null })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
}

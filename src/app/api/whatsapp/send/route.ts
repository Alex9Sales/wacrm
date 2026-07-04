import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    // Session + account context. Replaces the old Supabase cookie
    // client — every query below runs on the shared Drizzle client,
    // explicitly scoped by ctx.accountId (no RLS).
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }
    const accountId = ctx.accountId

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = await checkRateLimit(`send:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      let conv: { id: string } | null = null
      try {
        conv = firstOrNull(
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, conversationIdInput),
                eq(conversations.accountId, accountId)
              )
            )
            .limit(1)
        )
      } catch {
        // Malformed UUID → Postgres throws where PostgREST returned an
        // error object; both collapse to the same 404.
        conv = null
      }

      if (!conv) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = conv.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      let contactRow: { id: string } | null = null
      try {
        contactRow = firstOrNull(
          await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(eq(contacts.id, contact_id), eq(contacts.accountId, accountId))
            )
            .limit(1)
        )
      } catch {
        contactRow = null
      }

      if (!contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        accountId,
        ctx.userId,
        contact_id
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        replyToMessageId: reply_to_message_id,
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Account-scoped explicitly — there is no RLS on the
 * shared Drizzle client.
 */
async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const existing = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.contactId, contactId)
        )
      )
      .limit(1)
  )

  if (existing) return existing.id

  try {
    const created = firstOrNull(
      await db
        .insert(conversations)
        .values({
          accountId,
          userId,
          contactId,
        })
        .returning({ id: conversations.id })
    )
    return created?.id ?? null
  } catch (error) {
    console.error(
      'Error creating conversation for contact send:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}

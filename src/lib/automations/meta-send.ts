import { db, contacts, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { and, eq } from 'drizzle-orm'

import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import type { ChannelCtx } from '@/lib/channels/provider'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

// ------------------------------------------------------------
// Automation-side sender.
//
// Phase 4, wave 3A: this used to talk to Meta directly (whatsappConfig +
// meta-api). It now DELEGATES to the channel provider registry — resolve
// the conversation's channel (or the account's default channel when the
// engine has no conversation channel on hand) and dispatch via
// getProvider(channel.provider).sendText / .sendTemplate. The exported
// function names/signatures are unchanged so the automations engine keeps
// working; sends are still persisted with sender_type='bot'.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + channel lookups so an
   *  automation authored by user A still sends through the WhatsApp
   *  channel user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for audit/logs. Not
   *  consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaProvider({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaProvider({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

/**
 * Resolve the channel a send should go out on. Prefers the conversation's
 * own channel_id (so the send lands on the same number the customer is
 * talking to); falls back to the account's default channel for legacy
 * conversations with no channel_id. Returns a decrypted ChannelCtx.
 */
async function resolveSendChannel(
  accountId: string,
  conversationId: string,
): Promise<ChannelCtx> {
  const conv = firstOrNull(
    await db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1),
  )

  const channel = conv?.channelId
    ? await loadChannel(conv.channelId)
    : await loadDefaultChannel(accountId)

  if (!channel || channel.accountId !== accountId) {
    throw new Error('WhatsApp not configured for this account')
  }
  return channel
}

async function sendViaProvider(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  // Scope the contact lookup by account_id, not user_id. The engine runs
  // on the shared Drizzle client (no RLS); without this filter an
  // authenticated user could fire their own automations against another
  // tenant's contact UUID.
  const contact = firstOrNull(
    await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
      .limit(1),
  )
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const channel = await resolveSendChannel(input.accountId, input.conversationId)
  const provider = getProvider(channel.provider)

  // Capability gate: templates only exist on the official Meta channel.
  if (input.kind === 'template' && (!provider.capabilities.templates || !provider.sendTemplate)) {
    throw new Error('Templates só no canal oficial (Meta)')
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await provider.sendTemplate!(channel, phone, {
        name: input.templateName,
        language: input.language || 'en_US',
        params: { body: input.params ?? [] },
      })
      return r.externalMessageId
    }
    const r = await provider.sendText(channel, phone, input.text)
    return r.externalMessageId
  }

  // Phone-variant retry (Meta error #131030) is Meta-specific — other
  // providers resolve their own chatId or don't need it.
  const variants = provider.id === 'meta' ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (provider.id !== 'meta' || !isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.update(contacts).set({ phone: workingPhone }).where(eq(contacts.id, contact.id))
  }

  // Persist the sent message so it appears in the inbox with a real
  // provider message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null

  try {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      senderType: 'bot',
      contentType: content_type,
      contentText: content_text,
      templateName: template_name,
      messageId: waMessageId,
      status: 'sent',
    })
  } catch (msgErr) {
    // The provider already has the message; record the DB error but don't
    // pretend the send failed.
    const msg = msgErr instanceof Error ? msgErr.message : String(msgErr)
    throw new Error(`sent to provider but DB insert failed: ${msg}`)
  }

  await db
    .update(conversations)
    .set({
      lastMessageText:
        input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, input.conversationId))

  return { whatsapp_message_id: waMessageId }
}

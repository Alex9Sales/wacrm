import {
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
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
// Flows-side sender (text / media / interactive variants).
//
// Phase 4, wave 3A: this used to talk to Meta directly (whatsappConfig +
// meta-api). It now DELEGATES to the channel provider registry — resolve
// the conversation's channel (or the account's default channel) and
// dispatch via getProvider(channel.provider). Interactive button/list
// messages stay Meta-only (capability-gated) via provider.sendInteractive.
// The exported function names/signatures are unchanged so the flow runner
// keeps working; sends are persisted with sender_type='bot'.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + channel lookups so a flow
   *  authored by user A still sends through the WhatsApp channel user B
   *  saved on the same account. */
  accountId: string
  /** Original author of the flow — used for audit/logs. Not consulted for
   *  tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Shared tenancy-scoped lookups: the contact's phone (sanitized) and the
 * channel the conversation sends on. Prefers the conversation's channel_id;
 * falls back to the account's default channel for legacy conversations.
 */
async function loadContactAndChannel(
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<{
  contact: { id: string; phone: string }
  sanitized: string
  channel: ChannelCtx
}> {
  const contact = firstOrNull(
    await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

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

  return { contact: { id: contact.id, phone: contact.phone }, sanitized, channel }
}

/**
 * Run a send through the provider with the Meta-only phone-variant retry
 * (#131030). Returns the provider-side message id and, if a variant other
 * than the original landed, persists the corrected phone back to the
 * contact.
 */
async function dispatchWithRetry(
  channel: ChannelCtx,
  contactId: string,
  sanitized: string,
  send: (phone: string) => Promise<string>,
): Promise<string> {
  const provider = getProvider(channel.provider)
  const variants = provider.id === 'meta' ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await send(v)
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
    await db.update(contacts).set({ phone: workingPhone }).where(eq(contacts.id, contactId))
  }
  return waMessageId
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, sanitized, channel } = await loadContactAndChannel(
    args.accountId,
    args.contactId,
    args.conversationId,
  )
  const provider = getProvider(channel.provider)

  const waMessageId = await dispatchWithRetry(
    channel,
    contact.id,
    sanitized,
    async (phone) => (await provider.sendText(channel, phone, args.text)).externalMessageId,
  )

  try {
    await db.insert(messages).values({
      conversationId: args.conversationId,
      senderType: 'bot',
      contentType: 'text',
      contentText: args.text,
      messageId: waMessageId,
      status: 'sent',
    })
  } catch (msgErr) {
    const msg = msgErr instanceof Error ? msgErr.message : String(msgErr)
    throw new Error(`sent to provider but DB insert failed: ${msg}`)
  }

  await db
    .update(conversations)
    .set({
      lastMessageText: args.text,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, args.conversationId))

  return { whatsapp_message_id: waMessageId }
}

interface SendTypingEngineArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** true = start "digitando…", false = stop. */
  on: boolean
}

/**
 * Best-effort "digitando…" presence for the Flows engine (AI node
 * humanization). No-op on providers without typing support (e.g. Meta);
 * never throws — presence is cosmetic and must not affect the flow.
 */
export async function engineSendTyping(
  args: SendTypingEngineArgs,
): Promise<void> {
  try {
    const { sanitized, channel } = await loadContactAndChannel(
      args.accountId,
      args.contactId,
      args.conversationId,
    )
    const provider = getProvider(channel.provider)
    if (!provider.sendTyping || !provider.capabilities.typing) return
    await provider.sendTyping(channel, sanitized, args.on)
  } catch (err) {
    console.error(
      '[flows] engineSendTyping failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time (non-official providers download
   *  it → base64 inside their adapter). */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
  /** For AI voice notes: the text that was spoken, stored so the CRM
   *  thread shows a "Transcrição" under the bubble (same as inbound audio). */
  transcription?: string
}

/**
 * Send an image / video / document from the Flows engine.
 * Used by the runner's `send_media` node.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, sanitized, channel } = await loadContactAndChannel(
    args.accountId,
    args.contactId,
    args.conversationId,
  )
  const provider = getProvider(channel.provider)

  const waMessageId = await dispatchWithRetry(
    channel,
    contact.id,
    sanitized,
    async (phone) =>
      (
        await provider.sendMedia(channel, phone, {
          kind: args.kind,
          url: args.link,
          caption: args.caption,
          filename: args.filename,
        })
      ).externalMessageId,
  )

  const preview = args.caption?.trim() || `[${args.kind}]`
  try {
    await db.insert(messages).values({
      conversationId: args.conversationId,
      senderType: 'bot',
      contentType: args.kind,
      contentText: args.caption ?? null,
      // Persist the media URL so the CRM thread can render it — without
      // this the bubble has contentType='image' but no source and shows
      // "Imagem indisponível" (the media still reaches WhatsApp fine).
      mediaUrl: args.link,
      transcription: args.transcription ?? null,
      messageId: waMessageId,
      status: 'sent',
    })
  } catch (msgErr) {
    const msg = msgErr instanceof Error ? msgErr.message : String(msgErr)
    throw new Error(`sent to provider but DB insert failed: ${msg}`)
  }

  await db
    .update(conversations)
    .set({
      lastMessageText: preview,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, args.conversationId))

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 * Interactive messages are Meta-only (capability-gated).
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaProvider({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaProvider({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

/**
 * Render an interactive prompt as numbered plain text, for channels that
 * can't send real WhatsApp buttons/lists (WAHA & other unofficial
 * providers). The numbering here MUST stay in lockstep with
 * `matchTextToButton()` in engine.ts: buttons are numbered 1..N in array
 * order; list rows are numbered 1..N flattened across sections in order,
 * so a customer who types "2" lands on the same option either side.
 */
function renderOptionsAsText(input: SendInput): string {
  const lines: string[] = []
  if (input.headerText?.trim()) lines.push(`*${input.headerText.trim()}*`)
  lines.push(input.bodyText.trim())
  lines.push('')

  if (input.kind === 'buttons') {
    input.buttons.forEach((b, i) => {
      lines.push(`${i + 1}. ${b.title}`)
    })
  } else {
    let n = 0
    for (const section of input.sections) {
      if (section.title?.trim()) lines.push(`*${section.title.trim()}*`)
      for (const row of section.rows) {
        n += 1
        lines.push(
          row.description?.trim()
            ? `${n}. ${row.title} — ${row.description.trim()}`
            : `${n}. ${row.title}`,
        )
      }
    }
  }

  lines.push('')
  if (input.footerText?.trim()) lines.push(input.footerText.trim())
  lines.push('_Responda com o número da opção._')
  return lines.join('\n')
}

async function sendInteractiveViaProvider(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, sanitized, channel } = await loadContactAndChannel(
    input.accountId,
    input.contactId,
    input.conversationId,
  )
  const provider = getProvider(channel.provider)

  // Real interactive button/list messages only exist on the official Meta
  // channel. On any other provider (WAHA & unofficial), fall back to a
  // numbered plain-text prompt — the reply side (engine's
  // `matchTextToButton`) maps the typed number/label back to the option,
  // so conversational flows still branch correctly off a WhatsApp channel.
  if (!provider.capabilities.interactive || !provider.sendInteractive) {
    return engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: renderOptionsAsText(input),
    })
  }

  const waMessageId = await dispatchWithRetry(
    channel,
    contact.id,
    sanitized,
    async (phone) => {
      if (input.kind === 'buttons') {
        const r = await provider.sendInteractive!(channel, phone, {
          bodyText: input.bodyText,
          buttons: input.buttons,
          headerText: input.headerText,
          footerText: input.footerText,
        })
        return r.externalMessageId
      }
      const r = await provider.sendInteractive!(channel, phone, {
        bodyText: input.bodyText,
        buttonLabel: input.buttonLabel,
        sections: input.sections,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.externalMessageId
    },
  )

  // Persist the bot's prompt. content_type='interactive'; sender_type='bot'.
  // We do NOT set interactive_reply_id — that's for the customer's tap,
  // populated by the webhook when their reply arrives.
  try {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      senderType: 'bot',
      contentType: 'interactive',
      contentText: input.bodyText,
      messageId: waMessageId,
      status: 'sent',
    })
  } catch (msgErr) {
    const msg = msgErr instanceof Error ? msgErr.message : String(msgErr)
    throw new Error(`sent to provider but DB insert failed: ${msg}`)
  }

  await db
    .update(conversations)
    .set({
      lastMessageText: input.bodyText,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, input.conversationId))

  return { whatsapp_message_id: waMessageId }
}

// ============================================================
// POST /api/conversations/[id]/send-pix — send the conversation channel's
// saved Pix key as a copyable text message.
//
// The non-official engine can't send the native Pix payment card, so this
// sends the key as text with the same `💠 Chave Pix` marker the inbound parser
// uses — so the CRM renders it as a copy card on the agent's side and the
// customer can long-press to copy. The key is fixed per channel (each number
// is a business), set in Settings and stored on provider_meta.pix.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, conversations, contacts, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { publishEvent } from '@/lib/events/publish'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { formatPixMessage, type PixKey } from '@/lib/whatsapp/pix'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id: conversationId } = await params

    const conversation = firstOrNull(
      await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          channelId: conversations.channelId,
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
    if (!conversation?.channelId) {
      return NextResponse.json(
        { error: 'Conversa sem canal para enviar o Pix.' },
        { status: 400 },
      )
    }

    const channel = await loadChannel(conversation.channelId)
    if (!channel || channel.accountId !== ctx.accountId) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 400 })
    }

    const pix = (channel.providerMeta as { pix?: PixKey }).pix
    const text = pix ? formatPixMessage(pix) : null
    if (!text) {
      return NextResponse.json(
        {
          error:
            'Este canal ainda não tem uma chave Pix cadastrada. Cadastre em Configurações → Canais.',
        },
        { status: 400 },
      )
    }

    const contact = firstOrNull(
      await db
        .select({ phone: contacts.phone })
        .from(contacts)
        .where(eq(contacts.id, conversation.contactId))
        .limit(1),
    )
    const phone = sanitizePhoneForMeta(contact?.phone ?? '')
    if (!isValidE164(phone)) {
      return NextResponse.json(
        { error: 'Contato sem telefone válido.' },
        { status: 400 },
      )
    }

    const provider = getProvider(channel.provider)
    await provider.sendText(channel, phone, text)

    // Log it. The `💠 Chave Pix` marker makes the bubble render a copy card,
    // same as a received Pix.
    await db.insert(messages).values({
      conversationId,
      senderType: 'agent',
      contentType: 'text',
      contentText: text,
      status: 'sent',
    })
    await db
      .update(conversations)
      .set({
        lastMessageText: '💠 Chave Pix',
        lastMessageAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conversationId))
    await publishEvent(ctx.accountId, {
      type: 'message.received',
      conversationId,
      fromMe: true,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

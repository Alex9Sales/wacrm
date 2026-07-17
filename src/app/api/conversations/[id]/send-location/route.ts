// ============================================================
// POST /api/conversations/[id]/send-location — send the conversation channel's
// configured business location as a WhatsApp map pin.
//
// The location is fixed per channel (each number is a different business), set
// in Settings and stored on channels.provider_meta.location. The agent just
// asks to send it; the backend resolves channel → location → provider and logs
// a clickable Maps link in the thread (same shape as an inbound location, so a
// sent pin reads like a received one).
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
import { mapsLink } from '@/lib/whatsapp/location'

interface StoredLocation {
  latitude: number
  longitude: number
  label?: string
}

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
        { error: 'Conversa sem canal para enviar a localização.' },
        { status: 400 },
      )
    }

    const channel = await loadChannel(conversation.channelId)
    if (!channel || channel.accountId !== ctx.accountId) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 400 })
    }

    const loc = (channel.providerMeta as { location?: StoredLocation }).location
    if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
      return NextResponse.json(
        {
          error:
            'Este canal ainda não tem uma localização cadastrada. Cadastre em Configurações.',
        },
        { status: 400 },
      )
    }

    const provider = getProvider(channel.provider)
    if (!provider.sendLocation) {
      return NextResponse.json(
        { error: 'Este canal não suporta enviar localização.' },
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

    await provider.sendLocation(channel, phone, {
      latitude: loc.latitude,
      longitude: loc.longitude,
      title: loc.label,
    })

    // Log the sent pin as a clickable Maps link — same shape the inbound
    // parser produces, so it reads like any other location in the thread.
    const linkText = mapsLink({ lat: loc.latitude, lng: loc.longitude })
    await db.insert(messages).values({
      conversationId,
      senderType: 'agent',
      contentType: 'text',
      contentText: linkText,
      status: 'sent',
    })
    await db
      .update(conversations)
      .set({
        lastMessageText: '📍 Localização',
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

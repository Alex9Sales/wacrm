// ============================================================
// PATCH /api/messages/[id] — edit the text of a message WE sent (WhatsApp
// "Editar"). Edits the real WhatsApp message via the channel's provider FIRST,
// and only then updates the stored copy — so a rejected edit (past WhatsApp's
// ~15min window, wrong id, engine without support) leaves both sides in sync.
//
// Body: { content_text: string }. Only own (agent/bot) TEXT messages within the
// edit window are editable; anything else is a 400/403.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, messages, conversations, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'

/** WhatsApp only allows editing within ~15 minutes of sending. */
const EDIT_WINDOW_MS = 15 * 60_000

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id: messageId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      content_text?: unknown
    }
    const newText =
      typeof body.content_text === 'string' ? body.content_text.trim() : ''
    if (!newText) {
      return NextResponse.json(
        { error: 'O texto não pode ficar vazio.' },
        { status: 400 },
      )
    }
    // Guard the uuid column against a non-uuid id (e.g. an optimistic `temp-…`
    // the client shouldn't send) — a raw query would 500 on the cast.
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(messageId)) {
      return NextResponse.json(
        { error: 'Aguarde a mensagem terminar de enviar para editar.' },
        { status: 400 },
      )
    }

    // Load the message + its conversation/contact, scoped to the account.
    const row = firstOrNull(
      await db
        .select({
          senderType: messages.senderType,
          contentType: messages.contentType,
          externalId: messages.messageId,
          createdAt: messages.createdAt,
          isInternal: messages.isInternal,
          conversationId: messages.conversationId,
          channelId: conversations.channelId,
          phone: contacts.phone,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .innerJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(
          and(
            eq(messages.id, messageId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!row) {
      return NextResponse.json(
        { error: 'Mensagem não encontrada.' },
        { status: 404 },
      )
    }

    // Only an own (agent/bot) TEXT message can be edited. Internal notes never
    // left the CRM, so they can be edited without touching WhatsApp — but keep
    // this route to real sent messages; the note path is separate.
    if (row.senderType !== 'agent' && row.senderType !== 'bot') {
      return NextResponse.json(
        { error: 'Só dá para editar mensagens que você enviou.' },
        { status: 403 },
      )
    }
    if (row.contentType !== 'text' || row.isInternal) {
      return NextResponse.json(
        { error: 'Esse tipo de mensagem não pode ser editado.' },
        { status: 400 },
      )
    }
    const sentAt = row.createdAt ? new Date(row.createdAt).getTime() : 0
    if (!sentAt || Date.now() - sentAt > EDIT_WINDOW_MS) {
      return NextResponse.json(
        { error: 'A janela de edição do WhatsApp (15 min) já passou.' },
        { status: 400 },
      )
    }

    // Edit on WhatsApp FIRST — only persist locally if the engine accepts it.
    const channel = row.channelId ? await loadChannel(row.channelId) : null
    if (!channel || channel.accountId !== ctx.accountId) {
      return NextResponse.json(
        { error: 'Canal da conversa não encontrado.' },
        { status: 400 },
      )
    }
    const provider = getProvider(channel.provider)
    if (typeof provider.editMessage !== 'function') {
      return NextResponse.json(
        { error: 'Este canal não permite editar mensagens.' },
        { status: 400 },
      )
    }
    if (!row.externalId) {
      return NextResponse.json(
        { error: 'Mensagem sem id do WhatsApp — não dá para editar.' },
        { status: 400 },
      )
    }

    try {
      await provider.editMessage(channel, row.phone, row.externalId, newText)
    } catch (err) {
      console.error('[messages/edit] provider editMessage failed:', err)
      return NextResponse.json(
        {
          error:
            'O WhatsApp recusou a edição (janela expirada ou não suportado).',
        },
        { status: 502 },
      )
    }

    await db
      .update(messages)
      .set({ contentText: newText })
      .where(eq(messages.id, messageId))

    return NextResponse.json({ ok: true, content_text: newText })
  } catch (err) {
    return toErrorResponse(err)
  }
}

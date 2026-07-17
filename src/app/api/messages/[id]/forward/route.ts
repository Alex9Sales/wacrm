// ============================================================
// POST /api/messages/[id]/forward — re-send an existing message to one or more
// conversations (WhatsApp-style "Encaminhar").
//
// Body: { targetConversationIds: string[] }. Loads the source message (scoped
// to the account), then replays it into each target via the shared send core:
// media keeps its media_url, everything else goes as text. Best-effort per
// target — one failure doesn't sink the rest; the response reports counts.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, messages, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  sendMessageToConversation,
  MEDIA_KINDS,
} from '@/lib/whatsapp/send-message'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id: messageId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      targetConversationIds?: unknown
    }
    const targets = Array.isArray(body.targetConversationIds)
      ? body.targetConversationIds.filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : []
    if (targets.length === 0) {
      return NextResponse.json(
        { error: 'Selecione ao menos uma conversa.' },
        { status: 400 },
      )
    }

    // Load the source message, scoped to the account via its conversation.
    const src = firstOrNull(
      await db
        .select({
          contentType: messages.contentType,
          contentText: messages.contentText,
          mediaUrl: messages.mediaUrl,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(messages.id, messageId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!src) {
      return NextResponse.json(
        { error: 'Mensagem não encontrada.' },
        { status: 404 },
      )
    }

    // Decide how to replay it: media keeps its url; everything else is text.
    const isMedia =
      (MEDIA_KINDS as readonly string[]).includes(src.contentType) &&
      !!src.mediaUrl
    if (!isMedia && !src.contentText) {
      return NextResponse.json(
        { error: 'Esse tipo de mensagem não pode ser encaminhado.' },
        { status: 400 },
      )
    }

    let sent = 0
    const failed: string[] = []
    for (const conversationId of targets) {
      try {
        // Confirm the target belongs to this account before sending into it.
        const ok = firstOrNull(
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.accountId, ctx.accountId),
              ),
            )
            .limit(1),
        )
        if (!ok) {
          failed.push(conversationId)
          continue
        }
        await sendMessageToConversation(ctx.accountId, {
          conversationId,
          messageType: isMedia ? src.contentType : 'text',
          contentText: src.contentText ?? undefined,
          mediaUrl: isMedia ? (src.mediaUrl ?? undefined) : undefined,
        })
        sent += 1
      } catch (err) {
        console.error('[forward] send failed for', conversationId, err)
        failed.push(conversationId)
      }
    }

    return NextResponse.json({ ok: true, sent, failed: failed.length })
  } catch (err) {
    return toErrorResponse(err)
  }
}

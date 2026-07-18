// ============================================================
// POST /api/conversations/[id]/note — add an INTERNAL note to a conversation.
//
// The note is persisted in the thread (is_internal = true) but NEVER sent to
// the customer — no provider call. Its purpose is to @mention a colleague
// inside the conversation ("@maria assume esse"), so the mentioned member gets
// a notification that deep-links straight to this thread.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import {
  db,
  conversations,
  messages,
  notifications,
  member,
  user,
  conversationParticipants,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { publishEvent } from '@/lib/events/publish'
import { parseMentions } from '@/lib/inbox/mentions'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id: conversationId } = await params
    const body = (await request.json().catch(() => ({}))) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: 'Escreva a nota.' }, { status: 400 })
    }
    if (text.length > 4000) {
      return NextResponse.json({ error: 'Nota muito longa.' }, { status: 400 })
    }

    const conv = firstOrNull(
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
    if (!conv) {
      return NextResponse.json({ error: 'Conversa não encontrada.' }, { status: 404 })
    }

    // Persist as an internal message — no provider send.
    await db.insert(messages).values({
      conversationId,
      senderType: 'agent',
      senderId: ctx.userId,
      contentType: 'text',
      contentText: text,
      isInternal: true,
      status: 'sent',
    })

    // @mentions → notification (deep-linked to this conversation) for each
    // mentioned member except the author. Best-effort.
    try {
      const members = await db
        .select({ id: user.id, name: user.name })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, ctx.accountId))
      const me = members.find((m) => m.id === ctx.userId)
      const mentioned = parseMentions(text, members).filter(
        (id) => id !== ctx.userId,
      )
      if (mentioned.length > 0) {
        // Grant the mentioned members access to THIS conversation (even if it's
        // assigned to someone else) — otherwise the mention is a dead link.
        await db
          .insert(conversationParticipants)
          .values(mentioned.map((uid) => ({ conversationId, userId: uid })))
          .onConflictDoNothing()
        await db.insert(notifications).values(
          mentioned.map((uid) => ({
            accountId: ctx.accountId,
            userId: uid,
            type: 'mention' as const,
            conversationId,
            actorUserId: ctx.userId,
            title: `${me?.name ?? 'Alguém'} mencionou você`,
            body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
          })),
        )
        await publishEvent(ctx.accountId, {
          type: 'mention',
          conversationId,
          senderName: me?.name ?? undefined,
          mentionedUserIds: mentioned,
        })
      }
    } catch (err) {
      console.error('[note] mention notify failed:', err)
    }

    // Refresh the thread (fromMe skips the notification sound).
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

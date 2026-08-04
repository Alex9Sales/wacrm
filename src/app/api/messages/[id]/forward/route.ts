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

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  json: 'application/json',
  xml: 'application/xml',
}

/**
 * Encaminhar um documento perde nome/tipo se só reenviarmos a URL (o objeto de
 * entrada tem nome UUID, sem extensão). O nome real do doc fica no
 * `content_text` (ex.: "DANIELA: 352…nfe.pdf"). Extrai o nome (tira prefixo
 * "Autor: " e placeholders) e deduz o mimetype pela extensão (do nome ou da
 * URL), pra o WhatsApp mandar como PDF/etc. e o celular abrir.
 */
function deriveDocMeta(
  contentText: string | null,
  mediaUrl: string | null,
): { filename?: string; mimetype?: string } {
  let name = (contentText || '').trim()
  const prefix = /^[^\n:]{1,40}:\s*(.+)$/.exec(name)
  if (prefix) name = prefix[1].trim()
  if (/^\[[a-z]+\]$/i.test(name)) name = '' // placeholder "[document]"
  let ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] || '').toLowerCase()
  if (!ext && mediaUrl) {
    ext = (/\.([A-Za-z0-9]{1,8})(?:\?|$)/.exec(mediaUrl)?.[1] || '').toLowerCase()
  }
  const mimetype = ext ? MIME_BY_EXT[ext] : undefined
  return { filename: name || undefined, mimetype }
}

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

    // Documento: recupera nome/tipo pra não chegar como "arquivo"/octet-stream.
    const docMeta =
      isMedia && src.contentType === 'document'
        ? deriveDocMeta(src.contentText, src.mediaUrl)
        : {}

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
          filename: docMeta.filename,
          mimetype: docMeta.mimetype,
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

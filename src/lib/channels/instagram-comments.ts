// ============================================================
// Motor da automação comentário→DM do Instagram.
//
// O webhook de comentários chega em `entry[].changes[]` com field `comments`
// (diferente do DM, que vem em `entry[].messaging[]`). Quando alguém comenta
// num post da conta, a gente casa contra as regras do canal e:
//   • responde o comentário publicamente (opcional);
//   • manda um DM (resposta privada) pra quem comentou.
//
// Dedup: cada comentário é processado UMA vez por canal (índice único
// (channel_id, comment_id) + onConflictDoNothing como trava). Loop-guard:
// ignora comentários da PRÓPRIA conta (nossa resposta pública dispararia o
// webhook de novo).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, instagramCommentAutomations, instagramCommentEvents } from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { ChannelCtx } from './provider'
import { replyToComment, sendCommentPrivateReply } from './providers/instagram'

type Rule = typeof instagramCommentAutomations.$inferSelect

interface CommentChange {
  commentId: string
  text: string
  fromId?: string
  fromUsername?: string
  mediaId?: string
  parentId?: string
}

interface IgChangeValue {
  id?: string | number
  text?: string
  from?: { id?: string | number; username?: string }
  media?: { id?: string | number }
  parent_id?: string | number
}
interface IgCommentBody {
  entry?: { changes?: { field?: string; value?: IgChangeValue }[] }[]
}

/** Extrai os comentários (`changes[].field === 'comments'`) do payload. */
export function parseCommentChanges(body: unknown): CommentChange[] {
  const b = body as IgCommentBody
  const out: CommentChange[] = []
  for (const entry of b.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      if (ch.field !== 'comments') continue
      const v = ch.value ?? {}
      if (v.id === undefined || v.id === null) continue
      out.push({
        commentId: String(v.id),
        text: typeof v.text === 'string' ? v.text : '',
        fromId: v.from?.id != null ? String(v.from.id) : undefined,
        fromUsername: v.from?.username,
        mediaId: v.media?.id != null ? String(v.media.id) : undefined,
        parentId: v.parent_id != null ? String(v.parent_id) : undefined,
      })
    }
  }
  return out
}

/** true se o comentário casa a regra (matchAny, ou contém alguma keyword). */
function matchRule(text: string, rule: Rule): boolean {
  if (rule.matchAny) return true
  const t = text.toLowerCase()
  const kws = rule.keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
  return kws.some((k) => t.includes(k))
}

/** true se o payload traz ao menos um comentário (pra rota decidir o caminho). */
export function hasCommentChanges(body: unknown): boolean {
  const b = body as IgCommentBody
  return (b.entry ?? []).some((e) =>
    (e.changes ?? []).some((c) => c.field === 'comments'),
  )
}

/**
 * Processa os comentários de um payload de webhook pra um canal Instagram.
 * Best-effort: erros por comentário são gravados no log, não derrubam o resto.
 */
export async function processCommentWebhook(
  channel: ChannelCtx,
  body: unknown,
): Promise<void> {
  const changes = parseCommentChanges(body)
  if (changes.length === 0) return

  const igId =
    typeof channel.providerMeta.ig_id === 'string' ? channel.providerMeta.ig_id : ''

  // Regras habilitadas do canal.
  const rules = (await db
    .select()
    .from(instagramCommentAutomations)
    .where(
      and(
        eq(instagramCommentAutomations.channelId, channel.id),
        eq(instagramCommentAutomations.enabled, true),
      ),
    )) as Rule[]
  if (rules.length === 0) return

  for (const c of changes) {
    // Loop-guard: ignora comentário da própria conta (nossa resposta pública).
    if (c.fromId && igId && c.fromId === igId) continue

    // Dedup: grava o evento; se já existe (channel_id, comment_id) → já visto.
    const inserted = firstOrNull(
      await db
        .insert(instagramCommentEvents)
        .values({
          accountId: channel.accountId,
          channelId: channel.id,
          commentId: c.commentId,
          commenterIgsid: c.fromId,
          commenterUsername: c.fromUsername,
          mediaId: c.mediaId,
          commentText: c.text,
        })
        .onConflictDoNothing()
        .returning({ id: instagramCommentEvents.id }),
    )
    if (!inserted) continue

    const rule = rules.find((r) => matchRule(c.text, r))
    if (!rule) {
      await db
        .update(instagramCommentEvents)
        .set({ matched: false })
        .where(eq(instagramCommentEvents.id, inserted.id))
      continue
    }

    // once_per_user: essa pessoa já recebeu o DM dessa regra antes?
    if (rule.oncePerUser && c.fromId) {
      const prior = firstOrNull(
        await db
          .select({ id: instagramCommentEvents.id })
          .from(instagramCommentEvents)
          .where(
            and(
              eq(instagramCommentEvents.automationId, rule.id),
              eq(instagramCommentEvents.commenterIgsid, c.fromId),
              eq(instagramCommentEvents.dmSent, true),
            ),
          )
          .limit(1),
      )
      if (prior) {
        await db
          .update(instagramCommentEvents)
          .set({
            matched: true,
            automationId: rule.id,
            error: 'once_per_user: já recebeu',
          })
          .where(eq(instagramCommentEvents.id, inserted.id))
        continue
      }
    }

    let publicReplied = false
    let dmSent = false
    let errMsg: string | null = null

    if (rule.publicReply && rule.publicReply.trim()) {
      try {
        await replyToComment(channel, c.commentId, rule.publicReply.trim())
        publicReplied = true
      } catch (e) {
        errMsg = `public: ${(e as Error).message}`
      }
    }

    try {
      await sendCommentPrivateReply(channel, c.commentId, rule.dmMessage)
      dmSent = true
    } catch (e) {
      errMsg = `${errMsg ? errMsg + ' | ' : ''}dm: ${(e as Error).message}`
    }

    await db
      .update(instagramCommentEvents)
      .set({
        matched: true,
        automationId: rule.id,
        publicReplied,
        dmSent,
        error: errMsg,
      })
      .where(eq(instagramCommentEvents.id, inserted.id))
  }
}

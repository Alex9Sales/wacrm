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
import { dispatchInboundMessage } from './inbound'
import {
  startFlowRunFromEvent,
  getCommentFlowStart,
  startSuspendedRun,
} from '@/lib/flows/engine'
import {
  replyToComment,
  sendCommentPrivateReply,
  type DmButton,
  type DmQuickReply,
} from './providers/instagram'

type Rule = typeof instagramCommentAutomations.$inferSelect

/** Botões do DM da regra: usa `dmButtons` (novo); cai no par legado se vazio. */
function resolveDmButtons(rule: Rule): DmButton[] {
  const list = rule.dmButtons?.filter((b) => b?.text && b?.url) ?? []
  if (list.length) return list
  if (rule.dmButtonText && rule.dmButtonUrl) {
    return [{ text: rule.dmButtonText, url: rule.dmButtonUrl }]
  }
  return []
}

/** Texto legível do DM-com-botões pra gravar no inbox (o echo do IG vem vazio):
 *  a mensagem + um "🔘 rótulo" por botão. */
function renderDmText(message: string, buttons: DmButton[]): string {
  const lines = [message.trim()].filter(Boolean)
  for (const b of buttons) lines.push(`🔘 ${b.text}`)
  return lines.join('\n')
}

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

    // Casa a 1ª regra: se a regra tem posts (media_ids, ou media_id legado), o
    // post do comentário tem que estar na lista; regra sem posts vale pra
    // qualquer post. Depois, a keyword.
    const rule = rules.find((r) => {
      const ids = r.mediaIds?.length ? r.mediaIds : r.mediaId ? [r.mediaId] : []
      const postOk = ids.length === 0 || (!!c.mediaId && ids.includes(c.mediaId))
      return postOk && matchRule(c.text, r)
    })
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

    const dmButtons = resolveDmButtons(rule)

    // Fase 2b (ManyChat de verdade): se a regra inicia um Fluxo cujo nó de
    // ENTRADA é send_buttons, mandamos as OPÇÕES do fluxo como QUICK REPLIES no
    // próprio DM. Tocar num botão: (1) abre a janela de 24h do IG e (2) casa o
    // reply_id → o motor avança o fluxo. Sem isso, a 2ª msg do fluxo cairia na
    // trava "fora do período permitido" (a pessoa precisa interagir primeiro).
    let flowStart: Awaited<ReturnType<typeof getCommentFlowStart>> = null
    let quickReplies: DmQuickReply[] | null = null
    if (rule.startFlowId) {
      flowStart = await getCommentFlowStart(rule.startFlowId, channel.accountId)
      if (flowStart && flowStart.entryNode.node_type === 'send_buttons') {
        const btns = Array.isArray(flowStart.entryNode.config.buttons)
          ? (flowStart.entryNode.config.buttons as Array<{
              reply_id?: string
              title?: string
            }>)
          : []
        const qs = btns
          .filter((b) => b.reply_id && b.title)
          .map((b) => ({ title: String(b.title), payload: String(b.reply_id) }))
        if (qs.length) quickReplies = qs
      }
    }

    // Gravamos o DM no ENVIO quando: tem botões (o echo do template vem vazio e
    // viraria "[text]") OU a regra inicia um Fluxo (precisamos da conversa pra
    // começar a run). DM só de texto sem fluxo não precisa — o echo já traz.
    const needsRecord = dmButtons.length > 0 || !!rule.startFlowId
    try {
      // Com quick replies, os botões de LINK do DM não vão (o fluxo controla os
      // botões, que precisam ser de resposta pra abrir a janela).
      const sent = await sendCommentPrivateReply(
        channel,
        c.commentId,
        rule.dmMessage,
        quickReplies ? null : dmButtons,
        quickReplies,
      )
      dmSent = true

      let dispatched: { conversationId: string; contactId: string } | null = null
      if (needsRecord && c.fromId) {
        try {
          const res = await dispatchInboundMessage(channel, {
            externalMessageId: sent.messageId,
            fromPhoneE164: '',
            senderExternalId: c.fromId,
            senderName: c.fromUsername,
            fromMe: true,
            contentType: 'text',
            contentText: quickReplies
              ? [
                  rule.dmMessage.trim(),
                  ...quickReplies.map((q) => `🔘 ${q.title}`),
                ]
                  .filter(Boolean)
                  .join('\n')
              : renderDmText(rule.dmMessage, dmButtons),
          })
          if (res) {
            dispatched = {
              conversationId: res.conversationId,
              contactId: res.contactId,
            }
          }
        } catch (recErr) {
          console.error('[comment-automation] gravar DM no inbox falhou:', recErr)
        }
      }

      // Inicia o Fluxo pro contato, na conversa do DM.
      if (rule.startFlowId && dispatched) {
        try {
          if (flowStart && quickReplies) {
            // A 1ª msg (opções) já foi no DM como quick replies → a run fica
            // PARADA na entrada; o toque no botão avança daqui (janela aberta).
            await startSuspendedRun(
              flowStart.flow,
              dispatched.contactId,
              dispatched.conversationId,
            )
          } else {
            // Fluxo sem botões de resposta na entrada: start normal (pode
            // esbarrar na janela de 24h até a pessoa responder).
            await startFlowRunFromEvent(
              rule.startFlowId,
              channel.accountId,
              dispatched.contactId,
              dispatched.conversationId,
            )
          }
        } catch (flowErr) {
          console.error('[comment-automation] iniciar fluxo falhou:', flowErr)
        }
      }
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

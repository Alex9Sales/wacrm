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

import { and, eq, sql } from 'drizzle-orm'

import {
  db,
  instagramCommentAutomations,
  instagramCommentEvents,
  instagramFollowGatePending,
} from '@/db'
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
  fetchFollowsBusiness,
  fetchInstagramProfile,
  fetchBusinessDiscovery,
  instagramProvider,
  type DmButton,
  type DmQuickReply,
} from './providers/instagram'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

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
 * 🎯 Qualificação por IA (social selling): antes de mandar o DM com o link, a
 * IA lê o @perfil (nome/bio/seguidores via Business Discovery — só funciona p/
 * conta business/creator) + o texto do comentário e decide se a pessoa bate com
 * o CLIENTE IDEAL descrito na regra. Retorna:
 *   qualified=true  → manda o DM (ou não deu pra avaliar: FAIL-OPEN, não trava)
 *   qualified=false → claramente FORA do perfil (concorrente / perfil pessoal…)
 * Best-effort: qualquer erro técnico (sem IA, falha na chamada) → true, pra
 * nunca perder um lead por causa de infra.
 */
async function qualifyCommenter(
  channel: ChannelCtx,
  rule: Rule,
  c: CommentChange,
): Promise<{ qualified: boolean; reason: string }> {
  const criteria = (rule.qualificationPrompt ?? '').trim()
  if (!criteria) return { qualified: true, reason: 'sem critério' }
  try {
    const config = await loadAiConfig(channel.accountId, { requireActive: false })
    if (!config) return { qualified: true, reason: 'sem IA configurada' }

    // Sinais do perfil (best-effort; qualquer um pode faltar).
    const [profile, disco] = await Promise.all([
      c.fromId ? fetchInstagramProfile(channel, c.fromId) : Promise.resolve(null),
      c.fromUsername
        ? fetchBusinessDiscovery(channel, c.fromUsername)
        : Promise.resolve(null),
    ])
    const username = c.fromUsername || profile?.username || null
    const nome = profile?.name || disco?.name || null
    const perfil = [
      username ? `@username: ${username}` : null,
      nome ? `Nome: ${nome}` : null,
      disco?.biography ? `Bio: ${disco.biography}` : null,
      typeof disco?.followersCount === 'number'
        ? `Seguidores: ${disco.followersCount}`
        : null,
      typeof disco?.mediaCount === 'number' ? `Posts: ${disco.mediaCount}` : null,
      disco
        ? 'Tipo de conta: profissional/criador'
        : 'Tipo de conta: pessoal ou não-descobrível pela API',
      `Comentário que a pessoa deixou: "${(c.text ?? '').trim()}"`,
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = [
      'Você é um filtro de qualificação de leads para social selling no Instagram.',
      'Analise os dados do perfil e o comentário e decida se a pessoa se encaixa no CLIENTE IDEAL descrito abaixo.',
      '',
      'CLIENTE IDEAL:',
      criteria,
      '',
      'Responda SÓ com um JSON, nada mais: {"qualificado": true|false, "motivo": "bem curto"}.',
      'Na dúvida, responda true — não trave um lead sem certeza. Só responda false se estiver CLARO que a pessoa não é o cliente ideal.',
    ].join('\n')

    const res = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: perfil }],
    })
    const raw = (res.text ?? '').trim()
    let qualified = true
    let reason = raw.slice(0, 120)
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const j = JSON.parse(m[0]) as { qualificado?: boolean; motivo?: string }
        if (typeof j.qualificado === 'boolean') qualified = j.qualificado
        if (j.motivo) reason = String(j.motivo).slice(0, 120)
      } catch {
        /* cai no fallback textual abaixo */
      }
    } else if (
      /\b(false|nao|não)\b/i.test(raw) &&
      !/\b(true|sim)\b/i.test(raw)
    ) {
      qualified = false
    }
    return { qualified, reason }
  } catch (e) {
    // FAIL-OPEN: infra quebrou → não perde o lead.
    return { qualified: true, reason: `erro: ${(e as Error).message}` }
  }
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

    // Resposta pública: até 3 variantes ALTERNADAS a cada envio (round-robin
    // atômico no banco — comentários simultâneos não repetem a mesma). Regras
    // antigas seguem no campo legado `publicReply` (1 variante).
    const replyVariants = (
      Array.isArray(rule.publicReplies) && rule.publicReplies.length
        ? rule.publicReplies
        : rule.publicReply
          ? [rule.publicReply]
          : []
    )
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
    if (replyVariants.length) {
      try {
        let replyText = replyVariants[0]
        if (replyVariants.length > 1) {
          const rot = firstOrNull(
            await db
              .update(instagramCommentAutomations)
              .set({ replyRotation: sql`reply_rotation + 1` })
              .where(eq(instagramCommentAutomations.id, rule.id))
              .returning({ n: instagramCommentAutomations.replyRotation }),
          )
          replyText = replyVariants[((rot?.n ?? 1) - 1) % replyVariants.length]
        }
        await replyToComment(channel, c.commentId, replyText)
        publicReplied = true
      } catch (e) {
        errMsg = `public: ${(e as Error).message}`
      }
    }

    // 🎯 Qualificação por IA: não qualificado NÃO recebe DM (mas a resposta
    // pública já saiu). Fail-open embutido no qualifyCommenter — nunca trava
    // um lead por erro de infra.
    if (rule.qualificationEnabled) {
      const q = await qualifyCommenter(channel, rule, c)
      if (!q.qualified) {
        await db
          .update(instagramCommentEvents)
          .set({
            matched: true,
            automationId: rule.id,
            publicReplied,
            dmSent: false,
            error: [errMsg, `não qualificado: ${q.reason}`]
              .filter(Boolean)
              .join(' | '),
          })
          .where(eq(instagramCommentEvents.id, inserted.id))
        continue
      }
    }

    // 🔒 Follow gate (social selling): o link é só pra quem SEGUE o perfil.
    // Não segue (ou não deu pra saber) → DM pede o follow, guarda a pendência
    // e a ENTREGA acontece quando a pessoa responder já seguindo (hook no
    // inbound → handleFollowGateReply).
    if (rule.followGate) {
      const follows = c.fromId
        ? await fetchFollowsBusiness(channel, c.fromId)
        : null
      if (follows !== true) {
        const gateMsg =
          (rule.followGateMessage ?? '').trim() || FOLLOW_GATE_DEFAULT
        let gateSent = false
        try {
          await sendCommentPrivateReply(channel, c.commentId, gateMsg, null, null)
          gateSent = true
          if (c.fromId) {
            await db
              .insert(instagramFollowGatePending)
              .values({
                accountId: channel.accountId,
                channelId: channel.id,
                automationId: rule.id,
                igUserId: c.fromId,
              })
              .onConflictDoUpdate({
                target: [
                  instagramFollowGatePending.automationId,
                  instagramFollowGatePending.igUserId,
                ],
                set: { delivered: false, deliveredAt: null },
              })
          }
        } catch (e) {
          errMsg = `${errMsg ? errMsg + ' | ' : ''}gate: ${(e as Error).message}`
        }
        await db
          .update(instagramCommentEvents)
          .set({
            matched: true,
            automationId: rule.id,
            publicReplied,
            dmSent: gateSent,
            error: [errMsg, 'follow_gate: aguardando follow']
              .filter(Boolean)
              .join(' | '),
          })
          .where(eq(instagramCommentEvents.id, inserted.id))
        continue
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

// ============================================================
// 🔒 Follow gate — textos padrão + entrega pós-follow.
// ============================================================

const FOLLOW_GATE_DEFAULT =
  'Opa! 😊 Esse conteúdo é exclusivo pra quem segue a gente. Segue o perfil e me responde aqui qualquer coisa que eu libero na hora! 😉'
const FOLLOW_GATE_REMINDER =
  'Ainda não achei seu follow por aqui 👀 Segue o perfil e me manda um "segui" que eu libero na hora!'

/** Texto de entrega pós-follow: DM da regra + botões como links clicáveis. */
function renderGateDelivery(rule: Rule): string {
  const buttons = resolveDmButtons(rule)
  const lines = [`Boa! 🎉 ${rule.dmMessage.trim()}`]
  for (const b of buttons) lines.push(`👉 ${b.text}: ${b.url}`)
  return lines.join('\n')
}

/**
 * Chamada pelo INBOUND (import dinâmico, sem ciclo) quando chega DM de cliente
 * num canal Instagram: se a pessoa tem pendência de follow gate e AGORA segue o
 * perfil, entrega o DM original da regra (com botões como links + inicia o
 * Fluxo — a janela de 24h está aberta, ela acabou de mandar mensagem). Se ainda
 * não segue, lembra UMA vez só (nada de spam a cada mensagem). Best-effort.
 */
export async function handleFollowGateReply(
  channel: ChannelCtx,
  igUserId: string,
  conversationId: string,
  contactId: string,
): Promise<void> {
  if (!igUserId) return
  const pendings = await db
    .select({
      pending: instagramFollowGatePending,
      rule: instagramCommentAutomations,
    })
    .from(instagramFollowGatePending)
    .innerJoin(
      instagramCommentAutomations,
      eq(instagramCommentAutomations.id, instagramFollowGatePending.automationId),
    )
    .where(
      and(
        eq(instagramFollowGatePending.channelId, channel.id),
        eq(instagramFollowGatePending.igUserId, igUserId),
        eq(instagramFollowGatePending.delivered, false),
        eq(instagramCommentAutomations.enabled, true),
        eq(instagramCommentAutomations.followGate, true),
      ),
    )
    .limit(3)
  if (!pendings.length) return

  const follows = await fetchFollowsBusiness(channel, igUserId)
  // Etiqueta "Seguidor"/"Não seguidor" de carona na consulta (segmentação).
  if (follows !== null) {
    try {
      const { tagFollowerStatus } = await import('./instagram-social')
      await tagFollowerStatus(channel.accountId, contactId, follows)
    } catch (err) {
      console.error('[follow-gate] etiqueta de seguidor falhou:', err)
    }
  }

  if (follows === true) {
    for (const { pending, rule } of pendings) {
      // Claim atômico: só quem marcar delivered primeiro envia (sem duplicar
      // quando duas mensagens chegam juntas).
      const claimed = firstOrNull(
        await db
          .update(instagramFollowGatePending)
          .set({ delivered: true, deliveredAt: new Date().toISOString() })
          .where(
            and(
              eq(instagramFollowGatePending.id, pending.id),
              eq(instagramFollowGatePending.delivered, false),
            ),
          )
          .returning({ id: instagramFollowGatePending.id }),
      )
      if (!claimed) continue
      try {
        const text = renderGateDelivery(rule)
        const sent = await instagramProvider.sendText(channel, igUserId, text)
        // Grava no inbox no envio (dedupe por id segura o echo).
        try {
          await dispatchInboundMessage(channel, {
            externalMessageId: sent.externalMessageId,
            fromPhoneE164: '',
            senderExternalId: igUserId,
            fromMe: true,
            contentType: 'text',
            contentText: text,
          })
        } catch {
          // o echo do IG cobre a gravação
        }
        if (rule.startFlowId) {
          try {
            await startFlowRunFromEvent(
              rule.startFlowId,
              channel.accountId,
              contactId,
              conversationId,
            )
          } catch (e) {
            console.error('[follow-gate] iniciar fluxo falhou:', e)
          }
        }
      } catch (e) {
        console.error('[follow-gate] entrega falhou:', e)
        // devolve a pendência — tenta de novo na próxima mensagem da pessoa
        await db
          .update(instagramFollowGatePending)
          .set({ delivered: false, deliveredAt: null })
          .where(eq(instagramFollowGatePending.id, pending.id))
      }
    }
    return
  }

  // Confirmado que NÃO segue: lembra uma vez só. (null = não deu pra saber —
  // fica em silêncio pra não cobrar quem talvez já siga.)
  if (follows === false && pendings.some((p) => !p.pending.reminded)) {
    try {
      await instagramProvider.sendText(channel, igUserId, FOLLOW_GATE_REMINDER)
    } catch (e) {
      console.error('[follow-gate] lembrete falhou:', e)
    }
    await db
      .update(instagramFollowGatePending)
      .set({ reminded: true })
      .where(
        and(
          eq(instagramFollowGatePending.channelId, channel.id),
          eq(instagramFollowGatePending.igUserId, igUserId),
          eq(instagramFollowGatePending.delivered, false),
        ),
      )
  }
}

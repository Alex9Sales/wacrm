// ============================================================
// Instagram Direct (DM) provider adapter. Roda na Graph API do Meta (mesmo app
// do WhatsApp), mas o Messaging do Instagram é estilo Messenger:
//   • webhook chega em `entry[].messaging[]` (NÃO em `entry[].changes[].value`);
//   • o usuário é identificado por IGSID (id opaco), não por telefone →
//     NormalizedInbound.senderExternalId carrega o IGSID (fromPhoneE164 fica '');
//   • envio: POST {graphBase}/{ig_id}/messages com { recipient:{id}, message:{} }.
//
// credentials JSON: { accessToken, appSecret? } (token da Página/conta IG).
// provider_meta: { ig_id, graphBase? }.
//   - ig_id = id da conta Instagram (= entry[].id do webhook e alvo do envio).
//   - graphBase (opcional) = base da Graph API; default graph.facebook.com/v21.0.
//     Pra "Instagram API com login do Instagram" use https://graph.instagram.com/v21.0.
//
// Sem templates (fora da janela de 24h o IG usa a tag human_agent, não template).
// ============================================================

import { CAPABILITIES } from '../provider'
import type {
  ChannelCtx,
  NormalizedInbound,
  NormalizedStatus,
  OutboundMedia,
  ParsedWebhook,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'

const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com/v21.0'

function accessTokenOf(ch: ChannelCtx): string {
  const token = ch.credentials.accessToken
  if (typeof token !== 'string' || !token) {
    throw new Error(`instagram channel ${ch.id} sem credentials.accessToken`)
  }
  return token
}

function igIdOf(ch: ChannelCtx): string {
  const id = ch.providerMeta.ig_id
  if (typeof id !== 'string' || !id) {
    throw new Error(`instagram channel ${ch.id} sem providerMeta.ig_id`)
  }
  return id
}

function graphBaseOf(ch: ChannelCtx): string {
  const base = ch.providerMeta.graphBase
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : DEFAULT_GRAPH_BASE
}

// ---- Webhook payload (Messenger-style, universe instagram) -----------------
interface IgTemplateButton {
  title?: string
  type?: string
  url?: string
}
interface IgAttachment {
  type?: string
  payload?: {
    url?: string
    // Echo de mensagem com template (o DM da automação de comentário com botões):
    // generic = { elements: [{ title, subtitle, buttons }] }; button = { text, buttons }.
    title?: string
    text?: string
    template_type?: string
    buttons?: IgTemplateButton[]
    elements?: {
      title?: string
      subtitle?: string
      buttons?: IgTemplateButton[]
    }[]
  }
}

/**
 * Texto legível de um attachment de TEMPLATE (o echo do DM com botões). Junta o
 * título/corpo do card + os rótulos dos botões, pra renderizar como bolha de
 * texto no inbox em vez de um "[text]" vazio. null se não der pra extrair nada.
 */
function templateText(att: IgAttachment): string | null {
  const p = att.payload
  if (!p) return null
  const el = p.elements?.[0]
  const title = (p.text ?? p.title ?? el?.title ?? '').trim()
  const subtitle = (el?.subtitle ?? '').trim()
  const labels = (el?.buttons ?? p.buttons ?? [])
    .map((b) => b?.title?.trim())
    .filter((t): t is string => !!t)
  const parts: string[] = []
  if (title) parts.push(title)
  if (subtitle) parts.push(subtitle)
  if (labels.length) parts.push(labels.map((t) => `🔘 ${t}`).join('  '))
  // Compartilhamento de post/reel (type 'share'): só vem a URL — mostra ela.
  if (!parts.length && p.url) parts.push(`🔗 ${p.url}`)
  const out = parts.join('\n')
  return out || null
}
interface IgMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    // Conteúdo que a API do IG NÃO entrega (ex.: DM com botões/carrossel de
    // OUTRA empresa, tipo ManyChat): chega só com mid + esta flag, sem texto.
    is_unsupported?: boolean
    is_deleted?: boolean
    attachments?: IgAttachment[]
    // Quando a pessoa TOCA num botão de resposta rápida (quick reply): o texto do
    // botão vem em `text` e o id (reply_id do fluxo) em `quick_reply.payload`.
    quick_reply?: { payload?: string }
  }
  read?: { mid?: string }
  delivery?: { mids?: string[] }
}
interface IgEntry {
  id?: string
  time?: number
  messaging?: IgMessaging[]
}
interface IgWebhookBody {
  object?: string
  entry?: IgEntry[]
}

/** Mapeia o tipo de anexo do IG pro nosso contentType. */
function mapAttachment(type: string | undefined): NormalizedInbound['contentType'] {
  switch (type) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'document'
    default:
      // share / story_mention / ig_reel / location… → tratamos como texto.
      return 'text'
  }
}

/**
 * Busca o perfil de quem mandou o DM (nome / @username / foto) pela Graph API do
 * IG — o webhook só traz o IGSID. Best-effort: null em qualquer falha.
 */
export async function fetchInstagramProfile(
  ch: ChannelCtx,
  igsid: string,
): Promise<{ name?: string; username?: string; profilePic?: string } | null> {
  try {
    const url = `${graphBaseOf(ch)}/${igsid}?fields=name,username,profile_pic`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessTokenOf(ch)}` },
    })
    if (!res.ok) return null
    const d = (await res.json()) as {
      name?: string
      username?: string
      profile_pic?: string
    }
    return { name: d.name, username: d.username, profilePic: d.profile_pic }
  } catch {
    return null
  }
}

/**
 * 🔒 Follow gate: a pessoa segue o perfil? A Graph API expõe
 * `is_user_follow_business` no perfil do usuário. null = não deu pra saber
 * (sem conversa ainda / erro) — o chamador decide o fallback.
 */
export async function fetchFollowsBusiness(
  ch: ChannelCtx,
  igsid: string,
): Promise<boolean | null> {
  try {
    const url = `${graphBaseOf(ch)}/${igsid}?fields=is_user_follow_business`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessTokenOf(ch)}` },
    })
    if (!res.ok) return null
    const d = (await res.json()) as { is_user_follow_business?: boolean }
    return typeof d.is_user_follow_business === 'boolean'
      ? d.is_user_follow_business
      : null
  } catch {
    return null
  }
}

async function graphPost(
  url: string,
  token: string,
  body: unknown,
): Promise<{ message_id?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    message_id?: string
    error?: { message?: string; code?: number }
  }
  if (!res.ok || data.error) {
    throw new Error(
      `instagram send falhou: ${res.status} ${data.error?.message ?? ''}`.trim(),
    )
  }
  return data
}

/**
 * Responde publicamente um comentário (no próprio comentário). Usa
 * `instagram_business_manage_comments`. POST {graphBase}/{commentId}/replies.
 */
export async function replyToComment(
  ch: ChannelCtx,
  commentId: string,
  message: string,
): Promise<void> {
  const url = `${graphBaseOf(ch)}/${commentId}/replies`
  await graphPost(url, accessTokenOf(ch), { message })
}

export interface InstagramMedia {
  id: string
  caption: string | null
  /** URL da imagem/thumbnail pra mostrar no seletor de post. */
  thumbnailUrl: string | null
  permalink: string | null
  timestamp: string | null
  mediaType: string | null
}

/**
 * Lista os posts recentes da conta IG (pro seletor de post da automação de
 * comentário). GET {graphBase}/{ig_id}/media. Best-effort → [] em erro.
 */
export async function fetchInstagramMedia(
  ch: ChannelCtx,
  limit = 25,
): Promise<InstagramMedia[]> {
  const url =
    `${graphBaseOf(ch)}/${igIdOf(ch)}/media` +
    `?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=${limit}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessTokenOf(ch)}` },
    })
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<Record<string, unknown>>
    }
    if (!res.ok) {
      console.error('[instagram media] fetch failed', res.status, json)
      return []
    }
    return (json.data ?? []).map((m) => ({
      id: String(m.id),
      caption: (m.caption as string | undefined) ?? null,
      thumbnailUrl:
        (m.thumbnail_url as string | undefined) ||
        (m.media_url as string | undefined) ||
        null,
      permalink: (m.permalink as string | undefined) ?? null,
      timestamp: (m.timestamp as string | undefined) ?? null,
      mediaType: (m.media_type as string | undefined) ?? null,
    }))
  } catch (err) {
    console.error('[instagram media] error', err)
    return []
  }
}

/**
 * Manda uma resposta PRIVADA (DM) pra quem comentou — o "private reply" do
 * Instagram: POST {graphBase}/{ig_id}/messages com recipient.comment_id.
 * Só pode ser enviada uma vez por comentário, dentro de 7 dias. Usa
 * `instagram_business_manage_messages`.
 */
export interface DmButton {
  text: string
  url: string
}

/** Botão de RESPOSTA RÁPIDA (quick reply): tocar ENVIA uma resposta (com o
 *  payload), o que faz o fluxo avançar E abre a janela de 24h do IG. */
export interface DmQuickReply {
  title: string
  payload: string
}

export async function sendCommentPrivateReply(
  ch: ChannelCtx,
  commentId: string,
  message: string,
  buttons?: DmButton[] | null,
  quickReplies?: DmQuickReply[] | null,
): Promise<{ messageId: string }> {
  const url = `${graphBaseOf(ch)}/${igIdOf(ch)}/messages`
  const quicks = (quickReplies ?? []).filter((q) => q.title && q.payload).slice(0, 3)
  const valid = (buttons ?? []).filter((b) => b.text && b.url).slice(0, 3)

  // Prioridade: quick replies (abrem a janela e continuam o fluxo) > botões de
  // link (generic template) > texto puro.
  let messagePayload: Record<string, unknown>
  if (quicks.length) {
    messagePayload = {
      text: message,
      quick_replies: quicks.map((q) => ({
        content_type: 'text',
        title: q.title.slice(0, 20),
        payload: q.payload,
      })),
    }
  } else if (valid.length) {
    // Botões de LINK: generic template (card + botões web_url), renderiza no app.
    messagePayload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: (message || valid[0].text).slice(0, 80),
              buttons: valid.map((b) => ({
                type: 'web_url',
                url: b.url,
                title: b.text.slice(0, 20),
              })),
            },
          ],
        },
      },
    }
  } else {
    messagePayload = { text: message }
  }

  const data = await graphPost(url, accessTokenOf(ch), {
    recipient: { comment_id: commentId },
    message: messagePayload,
  })
  return { messageId: data.message_id ?? '' }
}

export const instagramProvider: WhatsAppProvider = {
  id: 'instagram',
  capabilities: CAPABILITIES.instagram,

  async sendText(ch, to, text) {
    const url = `${graphBaseOf(ch)}/${igIdOf(ch)}/messages`
    const data = await graphPost(url, accessTokenOf(ch), {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message: { text },
    })
    return { externalMessageId: data.message_id ?? '' }
  },

  async sendMedia(ch, to, media: OutboundMedia) {
    // IG envia mídia por URL pública (attachment). Legenda vira uma msg de texto
    // separada quando houver.
    const url = `${graphBaseOf(ch)}/${igIdOf(ch)}/messages`
    const token = accessTokenOf(ch)
    if (!media.url) {
      throw new Error('instagram sendMedia exige media.url (URL pública)')
    }
    const type =
      media.kind === 'document' ? 'file' : media.kind // image | video | audio | file
    const data = await graphPost(url, token, {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message: {
        attachment: { type, payload: { url: media.url, is_reusable: false } },
      },
    })
    if (media.caption && media.caption.trim()) {
      try {
        await graphPost(url, token, {
          recipient: { id: to },
          messaging_type: 'RESPONSE',
          message: { text: media.caption.trim() },
        })
      } catch {
        /* legenda é best-effort */
      }
    }
    return { externalMessageId: data.message_id ?? '' }
  },

  async verifyWebhook(ctx: WebhookVerifyCtx, ch: ChannelCtx | null) {
    const sig = ctx.headers.get('x-hub-signature-256')
    const appSecret =
      ch && typeof ch.credentials.appSecret === 'string'
        ? (ch.credentials.appSecret as string)
        : null
    return verifyMetaWebhookSignature(ctx.rawBody, sig, appSecret)
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const b = body as IgWebhookBody
    const messages: NormalizedInbound[] = []
    const statuses: NormalizedStatus[] = []

    for (const entry of b.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        // read receipt → status.
        if (ev.read?.mid) {
          statuses.push({ externalMessageId: ev.read.mid, level: 3 })
          continue
        }
        const m = ev.message
        if (!m || !m.mid) continue

        const isEcho = m.is_echo === true
        // O "outro lado" (cliente) é o sender quando é inbound; quando é echo
        // (msg nossa), o cliente é o recipient.
        const partnerId = isEcho ? ev.recipient?.id : ev.sender?.id
        if (!partnerId) continue

        let contentType: NormalizedInbound['contentType'] = 'text'
        let mediaUrl: string | undefined
        let attachmentText: string | null = null
        const att = m.attachments?.[0]
        if (att) {
          contentType = mapAttachment(att.type)
          if (contentType !== 'text') mediaUrl = att.payload?.url
          // template/share/etc. → texto legível (ex.: echo do DM com botões).
          else attachmentText = templateText(att)
        }

        // Echo da NOSSA própria mensagem sem NADA renderável: o IG manda o echo
        // do DM-com-template (botões) SEM o payload → viraria uma bolha "[text]"
        // vazia. A versão legível já é gravada no ENVIO (instagram-comments →
        // dispatchInboundMessage), então descartamos este echo oco (por id, ou
        // por ser oco, não duplica).
        if (isEcho && !m.text && !mediaUrl && !attachmentText) continue

        // Inbound sem NADA renderável (sem texto, sem mídia, sem template):
        // era isso que virava a bolha "[text]" no inbox. Caso clássico: DM com
        // botões/carrossel mandado por OUTRA empresa (automação tipo ManyChat)
        // — a API marca `is_unsupported` e não entrega o conteúdo. Rotula de
        // forma honesta e loga o evento cru pra diagnosticarmos formatos novos.
        if (!isEcho && !m.text && !mediaUrl && !attachmentText) {
          attachmentText = m.is_unsupported
            ? '📩 Mensagem com conteúdo que o Instagram não entrega pra apps (botões/carrossel). Abra o Instagram pra ver.'
            : '📩 Mensagem do Instagram num formato que ainda não reconhecemos.'
          if (!m.is_unsupported) {
            console.warn('[instagram] inbound sem conteúdo renderável:', JSON.stringify(ev))
          }
        }

        const norm: NormalizedInbound = {
          externalMessageId: m.mid,
          fromPhoneE164: '',
          senderExternalId: partnerId,
          fromMe: isEcho,
          contentType,
          contentText: m.text ?? attachmentText ?? null,
        }
        // Toque num botão de resposta rápida → id da opção (reply_id do fluxo).
        // É o que faz o fluxo AVANÇAR e — de quebra — abre a janela de 24h do IG.
        if (!isEcho && m.quick_reply?.payload) {
          norm.interactiveReplyId = m.quick_reply.payload
        }
        if (mediaUrl) {
          norm.media = { kind: contentType, url: mediaUrl }
        }
        messages.push(norm)
      }
    }
    return { messages, statuses }
  },
}

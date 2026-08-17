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
interface IgAttachment {
  type?: string
  payload?: { url?: string }
}
interface IgMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    attachments?: IgAttachment[]
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

/**
 * Manda uma resposta PRIVADA (DM) pra quem comentou — o "private reply" do
 * Instagram: POST {graphBase}/{ig_id}/messages com recipient.comment_id.
 * Só pode ser enviada uma vez por comentário, dentro de 7 dias. Usa
 * `instagram_business_manage_messages`.
 */
export async function sendCommentPrivateReply(
  ch: ChannelCtx,
  commentId: string,
  message: string,
): Promise<void> {
  const url = `${graphBaseOf(ch)}/${igIdOf(ch)}/messages`
  await graphPost(url, accessTokenOf(ch), {
    recipient: { comment_id: commentId },
    message: { text: message },
  })
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
        const att = m.attachments?.[0]
        if (att) {
          contentType = mapAttachment(att.type)
          if (contentType !== 'text') mediaUrl = att.payload?.url
        }

        const norm: NormalizedInbound = {
          externalMessageId: m.mid,
          fromPhoneE164: '',
          senderExternalId: partnerId,
          fromMe: isEcho,
          contentType,
          contentText: m.text ?? null,
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

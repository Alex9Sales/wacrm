// ============================================================
// Facebook Messenger (DM da Página) provider adapter. Roda na MESMA Messenger
// Platform do Instagram Direct — o webhook chega em `entry[].messaging[]`
// (estilo Messenger). Diferenças vs Instagram:
//   • usa a Graph API do Facebook (graph.facebook.com) com token de PÁGINA;
//   • o webhook vem com object:'page' e é roteado por entry[].id = PAGE ID;
//   • o usuário é identificado por PSID (Page-Scoped ID) → NormalizedInbound
//     .senderExternalId carrega o PSID (fromPhoneE164 fica '').
//
// credentials JSON: { accessToken (token da Página), appSecret? }.
// provider_meta: { page_id, graphBase? }.
//   - page_id = id da Página do Facebook (= entry[].id do webhook e alvo do envio).
//   - graphBase (opcional) = base da Graph API; default graph.facebook.com/v21.0.
//
// Sem templates (fora da janela de 24h usa a tag human_agent, não template).
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
    throw new Error(`messenger channel ${ch.id} sem credentials.accessToken`)
  }
  return token
}

function pageIdOf(ch: ChannelCtx): string {
  const id = ch.providerMeta.page_id
  if (typeof id !== 'string' || !id) {
    throw new Error(`messenger channel ${ch.id} sem providerMeta.page_id`)
  }
  return id
}

function graphBaseOf(ch: ChannelCtx): string {
  const base = ch.providerMeta.graphBase
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : DEFAULT_GRAPH_BASE
}

// ---- Webhook payload (Messenger-style, universe page) -----------------------
interface FbAttachment {
  type?: string
  payload?: { url?: string }
}
interface FbMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    attachments?: FbAttachment[]
  }
  read?: { mid?: string }
  delivery?: { mids?: string[] }
}
interface FbEntry {
  id?: string
  time?: number
  messaging?: FbMessaging[]
}
interface FbWebhookBody {
  object?: string
  entry?: FbEntry[]
}

/** Mapeia o tipo de anexo do Messenger pro nosso contentType. */
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
      return 'text'
  }
}

/**
 * Busca o perfil de quem mandou o DM (nome / foto) pela Graph API do Facebook —
 * o webhook só traz o PSID. Best-effort: null em qualquer falha.
 */
export async function fetchMessengerProfile(
  ch: ChannelCtx,
  psid: string,
): Promise<{ name?: string; profilePic?: string } | null> {
  try {
    const url = `${graphBaseOf(ch)}/${psid}?fields=name,first_name,last_name,profile_pic`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessTokenOf(ch)}` },
    })
    if (!res.ok) return null
    const d = (await res.json()) as {
      name?: string
      first_name?: string
      last_name?: string
      profile_pic?: string
    }
    const name =
      d.name ||
      [d.first_name, d.last_name].filter(Boolean).join(' ').trim() ||
      undefined
    return { name, profilePic: d.profile_pic }
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
      `messenger send falhou: ${res.status} ${data.error?.message ?? ''}`.trim(),
    )
  }
  return data
}

export const messengerProvider: WhatsAppProvider = {
  id: 'messenger',
  capabilities: CAPABILITIES.messenger,

  async sendText(ch, to, text) {
    const url = `${graphBaseOf(ch)}/${pageIdOf(ch)}/messages`
    const data = await graphPost(url, accessTokenOf(ch), {
      recipient: { id: to },
      messaging_type: 'RESPONSE',
      message: { text },
    })
    return { externalMessageId: data.message_id ?? '' }
  },

  async sendMedia(ch, to, media: OutboundMedia) {
    const url = `${graphBaseOf(ch)}/${pageIdOf(ch)}/messages`
    const token = accessTokenOf(ch)
    if (!media.url) {
      throw new Error('messenger sendMedia exige media.url (URL pública)')
    }
    const type = media.kind === 'document' ? 'file' : media.kind
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
    const b = body as FbWebhookBody
    const messages: NormalizedInbound[] = []
    const statuses: NormalizedStatus[] = []

    for (const entry of b.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        if (ev.read?.mid) {
          statuses.push({ externalMessageId: ev.read.mid, level: 3 })
          continue
        }
        const m = ev.message
        if (!m || !m.mid) continue

        const isEcho = m.is_echo === true
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

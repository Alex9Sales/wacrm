// ============================================================
// Canal de E-MAIL. Segue o padrão dos providers de token (Instagram/Messenger):
// o cliente é identificado pelo ENDEREÇO DE E-MAIL, que vai em
// NormalizedInbound.senderExternalId → o pipeline resolve o contato por
// contacts.external_id (fromPhoneE164 fica '').
//
// RECEBER: o Cloudflare Email Worker faz POST no /api/webhooks/email com JSON
//   { from, fromName, to, subject, text, html, messageId } + header
//   `x-email-token`. A rota acha o canal por provider_meta.address (= `to`) e
//   chama parseWebhook + dispatchInboundMessage.
// RESPONDER: sendText envia via RESEND. From = "<fromName> <from>" (domínio
//   verificado no Resend), Reply-To = o endereço de recebimento (o cliente
//   responde e cai de volta no Cloudflare → webhook → mesma conversa).
//
// credentials JSON: { resendApiKey?, fromName?, inboundSecret? }.
// provider_meta:    { address (recebe+reply-to+roteamento), from? (From; default
//                     = address), replySubject? }.
// ============================================================

import { Resend } from 'resend'

import { CAPABILITIES } from '../provider'
import type {
  ChannelCtx,
  NormalizedInbound,
  NormalizedStatus,
  ParsedWebhook,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider'

/** Endereço de recebimento (roteamento + Reply-To). Sempre minúsculo. */
function addressOf(ch: ChannelCtx): string {
  const addr = ch.providerMeta.address
  if (typeof addr !== 'string' || !addr) {
    throw new Error(`email channel ${ch.id} sem providerMeta.address`)
  }
  return addr.trim().toLowerCase()
}

/** Endereço no cabeçalho From (domínio verificado no Resend). Default = address. */
function fromAddressOf(ch: ChannelCtx): string {
  const from = ch.providerMeta.from
  return typeof from === 'string' && from.trim()
    ? from.trim()
    : addressOf(ch)
}

function resendKeyOf(ch: ChannelCtx): string {
  const key =
    (typeof ch.credentials.resendApiKey === 'string' &&
      ch.credentials.resendApiKey) ||
    process.env.RESEND_API_KEY
  if (!key) throw new Error(`email channel ${ch.id} sem RESEND_API_KEY`)
  return key
}

/**
 * Segredos aceitos no header `x-email-token` (o Cloudflare Worker prova que é
 * ele). MULTI-TENANT: o Worker manda UM token (o compartilhado) pra TODOS os
 * endereços do subdomínio; canais hospedados validam contra a env
 * `EMAIL_INBOUND_SECRET`, e um canal BYO pode ter o seu próprio
 * `credentials.inboundSecret`. Aceitamos qualquer um dos dois (com `.trim()`).
 */
function inboundSecretsOf(ch: ChannelCtx | null): string[] {
  const out: string[] = []
  if (ch && typeof ch.credentials.inboundSecret === 'string') {
    const s = ch.credentials.inboundSecret.trim()
    if (s) out.push(s)
  }
  const env = (process.env.EMAIL_INBOUND_SECRET || '').trim()
  if (env) out.push(env)
  return out
}

interface EmailWebhookBody {
  from?: string
  fromName?: string
  to?: string
  subject?: string
  text?: string
  html?: string
  messageId?: string
}

/** Tira as tags do HTML pra ter um fallback de texto legível. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=\s*)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Só o endereço, minúsculo, de um "Nome <email>" ou "email". */
function bareEmail(v: string | undefined): string {
  if (!v) return ''
  const m = v.match(/<([^>]+)>/)
  return (m ? m[1] : v).trim().toLowerCase()
}

export const emailProvider: WhatsAppProvider = {
  id: 'email',
  capabilities: CAPABILITIES.email,

  // `to` = e-mail do cliente (vem de contacts.external_id no send-message).
  async sendText(ch, to, text) {
    const resend = new Resend(resendKeyOf(ch))
    const fromName =
      (typeof ch.credentials.fromName === 'string' && ch.credentials.fromName) ||
      ch.name ||
      'Atendimento'
    const from = `${fromName} <${fromAddressOf(ch)}>`
    const subject =
      (typeof ch.providerMeta.replySubject === 'string' &&
        ch.providerMeta.replySubject) ||
      'Atendimento'
    const { data, error } = await resend.emails.send({
      from,
      to,
      replyTo: addressOf(ch),
      subject,
      text,
    })
    if (error) {
      throw new Error(`email send falhou: ${error.message}`)
    }
    return { externalMessageId: data?.id ?? '' }
  },

  async sendMedia() {
    // v1: anexos por e-mail ainda não suportados (chega na Fase 3).
    throw new Error('Anexos por e-mail ainda não são suportados (em breve).')
  },

  async verifyWebhook(ctx: WebhookVerifyCtx, ch: ChannelCtx | null) {
    const secrets = inboundSecretsOf(ch)
    if (secrets.length === 0) {
      // Sem segredo configurado: não valida (piloto) — a rota loga o aviso.
      return true
    }
    // .trim() nos dois lados: um espaço/quebra-de-linha colado junto do segredo
    // no Cloudflare não deve quebrar a validação.
    const provided = (
      ctx.headers.get('x-email-token') ||
      ctx.headers.get('x-inbound-token') ||
      ''
    ).trim()
    return secrets.includes(provided)
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const b = (body ?? {}) as EmailWebhookBody
    const messages: NormalizedInbound[] = []
    const statuses: NormalizedStatus[] = []

    const from = bareEmail(b.from)
    if (from) {
      const text = (b.text && b.text.trim()) || (b.html ? htmlToText(b.html) : '')
      const subject = (b.subject || '').trim()
      const content = subject ? `✉️ ${subject}\n\n${text}` : text
      messages.push({
        externalMessageId:
          b.messageId?.trim() || `${from}:${Date.now()}`,
        fromPhoneE164: '',
        senderExternalId: from,
        senderName: (b.fromName || '').trim() || from,
        fromMe: false,
        contentType: 'text',
        contentText: content || '(sem conteúdo)',
      })
    }
    return { messages, statuses }
  },
}

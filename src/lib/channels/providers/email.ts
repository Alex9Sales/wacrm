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

import nodemailer from 'nodemailer'
import { Resend } from 'resend'

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

interface EmailAttachment {
  filename?: string
  mimeType?: string
  disposition?: string | null
  base64?: string
}

interface EmailWebhookBody {
  from?: string
  fromName?: string
  to?: string
  subject?: string
  text?: string
  html?: string
  messageId?: string
  attachments?: EmailAttachment[]
}

/** Tipo de conteúdo (messages.content_type) a partir do mimetype do anexo. */
function kindForMime(mime: string | undefined): 'image' | 'audio' | 'video' | 'document' {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  return 'document'
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

/** Tira o prefixo `data:...;base64,` se vier junto. */
function stripB64Prefix(b64: string): string {
  return b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
}

/** Assunto sempre em 1 linha: o Resend REJEITA `\n`/`\r` no campo subject. */
function oneLineSubject(s: string): string {
  const clean = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return clean || 'Atendimento'
}

/** Config SMTP do canal (BYO — qualquer provedor: Hostinger, HostGator, etc.).
 *  Quando presente, o envio sai por SMTP em vez do Resend. */
function smtpConfigOf(
  ch: ChannelCtx,
): { host: string; port: number; user: string; pass: string } | null {
  const c = ch.credentials
  const host = typeof c.smtpHost === 'string' ? c.smtpHost.trim() : ''
  const user = typeof c.smtpUser === 'string' ? c.smtpUser.trim() : ''
  const pass = typeof c.smtpPassword === 'string' ? c.smtpPassword : ''
  if (!host || !user || !pass) return null
  const port = Number(c.smtpPort) || 587
  return { host, port, user, pass }
}

/** Transporte SMTP (secure=SSL na 465; STARTTLS nas demais). */
function smtpTransport(cfg: { host: string; port: number; user: string; pass: string }) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  })
}

/** Testa o login SMTP (usado na criação do canal BYO-SMTP pra falhar rápido). */
export async function verifySmtpLogin(
  host: string,
  port: number,
  user: string,
  pass: string,
): Promise<void> {
  await smtpTransport({ host: host.trim(), port: port || 587, user: user.trim(), pass }).verify()
}

/** Cabeçalho From: "<Nome> <endereço>". */
function fromHeaderOf(ch: ChannelCtx): string {
  const fromName =
    (typeof ch.credentials.fromName === 'string' && ch.credentials.fromName) ||
    ch.name ||
    'Atendimento'
  return `${fromName} <${fromAddressOf(ch)}>`
}

/** Nome de arquivo padrão pra um anexo de saída sem filename. */
function defaultFilename(media: OutboundMedia): string {
  const extByMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
  }
  const ext = extByMime[(media.mimetype || '').toLowerCase()] || ''
  return `anexo${ext}`
}

export const emailProvider: WhatsAppProvider = {
  id: 'email',
  capabilities: CAPABILITIES.email,

  // `to` = e-mail do cliente (vem de contacts.external_id no send-message).
  async sendText(ch, to, text, options) {
    const subject = oneLineSubject(
      (options?.subject && options.subject.trim()) ||
        (typeof ch.providerMeta.replySubject === 'string' &&
          ch.providerMeta.replySubject) ||
        'Atendimento',
    )
    // Anexos (disparo de e-mail): baixa cada URL e anexa TODOS num só e-mail.
    let attachments: { filename: string; content: Buffer }[] | undefined
    if (options?.attachments?.length) {
      attachments = []
      for (const a of options.attachments) {
        const res = await fetch(a.url)
        if (!res.ok) throw new Error(`não consegui baixar o anexo (${res.status})`)
        attachments.push({
          filename: (a.filename || '').trim() || 'anexo',
          content: Buffer.from(await res.arrayBuffer()),
        })
      }
    }
    // BYO-SMTP (qualquer provedor): envia por SMTP se o canal tiver essa config.
    const smtp = smtpConfigOf(ch)
    if (smtp) {
      const info = await smtpTransport(smtp).sendMail({
        from: fromHeaderOf(ch),
        to,
        replyTo: addressOf(ch),
        subject,
        text,
        ...(attachments ? { attachments } : {}),
      })
      return { externalMessageId: info.messageId ?? '' }
    }
    // Resend (hospedado, branded, ou BYO-Resend).
    const { data, error } = await new Resend(resendKeyOf(ch)).emails.send({
      from: fromHeaderOf(ch),
      to,
      replyTo: addressOf(ch),
      subject,
      text,
      ...(attachments
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) }
        : {}),
    })
    if (error) {
      throw new Error(`email send falhou: ${error.message}`)
    }
    return { externalMessageId: data?.id ?? '' }
  },

  // `to` = e-mail do cliente. Baixa os bytes no servidor e anexa por SMTP
  // (BYO) ou Resend. O caption vira o corpo do e-mail.
  async sendMedia(ch, to, media) {
    const caption = (media.caption || '').trim()
    // Assunto ESTÁVEL (1 linha, mantém o thread). O caption vai pro CORPO — se
    // fosse pro assunto, um caption multilinha quebrava o Resend (`\n`).
    const subject = oneLineSubject(
      (typeof ch.providerMeta.replySubject === 'string' &&
        ch.providerMeta.replySubject) ||
        'Atendimento',
    )
    const filename = (media.filename || '').trim() || defaultFilename(media)

    // Baixa os bytes NO SERVIDOR e anexa como conteúdo — não depende do provedor
    // conseguir alcançar a URL do MinIO (pode ser interna).
    let content: Buffer | null = null
    if (media.base64) {
      content = Buffer.from(stripB64Prefix(media.base64), 'base64')
    } else if (media.url) {
      const res = await fetch(media.url)
      if (!res.ok) {
        throw new Error(`não consegui baixar o anexo (${res.status})`)
      }
      content = Buffer.from(await res.arrayBuffer())
    }
    if (!content) {
      throw new Error('Anexo sem conteúdo (sem url nem base64).')
    }
    const attachment = { filename, content }
    const bodyText = caption || 'Segue o anexo.'

    // BYO-SMTP (qualquer provedor).
    const smtp = smtpConfigOf(ch)
    if (smtp) {
      const info = await smtpTransport(smtp).sendMail({
        from: fromHeaderOf(ch),
        to,
        replyTo: addressOf(ch),
        subject,
        text: bodyText,
        attachments: [attachment],
      })
      return { externalMessageId: info.messageId ?? '' }
    }

    const { data, error } = await new Resend(resendKeyOf(ch)).emails.send({
      from: fromHeaderOf(ch),
      to,
      replyTo: addressOf(ch),
      subject,
      text: bodyText,
      attachments: [attachment],
    })
    if (error) {
      throw new Error(`email send falhou: ${error.message}`)
    }
    return { externalMessageId: data?.id ?? '' }
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
    if (!from) return { messages, statuses }

    const senderName = (b.fromName || '').trim() || from
    const baseId = b.messageId?.trim() || `${from}:${Date.now()}`
    const text = (b.text && b.text.trim()) || (b.html ? htmlToText(b.html) : '')
    const subject = (b.subject || '').trim()
    const content = subject ? `✉️ ${subject}\n\n${text}` : text

    // Anexos "de verdade". Gmail/iPhone mandam FOTO como `inline` (não
    // "attachment"), então não dá pra descartar todo inline — senão a foto do
    // cliente some. Só descartamos inline PEQUENO (logo/pixel de assinatura
    // embutido). Foto/arquivo real (grande) sempre entra.
    const INLINE_MIN_BYTES = 20 * 1024
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).filter(
      (a): a is Required<Pick<EmailAttachment, 'base64'>> & EmailAttachment => {
        if (!a || typeof a.base64 !== 'string' || !a.base64) return false
        if (a.disposition === 'inline') {
          const bytes = Math.floor((a.base64.length * 3) / 4)
          if (bytes < INLINE_MIN_BYTES) return false
        }
        return true
      },
    )

    // Texto: emite quando há corpo/assunto, OU quando não há anexo (pra a
    // mensagem não sumir num e-mail só-anexo com corpo vazio).
    if (content.trim() || attachments.length === 0) {
      messages.push({
        externalMessageId: baseId,
        fromPhoneE164: '',
        senderExternalId: from,
        senderName,
        fromMe: false,
        contentType: 'text',
        contentText: content || '(sem conteúdo)',
      })
    }

    // Um anexo = uma mensagem de mídia (o pipeline sobe pro MinIO via base64).
    attachments.forEach((a, i) => {
      const kind = kindForMime(a.mimeType)
      messages.push({
        externalMessageId: `${baseId}:att${i}`,
        fromPhoneE164: '',
        senderExternalId: from,
        senderName,
        fromMe: false,
        contentType: kind,
        contentText: null,
        media: {
          kind,
          mimetype: a.mimeType,
          base64: a.base64,
          filename: a.filename || undefined,
        },
      })
    })

    return { messages, statuses }
  },
}

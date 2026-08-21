// ============================================================
// Canal GMAIL (pessoal/dedicado do negócio). Igual ao provider de e-mail na
// IDENTIDADE (contato pelo endereço → contacts.external_id), mas o TRANSPORTE é
// a conta Gmail do cliente:
//   ENVIAR:  SMTP do Gmail (smtp.gmail.com) com a SENHA DE APP (2FA). Sai como
//            o Gmail do cliente — a marca dele, sem verificar domínio.
//   RECEBER: IMAP (imap.gmail.com) lido pelo worker de polling — NÃO usa o
//            webhook. Por isso verifyWebhook/parseWebhook são no-op aqui; a
//            ingestão do IMAP monta o NormalizedInbound e chama
//            dispatchInboundMessage direto (ver worker gmail-poll).
//
// credentials JSON: { address, appPassword, fromName? }.
// provider_meta:    { address, gmailLastUid?, gmailUidValidity? } (estado do
//                   polling IMAP fica no provider_meta).
// ============================================================

import nodemailer from 'nodemailer'

import { CAPABILITIES } from '../provider'
import type {
  ChannelCtx,
  OutboundMedia,
  ParsedWebhook,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider'

/** Endereço Gmail do canal (login SMTP/IMAP + From). Sempre minúsculo. */
export function gmailAddressOf(ch: ChannelCtx): string {
  const addr = ch.credentials.address
  if (typeof addr !== 'string' || !addr) {
    throw new Error(`gmail channel ${ch.id} sem credentials.address`)
  }
  return addr.trim().toLowerCase()
}

/** Senha de app (16 letras) — NUNCA a senha normal da conta. */
export function appPasswordOf(ch: ChannelCtx): string {
  const pw = ch.credentials.appPassword
  if (typeof pw !== 'string' || !pw) {
    throw new Error(`gmail channel ${ch.id} sem credentials.appPassword`)
  }
  // O Google mostra a senha em grupos de 4 com espaços — o SMTP quer sem espaço.
  return pw.replace(/\s+/g, '')
}

function fromNameOf(ch: ChannelCtx): string {
  return (
    (typeof ch.credentials.fromName === 'string' && ch.credentials.fromName) ||
    ch.name ||
    'Atendimento'
  )
}

/** Assunto sempre em 1 linha (defensivo). */
function oneLineSubject(s: string): string {
  const clean = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return clean || 'Atendimento'
}

function stripB64Prefix(b64: string): string {
  return b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
}

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

/** Transporte SMTP autenticado do Gmail (porta 465, SSL). */
export function gmailTransport(ch: ChannelCtx) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailAddressOf(ch), pass: appPasswordOf(ch) },
  })
}

/** Testa o login SMTP (usado na criação do canal pra falhar rápido se a senha
 *  de app estiver errada). Lança se não conseguir autenticar. */
export async function verifyGmailLogin(
  address: string,
  appPassword: string,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: address.trim().toLowerCase(),
      pass: appPassword.replace(/\s+/g, ''),
    },
  })
  await transport.verify()
}

function subjectOf(ch: ChannelCtx, override?: string): string {
  return oneLineSubject(
    (override && override.trim()) ||
      (typeof ch.providerMeta.replySubject === 'string' &&
        ch.providerMeta.replySubject) ||
      'Atendimento',
  )
}

export const gmailProvider: WhatsAppProvider = {
  id: 'gmail',
  capabilities: CAPABILITIES.gmail,

  // `to` = e-mail do cliente (vem de contacts.external_id no send-message).
  async sendText(ch, to, text, options) {
    const address = gmailAddressOf(ch)
    const info = await gmailTransport(ch).sendMail({
      from: `${fromNameOf(ch)} <${address}>`,
      to,
      replyTo: address,
      subject: subjectOf(ch, options?.subject),
      text,
    })
    return { externalMessageId: info.messageId ?? '' }
  },

  async sendMedia(ch, to, media) {
    const address = gmailAddressOf(ch)
    const caption = (media.caption || '').trim()
    const filename = (media.filename || '').trim() || defaultFilename(media)

    // Baixa os bytes no servidor e anexa como conteúdo.
    let content: Buffer | null = null
    if (media.base64) {
      content = Buffer.from(stripB64Prefix(media.base64), 'base64')
    } else if (media.url) {
      const res = await fetch(media.url)
      if (!res.ok) throw new Error(`não consegui baixar o anexo (${res.status})`)
      content = Buffer.from(await res.arrayBuffer())
    }
    if (!content) throw new Error('Anexo sem conteúdo (sem url nem base64).')

    const info = await gmailTransport(ch).sendMail({
      from: `${fromNameOf(ch)} <${address}>`,
      to,
      replyTo: address,
      subject: subjectOf(ch),
      text: caption || 'Segue o anexo.',
      attachments: [{ filename, content }],
    })
    return { externalMessageId: info.messageId ?? '' }
  },

  // Gmail NÃO usa o webhook — recebe por IMAP (worker). No-op defensivo.
  async verifyWebhook(_ctx: WebhookVerifyCtx, _ch: ChannelCtx | null) {
    return false
  },
  parseWebhook(): ParsedWebhook {
    return { messages: [], statuses: [] }
  },
}

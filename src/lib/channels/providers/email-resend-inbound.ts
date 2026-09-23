// ============================================================
// 📥 E-mail recebido pelo RESEND (webhook `email.received`).
//
// 22/09 (Rafael Odonto): o cliente configurou o recebimento do domínio dele no
// próprio Resend e apontou o webhook do Resend para /api/webhooks/email. O
// Resend NÃO manda o e-mail: manda um evento `{ type: 'email.received',
// data: { email_id, from, to[], subject, message_id, attachments[] } }`, sem
// corpo — e a rota, que só entendia o JSON do Cloudflare Worker ({ to, from,
// text… }), respondia 400 "campo 'to' ausente". Dois e-mails ficaram só no
// painel do Resend.
//
// Aqui: reconhece o evento, acha o canal pelo destinatário e BUSCA o e-mail
// completo na API do Resend com a chave do próprio canal. A busca é também a
// prova de origem: só quem tem a chave lê aquele e-mail, e o que volta é o
// que o Resend entregou — não o que veio no POST. Sem segredo de webhook para
// o cliente colar (a chave já está no canal).
//
// Puro na parte de reconhecer/normalizar (testável); a busca vai na função
// `fetchResendReceivedEmail`, injetável.
// ============================================================

import { Resend } from 'resend'

/** O que a rota já entende (mesmo JSON do Cloudflare Worker). */
export interface InboundEmailJson {
  to: string
  from: string
  fromName: string
  subject: string
  text: string
  html: string
  messageId: string
  attachments: { filename: string; mimeType: string; disposition: string | null; base64: string }[]
}

export interface ResendReceivedEvent {
  type: 'email.received'
  data: {
    email_id: string
    from?: string
    to?: string[]
    cc?: string[]
    bcc?: string[]
    received_for?: string[]
    subject?: string
    message_id?: string
  }
}

/** É um evento de webhook do Resend (qualquer tipo)? `type` começa com "email." etc. */
export function isResendWebhookEvent(body: unknown): body is { type: string; data?: unknown } {
  return !!body && typeof body === 'object' && typeof (body as { type?: unknown }).type === 'string' && 'data' in (body as object)
}

export function isResendReceivedEvent(body: unknown): body is ResendReceivedEvent {
  if (!isResendWebhookEvent(body) || body.type !== 'email.received') return false
  const d = (body as { data?: { email_id?: unknown } }).data
  return !!d && typeof d === 'object' && typeof d.email_id === 'string' && d.email_id.length > 0
}

/** Só o endereço, minúsculo, de um "Nome <email>" ou "email". */
export function bareAddress(v: unknown): string {
  if (typeof v !== 'string') return ''
  const m = v.match(/<([^>]+)>/)
  return (m ? m[1] : v).trim().toLowerCase()
}

/**
 * Endereços em que o e-mail pode ter chegado, na ordem em que vale procurar o
 * canal: a caixa que de fato recebeu (`received_for`), depois To, Cc, Cco.
 */
export function resendRecipientCandidates(ev: ResendReceivedEvent): string[] {
  const d = ev.data
  const all = [...(d.received_for ?? []), ...(d.to ?? []), ...(d.cc ?? []), ...(d.bcc ?? [])].map(bareAddress).filter(Boolean)
  return [...new Set(all)]
}

/** O e-mail completo como a API do Resend devolve (GET /emails/receiving/{id}). */
export interface ResendReceivedEmail {
  id: string
  from: string
  to: string[]
  received_for?: string[]
  cc?: string[] | null
  bcc?: string[] | null
  subject: string | null
  html: string | null
  text: string | null
  message_id: string
  attachments: { id: string; filename: string | null; size: number; content_type: string; content_disposition: string | null }[]
}

/** Anexo individual acima disso a gente ignora (mesmo teto da rota). */
export const MAX_RESEND_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Anexos por e-mail que a gente baixa (cada um é uma chamada + download). */
export const MAX_RESEND_ATTACHMENTS = 10

/** "Nome <email>" → nome (vazio se não há). */
function displayName(v: string): string {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/)
  return m ? m[1].trim() : ''
}

/**
 * Monta o JSON que a rota entende a partir do e-mail buscado. `to` = o
 * endereço do canal (é por ele que a rota roteia), não o primeiro To do
 * e-mail — um e-mail com Cc para dois canais chega em cada um pelo seu.
 */
export function resendEmailToInboundJson(
  email: ResendReceivedEmail,
  channelAddress: string,
  attachments: InboundEmailJson['attachments'],
): InboundEmailJson {
  return {
    to: channelAddress,
    from: bareAddress(email.from),
    fromName: displayName(email.from),
    subject: email.subject ?? '',
    text: email.text ?? '',
    html: email.html ?? '',
    messageId: email.message_id || `resend:${email.id}`,
    attachments,
  }
}

/**
 * O e-mail chegou mesmo neste endereço? A rota achou o canal pelo endereço
 * que o EVENTO dizia; o e-mail buscado na API é a palavra final.
 */
export function resendEmailDeliveredTo(email: Pick<ResendReceivedEmail, 'to' | 'received_for' | 'cc' | 'bcc'>, channelAddress: string): boolean {
  const addr = channelAddress.trim().toLowerCase()
  const all = [...(email.received_for ?? []), ...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])].map(bareAddress)
  return all.includes(addr)
}

/**
 * Busca o e-mail completo + anexos no Resend com a chave do canal. Lança com
 * mensagem legível quando a chave não lê aquele e-mail (é de outra conta do
 * Resend, ou a chave é só de envio).
 */
export async function fetchResendReceivedEmail(
  apiKey: string,
  emailId: string,
  opts: { download?: (url: string) => Promise<Buffer | null> } = {},
): Promise<{ email: ResendReceivedEmail; attachments: InboundEmailJson['attachments'] }> {
  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.receiving.get(emailId)
  if (error || !data) throw new Error(`Resend não devolveu o e-mail ${emailId}: ${error?.message ?? 'sem dados'}`)
  const email = data as unknown as ResendReceivedEmail

  const download = opts.download ?? defaultDownload
  const attachments: InboundEmailJson['attachments'] = []
  for (const a of (email.attachments ?? []).slice(0, MAX_RESEND_ATTACHMENTS)) {
    if (!a?.id || a.size > MAX_RESEND_ATTACHMENT_BYTES) continue
    try {
      const { data: meta, error: attErr } = await resend.emails.receiving.attachments.get({ emailId, id: a.id })
      const url = (meta as { download_url?: string } | null)?.download_url
      if (attErr || !url) continue
      const buf = await download(url)
      if (!buf || buf.length === 0 || buf.length > MAX_RESEND_ATTACHMENT_BYTES) continue
      attachments.push({
        filename: a.filename || '',
        mimeType: a.content_type || 'application/octet-stream',
        disposition: a.content_disposition ?? null,
        base64: buf.toString('base64'),
      })
    } catch (err) {
      // Anexo que não baixou não derruba o e-mail: o texto entra, o anexo não.
      console.warn(`[webhooks/email] anexo ${a.id} do e-mail ${emailId} não baixou:`, err instanceof Error ? err.message : err)
    }
  }
  return { email, attachments }
}

async function defaultDownload(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

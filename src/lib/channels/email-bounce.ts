// ============================================================
// 📭 Devolução de e-mail (DSN, RFC 3464) — LEITURA. PURO: sem banco, sem
// 'server-only', sem Buffer (roda no worker, na web e no navegador).
//
// 15/09 (GoLink/Vale Modelo): a cobrança de 14/09 que saiu pelo Gmail para
// financeiro@empresa-exemplo.com.br voltou — o domínio tem Null MX (5.1.10). O aviso do
// mailer-daemon@googlemail.com entrou como e-mail comum: virou o contato
// "Mail Delivery Subsystem" com conversa aberta, a mensagem original seguiu
// "enviada" e a régua ia mandar de novo para o mesmo endereço em 17/09.
//
// Aqui só se LÊ o relatório: quem não recebeu, por quê e qual envio nosso
// voltou. O Message-ID sai nas DUAS formas ("<id>" e "id"): o envio pelo Gmail
// grava messages.message_id com <>, outros caminhos gravam sem.
// O que fazer com isso (nota, falha, supressão): email-bounce-apply.ts.
// ============================================================

import type { Attachment, Email } from 'postal-mime'

export interface DeliveryRecipient {
  /** Minúsculo, sem "rfc822;" e sem <>. */
  address: string
  /** failed | delayed | delivered | relayed | expanded ('' quando o aviso não diz). */
  action: string
  /** Código do servidor, ex.: "5.1.10". null quando não veio. */
  status: string | null
  /** Diagnostic-Code sem o tipo ("smtp;"), numa linha só. */
  diagnostic: string | null
}

export interface DeliveryReport {
  recipients: DeliveryRecipient[]
  /** To/Cc do envio original (cópia dos cabeçalhos no aviso), minúsculos. */
  originalRecipients: string[]
  /**
   * Veio de um servidor de e-mail (mailer-daemon/postmaster, Return-Path vazio)
   * e não foi reprovado na autenticação. Só aviso confiável mexe em mensagem,
   * nota e supressão; o resto segue como e-mail comum.
   */
  trusted: boolean
  /** Message-ID do envio que voltou, nas duas formas (com e sem <>). */
  originalMessageIds: string[]
  /** Algum destinatário com Action: failed. Atraso (delayed) NÃO é falha. */
  failed: boolean
  /** Alguma falha com Status 5.x.x — o servidor não vai aceitar de novo. */
  permanent: boolean
  /** Message-ID do próprio aviso de devolução (só para log). */
  dsnMessageId: string | null
  subject: string | null
  date: string | null
}

export interface DeliveryReportExtra {
  inReplyTo?: string | null
  references?: string | null
  dsnMessageId?: string | null
  subject?: string | null
  date?: string | null
  /** Corpo legível do aviso — só para o último recurso de achar o Message-ID. */
  searchText?: string | null
}

const DSN_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status'])
const HEADERS_TYPES = new Set(['text/rfc822-headers', 'message/rfc822', 'message/global', 'message/global-headers'])

/** Código de status "classe.assunto.detalhe" solto num texto (não pega IP). */
const STATUS_IN_TEXT_RE = /(?:^|[^\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d.])/
/** Formato do Message-ID que o nodemailer gera nos nossos envios: <uuid@domínio>. */
const OUR_MESSAGE_ID_RE = /<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[a-z0-9.-]+>/gi
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/
/** Tetos contra aviso forjado/gigante (cada destinatário vira consulta e nota). */
const MAX_RECIPIENTS = 20
const MAX_MESSAGE_ID_FORMS = 10
const MAX_REPORT_CHARS = 256_000

// ------------------------------------------------------------ utilidades

function decodeContent(content: Attachment['content'] | undefined, encoding?: string): string {
  try {
    const dec = new TextDecoder('utf-8')
    if (typeof content === 'string') {
      if (encoding !== 'base64') return content
      const bin = atob(content)
      return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    }
    if (!content) return ''
    if (ArrayBuffer.isView(content)) {
      return dec.decode(new Uint8Array(content.buffer, content.byteOffset, content.byteLength))
    }
    return dec.decode(new Uint8Array(content as ArrayBuffer))
  } catch {
    return ''
  }
}

const attachmentText = (a: Attachment) => decodeContent(a.content, a.encoding)
const mimeOf = (a: Attachment) => (a.mimeType || '').trim().toLowerCase()

/**
 * Blocos "Campo: valor" separados por linha em branco (RFC 3464 / cabeçalhos),
 * com continuação de linha (linha que começa com espaço/tab). Campo em
 * minúsculas; repetido fica o primeiro.
 */
function fieldBlocks(text: string): Map<string, string>[] {
  const out: Map<string, string>[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const fields = new Map<string, string>()
    let last: string | null = null
    for (const line of block.split('\n')) {
      if (!line.trim()) continue
      if (/^[ \t]/.test(line)) {
        if (last) fields.set(last, `${fields.get(last)} ${line.trim()}`.trim())
        continue
      }
      const m = line.match(/^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/)
      if (!m) {
        last = null
        continue
      }
      const key = m[1].toLowerCase()
      if (fields.has(key)) {
        last = null
        continue
      }
      fields.set(key, m[2].trim())
      last = key
    }
    if (fields.size) out.push(fields)
  }
  return out
}

/** "rfc822; <Fulano@X.com>" → "fulano@x.com". */
function bareAddress(value: string | undefined): string | null {
  if (!value) return null
  let s = value.trim()
  const semi = s.indexOf(';')
  if (semi > 0 && /^[a-z0-9-]+$/i.test(s.slice(0, semi).trim())) s = s.slice(semi + 1)
  s = s.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase()
  return EMAIL_RE.test(s) ? s : null
}

function statusCode(value: string | undefined | null): string | null {
  const m = (value ?? '').match(STATUS_IN_TEXT_RE)
  return m ? m[1] : null
}

function diagnosticText(value: string | undefined): string | null {
  if (!value) return null
  const s = value.replace(/^[a-z0-9-]+;\s*/i, '').replace(/\s+/g, ' ').trim()
  return s || null
}

/** Todas as formas de todos os Message-IDs de um cabeçalho (References tem vários). */
export function messageIdForms(raw: string | null | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  const ids = trimmed.match(/<[^<>\s]+>/g) ?? (trimmed && !/\s/.test(trimmed) ? [trimmed] : [])
  const out: string[] = []
  for (const id of ids) {
    const bare = id.replace(/^<+/, '').replace(/>+$/, '')
    if (!bare.includes('@')) continue
    out.push(`<${bare}>`, bare)
  }
  return out
}

const dedupe = (xs: string[]) => Array.from(new Set(xs))

/** Message-ID do cabeçalho do envio original (anexo text/rfc822-headers ou message/rfc822). */
function headersMessageId(headersText: string | null | undefined): string | null {
  if (!headersText) return null
  const [first] = fieldBlocks(headersText)
  return first?.get('message-id') ?? null
}

/** Todos os e-mails válidos de um campo ("a@x.com, b@y.com" do Asaas), minúsculos. */
export function emailAddressesIn(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const out: string[] = []
  for (const parte of value.split(/[,;\s]+/)) {
    const e = parte.trim().replace(/^<+/, '').replace(/>+$/, '').toLowerCase()
    if (e && EMAIL_RE.test(e)) out.push(e)
  }
  return dedupe(out)
}

// ------------------------------------------------------------ relatório

/** To/Cc do cabeçalho do envio original. */
function headersRecipients(headersText: string | null | undefined): string[] {
  if (!headersText) return []
  const [first] = fieldBlocks(headersText.slice(0, MAX_REPORT_CHARS))
  if (!first) return []
  const found = [first.get('to'), first.get('cc')].flatMap((v) =>
    (v ?? '').split(',').map((part) => bareAddress(part.match(/<([^>]+)>/)?.[1] ?? part)).filter((a): a is string => !!a),
  )
  return dedupe(found).slice(0, MAX_RECIPIENTS)
}

function finalize(
  recipients: DeliveryRecipient[],
  strongIds: string[],
  headersText: string | null | undefined,
  extra: DeliveryReportExtra,
  scanTexts: (string | null | undefined)[],
): DeliveryReport {
  let ids = dedupe(strongIds)
  if (!ids.length) {
    // Sem X-Original-Message-ID nem cópia do cabeçalho: vale o In-Reply-To e,
    // depois, o References do próprio aviso (do mais novo para o mais velho).
    const refs = (extra.references ?? '').match(/<[^<>\s]+>/g) ?? []
    ids = dedupe([...messageIdForms(extra.inReplyTo), ...refs.reverse().flatMap((r) => messageIdForms(r))])
  }
  if (!ids.length) {
    // Último recurso: o formato dos nossos envios em qualquer texto do aviso.
    const found = [headersText, extra.searchText, ...scanTexts].flatMap((t) => (t ?? '').slice(0, MAX_REPORT_CHARS).match(OUR_MESSAGE_ID_RE) ?? [])
    ids = dedupe(found.flatMap((f) => messageIdForms(f)))
  }
  // Um destinatário por endereço, com teto.
  const seen = new Set<string>()
  const unique = recipients.filter((r) => (seen.has(r.address) ? false : (seen.add(r.address), true))).slice(0, MAX_RECIPIENTS)
  const failed = unique.some((r) => r.action === 'failed')
  const permanent = unique.some((r) => r.action === 'failed' && !!r.status?.startsWith('5.'))
  return {
    recipients: unique,
    originalRecipients: headersRecipients(headersText),
    trusted: true,
    originalMessageIds: ids.slice(0, MAX_MESSAGE_ID_FORMS),
    failed,
    permanent,
    dsnMessageId: extra.dsnMessageId?.trim() || null,
    subject: extra.subject?.trim() || null,
    date: extra.date?.trim() || null,
  }
}

/**
 * Lê o texto de um message/delivery-status (1º bloco por-mensagem, demais por
 * destinatário). Reaproveitável para reaplicar a partir do anexo guardado.
 */
export function reportFromDeliveryStatus(
  deliveryStatusText: string,
  headersText?: string | null,
  extra: DeliveryReportExtra = {},
): DeliveryReport {
  const recipients: DeliveryRecipient[] = []
  const strongIds: string[] = []
  for (const block of fieldBlocks((deliveryStatusText ?? '').slice(0, MAX_REPORT_CHARS))) {
    strongIds.push(...messageIdForms(block.get('x-original-message-id')))
    if (!block.has('final-recipient') && !block.has('original-recipient')) continue
    const address = bareAddress(block.get('final-recipient')) ?? bareAddress(block.get('original-recipient'))
    if (!address) continue
    recipients.push({
      address,
      action: (block.get('action') ?? '').trim().toLowerCase(),
      status: statusCode(block.get('status')),
      diagnostic: diagnosticText(block.get('diagnostic-code')),
    })
  }
  strongIds.push(...messageIdForms(headersMessageId(headersText)))
  return finalize(recipients, strongIds, headersText, extra, [deliveryStatusText])
}

function headerValue(parsed: Email, key: string): string {
  return (parsed.headers ?? []).find((h) => h.key === key)?.value ?? ''
}

const MTA_LOCAL = /^(?:mailer-daemon|mail-daemon|mailerdaemon|postmaster)$/i

/**
 * O aviso veio de um servidor de e-mail? Remetente mailer-daemon/postmaster
 * (ou o MicrosoftExchange… do Office 365) ou Return-Path vazio (<>, RFC 3464),
 * E a autenticação que o Gmail anota na entrada não reprovou. Sem isso,
 * qualquer um que recebeu uma cobrança poderia montar um "aviso" pra marcar o
 * próprio e-mail como inválido — ou esconder uma mensagem do CRM.
 */
export function isTrustedBounceSender(parsed: Email): boolean {
  const from = (parsed.from && 'address' in parsed.from ? (parsed.from.address ?? '') : '').trim().toLowerCase()
  const local = from.split('@')[0] ?? ''
  const returnPath = headerValue(parsed, 'return-path').trim()
  const looksLikeMta = MTA_LOCAL.test(local) || /^microsoftexchange/i.test(local) || returnPath === '<>'
  if (!looksLikeMta) return false
  // Só a PRIMEIRA anotação (a do nosso servidor de entrada); as de baixo podem ter vindo no próprio e-mail.
  const auth = headerValue(parsed, 'authentication-results').toLowerCase()
  if (!auth) return true // aviso gerado dentro do próprio Gmail não traz anotação
  const pass = /\b(?:dkim|spf|dmarc)=pass\b/.test(auth)
  const fail = /\b(?:dkim|spf|dmarc)=(?:fail|softfail|permerror)\b/.test(auth)
  return pass || !fail
}

/**
 * É aviso de devolução? Detecta por (a) Content-Type raiz multipart/report com
 * report-type=delivery-status, (b) anexo message/delivery-status, ou
 * (c) remetente mailer-daemon/postmaster com X-Failed-Recipients (Exim, alguns
 * Exchange). Senão null — e o e-mail segue o caminho normal.
 */
export function parseDeliveryReport(parsed: Email): DeliveryReport | null {
  const attachments = parsed.attachments ?? []
  const dsnPart = attachments.find((a) => DSN_TYPES.has(mimeOf(a)))
  const rootType = headerValue(parsed, 'content-type')
  const isReport =
    /^\s*multipart\/report\b/i.test(rootType) && /report-type\s*=\s*"?(?:global-)?delivery-status\b/i.test(rootType)
  const failedHeader = headerValue(parsed, 'x-failed-recipients')
  const fromAddress = parsed.from && 'address' in parsed.from ? (parsed.from.address ?? '') : ''
  const byDaemon = /^(?:mailer-daemon|postmaster)@/i.test(fromAddress.trim()) && !!failedHeader.trim()
  if (!dsnPart && !isReport && !byDaemon) return null

  const headersPart = attachments.find((a) => HEADERS_TYPES.has(mimeOf(a)))
  const headersText = headersPart ? attachmentText(headersPart) : null
  const extra: DeliveryReportExtra = {
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    dsnMessageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    searchText: [parsed.text, parsed.html].filter(Boolean).join('\n'),
  }

  const trusted = isTrustedBounceSender(parsed)
  if (dsnPart) {
    const report = reportFromDeliveryStatus(attachmentText(dsnPart), headersText, extra)
    if (report.recipients.length || !failedHeader.trim()) return { ...report, trusted }
  }

  // Sem message/delivery-status legível: quem falhou vem do X-Failed-Recipients
  // e o código, do texto do aviso ("550 5.1.1 ... user unknown").
  const text = parsed.text ?? ''
  const status = statusCode(text)
  const line = status ? text.split(/\r?\n/).find((l) => l.includes(status)) : undefined
  const recipients: DeliveryRecipient[] = emailAddressesIn(failedHeader).map((address) => ({
    address,
    action: 'failed',
    status,
    diagnostic: line ? line.replace(/\s+/g, ' ').trim().slice(0, 1000) : null,
  }))
  return { ...finalize(recipients, messageIdForms(headersMessageId(headersText)), headersText, extra, []), trusted }
}

// ------------------------------------------------------------ textos

const STATUS_REASONS: Record<string, string> = {
  '5.1.10': 'o domínio não recebe e-mail',
  '5.1.1': 'o endereço não existe',
  '5.1.2': 'o domínio do e-mail não existe',
  '5.1.3': 'o endereço está escrito errado',
  '5.4.4': 'o domínio do e-mail não existe',
  '5.2.1': 'a caixa de e-mail está desativada',
  '5.2.2': 'a caixa de entrada está cheia',
  '4.2.2': 'a caixa de entrada está cheia',
}

/** Motivo curto, em português simples, a partir do código e do diagnóstico. */
export function bounceReason(status: string | null | undefined, diagnostic?: string | null): string {
  const s = (status ?? '').trim()
  const d = (diagnostic ?? '').toLowerCase()
  if (/null mx/.test(d)) return 'o domínio não recebe e-mail'
  if (STATUS_REASONS[s]) return STATUS_REASONS[s]
  if (s.startsWith('5.7.')) return 'o servidor do cliente recusou a mensagem'
  if (s.startsWith('4.')) return 'o servidor do cliente não aceitou por enquanto (problema temporário)'
  // Código genérico (5.0.0, sem código): o diagnóstico costuma dizer mais.
  if (/nxdomain|domain not found|no such domain|host not found|host or domain name not found/.test(d)) {
    return 'o domínio do e-mail não existe'
  }
  if (/user unknown|unknown user|no such user|does not exist|doesn't exist|mailbox not found|mailbox unavailable|invalid recipient/.test(d)) {
    return 'o endereço não existe'
  }
  if (/mailbox full|over quota|quota exceeded/.test(d)) return 'a caixa de entrada está cheia'
  return 'o servidor do cliente recusou a entrega'
}

/** Falha que não adianta tentar de novo (5.x.x) — marca o envio como falhou. */
export function isPermanentFailure(r: DeliveryRecipient): boolean {
  return r.action === 'failed' && !!r.status?.startsWith('5.')
}

const ADDRESS_STATUSES = new Set(['5.1.1', '5.1.2', '5.1.3', '5.1.10', '5.2.1', '5.4.4'])
const ADDRESS_DIAGNOSTIC =
  /null mx|user unknown|unknown user|no such user|does not exist|doesn't exist|mailbox not found|mailbox unavailable|invalid recipient|recipient not found|nxdomain|no such domain|domain not found|host not found|host or domain name not found/i

/**
 * O ENDEREÇO não serve (não existe, domínio não recebe, caixa desativada) —
 * só isso suprime. Caixa cheia (5.2.2) e recusa por política/spam (5.7.x) têm
 * e-mail certo: marcam falha e avisam, mas a régua segue mandando.
 */
export function isAddressFailure(r: DeliveryRecipient): boolean {
  if (r.action !== 'failed') return false
  const s = (r.status ?? '').trim()
  if (ADDRESS_STATUSES.has(s)) return true
  const generic = !s || /^5\.0\.\d+$/.test(s)
  return generic && ADDRESS_DIAGNOSTIC.test(r.diagnostic ?? '')
}

/**
 * Nota interna na conversa do envio que voltou. `suppressed` = o endereço
 * entrou na lista de "e-mail voltou" (só aí a nota promete que a régua para).
 * Nunca começa com "🔀 " (esse prefixo é do "Continuar pelo meu número").
 */
export function bounceNoteText(
  report: DeliveryReport,
  recipient: DeliveryRecipient,
  opts: { suppressed?: boolean } = {},
): string {
  const code = recipient.status ? ` (${recipient.status})` : ''
  const reason = bounceReason(recipient.status, recipient.diagnostic)
  const status = (recipient.status ?? '').trim()
  const others = report.recipients.filter((r) => r.action === 'failed' && r.address !== recipient.address).length
  let tail: string
  if (opts.suppressed) {
    tail =
      'A régua não manda mais e-mail para este endereço. Corrija o e-mail do cliente (no CRM e no Asaas); se o cliente arrumar a caixa, use "Liberar de novo" na lateral do contato.'
  } else if (status.startsWith('5.7.')) {
    tail = 'O e-mail pode estar certo: o servidor do cliente barrou a mensagem (filtro de spam ou regra da empresa). Confirme com o cliente ou cobre pelo WhatsApp.'
  } else if (status.startsWith('5.2.') || status.startsWith('4.')) {
    tail = 'O endereço está certo; pode dar certo mais tarde.'
  } else if (isPermanentFailure(recipient)) {
    tail = 'Confira o e-mail com o cliente.'
  } else {
    tail = 'Pode ser passageiro; se voltar a acontecer, confira o e-mail do cliente.'
  }
  const also = others ? ` Outros ${others} destinatário(s) deste envio também não receberam.` : ''
  return `📭 O e-mail não foi entregue para ${recipient.address} — ${reason}${code}. ${tail}${also}`
}

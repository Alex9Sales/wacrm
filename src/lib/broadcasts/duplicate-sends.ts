// ============================================================
// Quem JÁ recebeu esta mesma mensagem hoje — pra não mandar 2×.
//
// 15/09 (GoLink): o Vitor refez o "dia do cliente" 3 vezes (outro número,
// imagem subida de novo) e Flash Baterias, Piso Decor e Vidro e Cia
// receberam a mesma imagem 2×; outros já tinham recebido à mão.
//
// Duas fontes na criação do disparo, uma consulta cada (inArray nos
// contatos, janela de 24 h):
//   (i)  broadcast_recipients de disparos de texto da conta com o mesmo
//        conteúdo que SAÍRAM (sent/delivered/read/replied) — ou que ainda
//        estão NA FILA (pending) de um disparo ativo (sending/scheduled)
//        criado nas últimas 24 h. Revisão 15/09: quem refazia o disparo
//        achando que não tinha saído mandava 2× pra quem ainda esperava a vez.
//        Disparo pausado/cancelado não conta: pode nunca sair, e se voltar o
//        worker confere na hora (contactAlreadyReceivedElsewhere).
//        Mesmo conteúdo = texto normalizado igual (+ assunto igual no
//        e-mail); sem texto, o mesmo conjunto de anexos pelo NOME (a URL muda
//        a cada upload; o nome não) — nome genérico ("image.png") não prova
//        nada. Template fica fora (template-broadcast.ts cuida).
//   (ii) messages de agente/robô (não nota interna) nas conversas da conta
//        com o mesmo texto — pega o envio À MÃO e o de um disparo que foi
//        excluído (excluir apaga os destinatários, a mensagem fica). A
//        legenda de imagem conta (é o content_text do eco). Só com texto de
//        20+ caracteres: um "Bom dia!" digitado à mão não pode barrar campanha.
// A comparação de texto roda nos DOIS lados pela mesma expressão SQL, pra
// não depender do lower()/espaço do JS bater com o do Postgres.
//
// Na hora do ENVIO o worker chama contactAlreadyReceivedElsewhere (uma
// consulta, só disparos): cobre o disparo pausado que volta depois que outro
// já mandou a mesma coisa.
//
// Worker-safe (sem 'server-only').
// ============================================================

import { and, eq, gte, inArray, isNotNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients, contacts, conversations, messages } from '@/db'
import { appendOptOutLine } from '@/lib/contacts/opt-out'

export type DuplicateReason = 'same_text' | 'same_files' | 'same_template' | 'queued'

export interface DuplicateSkip {
  contactId: string
  name: string | null
  /** Quando recebeu a mesma mensagem (ISO). Na fila: quando entrou. */
  lastSentAt: string
  /**
   * Por que ficou de fora (revisão 15/09): mesmo texto/legenda, mesmos
   * arquivos, mesmo template com os mesmos valores, ou já está NA FILA de um
   * disparo ativo com a mesma mensagem.
   */
  reason?: DuplicateReason
}

export interface BroadcastContentFingerprint {
  bodyText: string | null
  /** Nomes dos arquivos anexados (a URL muda a cada upload; o nome não). */
  mediaFilenames: string[]
  /** Assunto do e-mail: quando vem, também tem que bater. */
  subject?: string | null
}

/** Janela padrão: 24 h. */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Status de destinatário que significam "a mensagem saiu". */
export const SENT_RECIPIENT_STATUSES = ['sent', 'delivered', 'read', 'replied']

/** Disparo que ainda vai mandar os pendentes (pausado/cancelado ficam fora). */
export const ACTIVE_BROADCAST_STATUSES = ['sending', 'scheduled']

/**
 * Texto mínimo (normalizado) pra uma mensagem À MÃO contar como repetida.
 * "Bom dia!" / "Oi, tudo bem?" são ditos todo dia e não identificam campanha.
 */
export const MIN_MANUAL_TEXT_CHARS = 20

/** Motivo gravado no destinatário que o worker pula na hora do envio. */
export const ALREADY_RECEIVED_ELSEWHERE_ERROR =
  'Já recebeu esta mensagem por outro disparo nas últimas 24 h'

/** trim + espaços (inclusive quebras de linha) colapsados + minúsculas. */
export function normalizeBroadcastText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Nome estável de um anexo: o filename; sem ele, o último pedaço da URL
 *  (que é único por upload — então sem filename nunca casa com outro envio). */
export function mediaFingerprintName(m: {
  url?: string | null
  filename?: string | null
}): string | null {
  const fromName = (m.filename ?? '').trim()
  if (fromName) return fromName.toLowerCase()
  const url = (m.url ?? '').trim()
  if (!url) return null
  const last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    /* nome com % solto — fica como veio */
  }
  return decoded.trim().toLowerCase() || null
}

/** Nomes de arquivo normalizados, sem repetição e ordenados (conjunto). */
export function normalizeFilenameSet(names: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>()
  for (const n of names) {
    const v = (n ?? '').trim().toLowerCase()
    if (v) set.add(v)
  }
  return [...set].sort()
}

/**
 * Nomes que o celular/app dá sozinho e que se repetem entre arquivos
 * DIFERENTES (revisão 15/09): "image.png" de hoje não é o "image.png" de
 * ontem. Comparado sem extensão e sem "(1)"/"cópia" no fim.
 */
const GENERIC_FILENAME_PATTERNS: RegExp[] = [
  // image.png, imagem (2).jpg, arquivo.pdf, documento-1.pdf, foto.jpg, video.mp4
  /^(image|imagem|img|foto|photo|picture|pic|video|vídeo|audio|áudio|arquivo|documento|document|doc|file|anexo|attachment|download|untitled|sem t[ií]tulo|sem nome)([\s_-]*\d+)?$/u,
  // IMG_1234, IMG-20260915-WA0001, VID_20260915_101010, PXL_20260915_123456789, DSC01234
  /^(img|vid|aud|ptt|pxl|dsc|dscn|dcim|mvimg|photo|video|image|doc|stk)[\s_-]*\d[\d\s_.-]*(wa\d+)?$/u,
  // WhatsApp Image 2026-09-15 at 10.00.00
  /^whatsapp (image|video|audio|ptt|document|imagem|vídeo|áudio|documento)(?!\p{L})/u,
  // Captura de Tela 2026-09-15 às 10.00.00, Screenshot_20260915, Screen Shot …, Print …
  /^(captura de tela|screenshot|screen shot|screen recording|gravação de tela|print|printscreen)(?!\p{L})/u,
  // Canva: "Design sem nome", "Design sem nome (3)", "Untitled design"
  /^(design sem nome|untitled design)(?!\p{L})/u,
  // só dígitos (com separadores): 1726400000000.jpg, 20260915_101010.jpg
  /^[\d\s_.-]+$/u,
]

/** true = o nome sozinho não diz que é o mesmo arquivo (ver padrões acima). */
export function isGenericFilename(name: string | null | undefined): boolean {
  let base = (name ?? '').trim().toLowerCase()
  if (!base) return true
  base = base.replace(/\.[a-z0-9]{1,5}$/u, '')
  base = base
    .replace(/\s*\(\d+\)$/u, '')
    .replace(/[\s_-]*(copy|cópia|copia)(\s*\d+)?$/u, '')
    .trim()
  if (!base) return true
  return GENERIC_FILENAME_PATTERNS.some((re) => re.test(base))
}

/**
 * Mesmos anexos? Conjuntos normalizados (ver normalizeFilenameSet). Nome
 * genérico não serve de prova: compara só os nomes que identificam o arquivo
 * (tem que haver pelo menos um) e exige a mesma quantidade — um anexo a mais,
 * mesmo "image.png", pode ser conteúdo novo.
 */
export function sameAttachmentSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false
  const da = a.filter((n) => !isGenericFilename(n))
  const dbn = b.filter((n) => !isGenericFilename(n))
  return da.length > 0 && da.length === dbn.length && da.every((v, i) => v === dbn[i])
}

/**
 * Anexos EFETIVOS de um disparo, como o worker envia: `media[]` tem
 * precedência; senão a mídia única antiga (media_url/media_filename).
 */
export function broadcastMediaNames(row: {
  media: unknown
  mediaUrl: string | null
  mediaFilename: string | null
}): string[] {
  const list = Array.isArray(row.media)
    ? (row.media as { url?: string | null; filename?: string | null }[]).filter(
        (m) => !!m && typeof m === 'object',
      )
    : []
  if (list.length > 0) return normalizeFilenameSet(list.map(mediaFingerprintName))
  if ((row.mediaUrl ?? '').trim()) {
    return normalizeFilenameSet([mediaFingerprintName({ url: row.mediaUrl, filename: row.mediaFilename })])
  }
  return []
}

/**
 * Chave do que a pessoa vê num template (revisão 15/09): valores do corpo +
 * {{1}} do cabeçalho de texto + final dos links dos botões. A mídia do
 * cabeçalho fica fora (a URL muda a cada upload). Botão sem valor = ausente.
 */
export function templateSendKey(send: { params?: unknown; messageParams?: unknown }): string {
  const params = Array.isArray(send.params)
    ? (send.params as unknown[]).filter((p): p is string => typeof p === 'string')
    : []
  const mp = (send.messageParams && typeof send.messageParams === 'object' ? send.messageParams : {}) as Record<
    string,
    unknown
  >
  const headerText = typeof mp.headerText === 'string' ? mp.headerText : ''
  const bp = (mp.buttonParams && typeof mp.buttonParams === 'object' ? mp.buttonParams : {}) as Record<string, unknown>
  const buttons = Object.keys(bp)
    .map((k) => [k, bp[k] == null ? '' : String(bp[k])] as const)
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify({ params, headerText, buttons })
}

/** Mesma normalização de `normalizeBroadcastText`, em SQL (os dois lados). */
function normSql(value: SQLWrapper): SQL {
  return sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`
}

function textParam(value: string): SQL {
  return sql`${value}::text`
}

/**
 * Destinatário SEM mensagem própria ({{mensagem}} do "Chamar de volta"): o
 * corpo do disparo dele não é o que ele recebeu, então não entra na conta.
 */
export function recipientWithoutOwnVarsSql(): SQL {
  return sql`(${broadcastRecipients.vars} IS NULL OR jsonb_typeof(${broadcastRecipients.vars}) <> 'object' OR ${broadcastRecipients.vars} = '{}'::jsonb)`
}

/** Saiu nas últimas 24 h, OU está pendente num disparo ativo criado nelas. */
export function sentOrQueuedSinceSql(since: string): SQL {
  return or(
    and(
      inArray(broadcastRecipients.status, SENT_RECIPIENT_STATUSES),
      gte(broadcastRecipients.sentAt, since),
    ),
    and(
      eq(broadcastRecipients.status, 'pending'),
      inArray(broadcasts.status, ACTIVE_BROADCAST_STATUSES),
      gte(broadcasts.createdAt, since),
    ),
  ) as SQL
}

export function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

/** Guarda o registro mais recente por contato (e o motivo dele). */
export function latestSkipCollector() {
  const latest = new Map<string, { name: string | null; at: string; reason: DuplicateReason }>()
  return {
    note(contactId: string | null, name: string | null, at: string | null, reason: DuplicateReason) {
      const iso = toIso(at)
      if (!contactId || !iso) return
      const prev = latest.get(contactId)
      if (!prev || Date.parse(iso) > Date.parse(prev.at)) latest.set(contactId, { name, at: iso, reason })
    },
    /** Na ordem de `ids`, só quem teve registro. */
    list(ids: readonly string[]): DuplicateSkip[] {
      const out: DuplicateSkip[] = []
      for (const id of ids) {
        const hit = latest.get(id)
        if (hit) out.push({ contactId: id, name: hit.name, lastSentAt: hit.at, reason: hit.reason })
      }
      return out
    },
  }
}

function windowStart(sinceMs: number | undefined): string {
  const windowMs = sinceMs && sinceMs > 0 ? sinceMs : DUPLICATE_WINDOW_MS
  return new Date(Date.now() - windowMs).toISOString()
}

/**
 * Contatos (dentre `contactIds`) que receberam a mesma mensagem nas últimas
 * 24 h (padrão) por qualquer canal da conta — disparo ou envio manual — ou
 * que estão na fila de um disparo ativo com ela.
 * Lista vazia (ou mensagem sem texto e sem anexo que identifique) → [] sem consultar.
 */
export async function findRecentDuplicateContacts(
  accountId: string,
  contactIds: readonly string[],
  content: BroadcastContentFingerprint,
  opts: { sinceMs?: number } = {},
): Promise<DuplicateSkip[]> {
  const ids = Array.from(new Set(contactIds.filter((v): v is string => !!v)))
  if (!accountId || ids.length === 0) return []

  const bodyText = (content.bodyText ?? '').trim()
  const normalized = normalizeBroadcastText(bodyText)
  const hasText = normalized !== ''
  const subject = (content.subject ?? '').trim()
  const mediaNames = normalizeFilenameSet(content.mediaFilenames ?? [])
  // Sem texto e só com nomes genéricos não dá pra dizer que é o mesmo arquivo.
  if (!hasText && !mediaNames.some((n) => !isGenericFilename(n))) return []

  const since = windowStart(opts.sinceMs)
  const skips = latestSkipCollector()

  // (i) Disparos da conta que já saíram (ou estão na fila) pra essas pessoas
  // com o mesmo conteúdo. Com texto: o texto decide (no SQL) — pega a imagem
  // subida de novo com a mesma legenda. Sem texto: só os anexos (conferidos
  // aqui — media é jsonb); o texto do disparo antigo não importa, a pessoa
  // já recebeu esses arquivos. E-mail: o assunto também tem que bater
  // ("Segue em anexo." com assuntos diferentes são e-mails diferentes).
  const contentMatch = hasText
    ? sql`${normSql(broadcasts.bodyText)} = ${normSql(textParam(bodyText))}`
    : (or(isNotNull(broadcasts.media), isNotNull(broadcasts.mediaUrl)) as SQL)
  const subjectMatch = subject
    ? sql`${normSql(broadcasts.subject)} = ${normSql(textParam(subject))}`
    : undefined
  const recipientRows = await db
    .select({
      contactId: broadcastRecipients.contactId,
      name: contacts.name,
      status: broadcastRecipients.status,
      sentAt: broadcastRecipients.sentAt,
      queuedAt: broadcastRecipients.createdAt,
      media: broadcasts.media,
      mediaUrl: broadcasts.mediaUrl,
      mediaFilename: broadcasts.mediaFilename,
    })
    .from(broadcastRecipients)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
    .innerJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
    .where(
      and(
        eq(broadcasts.accountId, accountId),
        ne(broadcasts.messageKind, 'template'),
        inArray(broadcastRecipients.contactId, ids),
        sentOrQueuedSinceSql(since),
        recipientWithoutOwnVarsSql(),
        contentMatch,
        subjectMatch,
      ),
    )
  for (const r of recipientRows) {
    if (!hasText && !sameAttachmentSet(broadcastMediaNames(r), mediaNames)) continue
    if (r.status === 'pending') skips.note(r.contactId, r.name, r.queuedAt, 'queued')
    else skips.note(r.contactId, r.name, r.sentAt, hasText ? 'same_text' : 'same_files')
  }

  // (ii) Mensagens de agente/robô com o mesmo texto (à mão, ou eco de um
  // disparo — com ou sem a linha "responda SAIR" que o worker anexa). Fica de
  // fora: texto curto (saudação do dia a dia) e e-mail com assunto (a
  // mensagem não guarda o assunto, então não dá pra conferir).
  if (hasText && !subject && normalized.length >= MIN_MANUAL_TEXT_CHARS) {
    const candidates = Array.from(new Set([bodyText, appendOptOutLine(bodyText)]))
    const messageRows = await db
      .select({
        contactId: conversations.contactId,
        name: contacts.name,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(
        and(
          eq(conversations.accountId, accountId),
          inArray(conversations.contactId, ids),
          inArray(messages.senderType, ['agent', 'bot']),
          eq(messages.isInternal, false),
          gte(messages.createdAt, since),
          sql`${normSql(messages.contentText)} IN (${sql.join(
            candidates.map((c) => normSql(textParam(c))),
            sql`, `,
          )})`,
        ),
      )
    for (const r of messageRows) skips.note(r.contactId, r.name, r.createdAt, 'same_text')
  }

  return skips.list(ids)
}

/** O que o worker sabe do envio que vai fazer (ver contactAlreadyReceivedElsewhere). */
export interface ReceivedElsewhereInput {
  accountId: string
  /** Disparo atual — os envios dele mesmo não contam. */
  broadcastId: string
  contactId: string
  messageKind: string
  bodyText: string | null
  subject: string | null
  media: unknown
  mediaUrl: string | null
  mediaFilename: string | null
  templateName: string | null
  templateLanguage: string | null
  /** Template: valores do corpo deste destinatário. */
  params?: readonly string[] | null
  /** Template: {{1}} do cabeçalho de texto e final dos links dos botões. */
  messageParams?: unknown
  sinceMs?: number
}

/**
 * Na hora do ENVIO (revisão 15/09): este contato já recebeu a mesma mensagem
 * por OUTRO disparo da conta nas últimas 24 h? Cobre o disparo pausado que
 * volta depois que outro já mandou a mesma coisa — na criação ele não contou
 * como "na fila" (estava pausado). Uma consulta, só em broadcast_recipients
 * que saíram; mesmo conteúdo = texto normalizado (+ assunto no e-mail); sem
 * texto, os mesmos anexos pelo nome (genérico não conta); template = nome +
 * idioma + valores. Quem chama decide o que fazer com erro (o worker segue).
 */
export async function contactAlreadyReceivedElsewhere(input: ReceivedElsewhereInput): Promise<boolean> {
  const { accountId, broadcastId, contactId } = input
  if (!accountId || !broadcastId || !contactId) return false
  const since = windowStart(input.sinceMs)
  const base = [
    eq(broadcasts.accountId, accountId),
    ne(broadcasts.id, broadcastId),
    eq(broadcastRecipients.contactId, contactId),
    inArray(broadcastRecipients.status, SENT_RECIPIENT_STATUSES),
    gte(broadcastRecipients.sentAt, since),
    recipientWithoutOwnVarsSql(),
  ]

  if (input.messageKind === 'template') {
    const templateName = (input.templateName ?? '').trim()
    if (!templateName) return false
    const rows = await db
      .select({ params: broadcastRecipients.params, messageParams: broadcastRecipients.messageParams })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
      .where(
        and(
          ...base,
          eq(broadcasts.messageKind, 'template'),
          eq(broadcasts.templateName, templateName),
          eq(broadcasts.templateLanguage, (input.templateLanguage ?? '').trim()),
        ),
      )
      .limit(50)
    const key = templateSendKey(input)
    return rows.some((r) => templateSendKey(r) === key)
  }

  const bodyText = (input.bodyText ?? '').trim()
  const hasText = normalizeBroadcastText(bodyText) !== ''
  const subject = (input.subject ?? '').trim()
  const mediaNames = broadcastMediaNames(input)
  if (!hasText && !mediaNames.some((n) => !isGenericFilename(n))) return false

  const rows = await db
    .select({
      media: broadcasts.media,
      mediaUrl: broadcasts.mediaUrl,
      mediaFilename: broadcasts.mediaFilename,
    })
    .from(broadcastRecipients)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
    .where(
      and(
        ...base,
        ne(broadcasts.messageKind, 'template'),
        hasText
          ? sql`${normSql(broadcasts.bodyText)} = ${normSql(textParam(bodyText))}`
          : (or(isNotNull(broadcasts.media), isNotNull(broadcasts.mediaUrl)) as SQL),
        subject ? sql`${normSql(broadcasts.subject)} = ${normSql(textParam(subject))}` : undefined,
      ),
    )
    .limit(hasText ? 1 : 50)
  if (hasText) return rows.length > 0
  return rows.some((r) => sameAttachmentSet(broadcastMediaNames(r), mediaNames))
}

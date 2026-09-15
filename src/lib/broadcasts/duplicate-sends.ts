// ============================================================
// Quem JÁ recebeu esta mesma mensagem hoje — pra não mandar 2×.
//
// 15/09 (GoLink): o Vitor refez o "dia do cliente" 3 vezes (outro número,
// imagem subida de novo) e Flash Baterias, Piso Decor e Vidro e Cia
// receberam a mesma imagem 2×; outros já tinham recebido à mão.
//
// Duas fontes, uma consulta cada (inArray nos contatos, janela de 24 h):
//   (i)  broadcast_recipients que SAÍRAM (sent/delivered/read/replied) de
//        disparos de texto da conta com o mesmo conteúdo — texto normalizado
//        igual; sem texto no disparo novo, o mesmo conjunto de nomes de
//        arquivo (a URL muda a cada upload; o nome não). Template fica fora.
//   (ii) messages de agente/robô (não nota interna) nas conversas da conta
//        com o mesmo texto — pega o envio À MÃO e o de um disparo que foi
//        excluído (excluir apaga os destinatários, a mensagem fica). A
//        legenda de imagem conta (é o content_text do eco).
// A comparação de texto roda nos DOIS lados pela mesma expressão SQL, pra
// não depender do lower()/espaço do JS bater com o do Postgres.
//
// Worker-safe (sem 'server-only').
// ============================================================

import { and, eq, gte, inArray, isNotNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients, contacts, conversations, messages } from '@/db'
import { appendOptOutLine } from '@/lib/contacts/opt-out'

export interface DuplicateSkip {
  contactId: string
  name: string | null
  /** Quando recebeu a mesma mensagem (ISO). */
  lastSentAt: string
}

export interface BroadcastContentFingerprint {
  bodyText: string | null
  /** Nomes dos arquivos anexados (a URL muda a cada upload; o nome não). */
  mediaFilenames: string[]
  subject?: string | null
}

/** Janela padrão: 24 h. */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Status de destinatário que significam "a mensagem saiu". */
const SENT_STATUSES = ['sent', 'delivered', 'read', 'replied']

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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i])
}

/** Mesma normalização de `normalizeBroadcastText`, em SQL (os dois lados). */
function normSql(value: SQLWrapper): SQL {
  return sql`lower(btrim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`
}

function textParam(value: string): SQL {
  return sql`${value}::text`
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

/**
 * Contatos (dentre `contactIds`) que receberam a mesma mensagem nas últimas
 * 24 h (padrão) por qualquer canal da conta — disparo ou envio manual.
 * Lista vazia (ou mensagem sem texto e sem anexo) → [] sem consultar.
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
  const hasText = normalizeBroadcastText(bodyText) !== ''
  const mediaNames = normalizeFilenameSet(content.mediaFilenames ?? [])
  if (!hasText && mediaNames.length === 0) return []

  const windowMs = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : DUPLICATE_WINDOW_MS
  const since = new Date(Date.now() - windowMs).toISOString()

  const latest = new Map<string, { name: string | null; at: string }>()
  const note = (contactId: string | null, name: string | null, at: string | null) => {
    const iso = toIso(at)
    if (!contactId || !iso) return
    const prev = latest.get(contactId)
    if (!prev || Date.parse(iso) > Date.parse(prev.at)) latest.set(contactId, { name, at: iso })
  }

  // (i) Disparos da conta que já saíram pra essas pessoas com o mesmo conteúdo.
  // Com texto: o texto decide (no SQL). Sem texto: só os nomes dos anexos
  // (conferidos aqui — media é jsonb); o texto do disparo antigo não importa,
  // a pessoa já recebeu esses arquivos.
  const contentMatch = hasText
    ? sql`${normSql(broadcasts.bodyText)} = ${normSql(textParam(bodyText))}`
    : (or(isNotNull(broadcasts.media), isNotNull(broadcasts.mediaUrl)) as SQL)
  const recipientRows = await db
    .select({
      contactId: broadcastRecipients.contactId,
      name: contacts.name,
      sentAt: broadcastRecipients.sentAt,
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
        inArray(broadcastRecipients.status, SENT_STATUSES),
        gte(broadcastRecipients.sentAt, since),
        contentMatch,
      ),
    )
  for (const r of recipientRows) {
    if (!hasText && !sameSet(broadcastMediaNames(r), mediaNames)) continue
    note(r.contactId, r.name, r.sentAt)
  }

  // (ii) Mensagens de agente/robô com o mesmo texto (à mão, ou eco de um
  // disparo — com ou sem a linha "responda SAIR" que o worker anexa).
  if (hasText) {
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
    for (const r of messageRows) note(r.contactId, r.name, r.createdAt)
  }

  const out: DuplicateSkip[] = []
  for (const id of ids) {
    const hit = latest.get(id)
    if (hit) out.push({ contactId: id, name: hit.name, lastSentAt: hit.at })
  }
  return out
}

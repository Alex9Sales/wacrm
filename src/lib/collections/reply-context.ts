// ============================================================
// 🧾 O que o banco sabe em volta da resposta do devedor (16/09).
//
// A decisão é pura (reply-guard.ts); aqui só LEITURA: a rajada do cliente,
// quando saiu a última cobrança (nesta conversa e em qualquer outra), o que
// nós escrevemos antes, as parcelas abertas do contato e dos cadastros irmãos
// e o estado atual da régua. Antes o detector só perguntava "tem cobrança
// aberta?" — e classificava qualquer conversa do contato, em qualquer canal
// (Ultra Visão: recarga do Google Ads virou promessa, acordo e comprovante).
//
// Sem 'server-only' — roda no worker (auto-resposta e detector silencioso).
// ============================================================

import { and, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm'

import { db, asaasCharges, collectionsTouches, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'

import {
  alreadyApplied,
  collectionReplyRelevance,
  dayKeyIn,
  decideCollectionReply,
  otherPixWithin,
  pickBurst,
  DIRECT_MAX_OUTBOUND,
  DIRECT_WINDOW_MS,
  SPONTANEOUS_QUIET_MS,
  type BurstRow,
  type OurMessage,
  type Relevance,
  type ReplyDecision,
  type ReplyGuardContext,
  type TouchState,
} from './reply-guard'
import type { CollectionReplyKind } from './reply'

/** Últimas mensagens não internas da conversa, da mais nova para a mais velha. */
export async function loadBurstRows(conversationId: string): Promise<BurstRow[]> {
  const rows = await db
    .select({
      id: messages.id,
      senderType: messages.senderType,
      contentText: messages.contentText,
      transcription: messages.transcription,
      contentType: messages.contentType,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.isInternal, false)))
    .orderBy(desc(messages.createdAt))
    .limit(8)
  return rows
}

export interface OpenChargeRow {
  id: string
  contactId: string | null
  value: number
  interestValue: number | null
  invoiceUrl: string | null
}

/**
 * Parcelas abertas do contato e dos cadastros IRMÃOS (mesma conexão e mesmo
 * cliente do Asaas em outro contato). Ultra Visão: 92d1d99e (WhatsApp) e
 * 1ff2003d (só e-mail) são o mesmo cus_. Nesta entrega os irmãos só entram na
 * CONTA (valor do comprovante, "exatamente 1 parcela" para mover vencimento):
 * pausa e adiamento continuam por contato, porque "Retomar" é por contato.
 */
export async function loadOpenChargesWithSiblings(accountId: string, contactId: string): Promise<OpenChargeRow[]> {
  const rows = await db
    .select({
      id: asaasCharges.id,
      contactId: asaasCharges.contactId,
      value: asaasCharges.value,
      interestValue: asaasCharges.interestValue,
      invoiceUrl: asaasCharges.invoiceUrl,
    })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.open, true),
        or(
          eq(asaasCharges.contactId, contactId),
          // Subquery com apelido literal: coluna interpolada dentro de SELECT
          // raw sai sem tabela e seria capturada pela tabela de dentro.
          sql`(${asaasCharges.connectionId}, ${asaasCharges.asaasCustomerId}) IN (SELECT "sib"."connection_id", "sib"."asaas_customer_id" FROM "asaas_charges" AS "sib" WHERE "sib"."account_id" = ${accountId} AND "sib"."contact_id" = ${contactId} AND "sib"."asaas_customer_id" IS NOT NULL)`,
        ),
      ),
    )
    .limit(50)
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    value: Number(r.value ?? 0),
    interestValue: r.interestValue == null ? null : Number(r.interestValue),
    invoiceUrl: r.invoiceUrl,
  }))
}

export interface ReplyGuardData extends ReplyGuardContext {
  /** Nós mandamos Pix que não é do Asaas nas 24 h antes da rajada. */
  otherPixLast24h: boolean
  touch: TouchState | null
}

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Quantas mensagens nossas lemos para trás: basta passar do limite do "direct". */
const OURS_LIMIT = Math.max(12, DIRECT_MAX_OUTBOUND + 2)

/**
 * Tudo antes do balão MAIS NOVO da rajada (`newestAt`). Mensagem nossa = não
 * interna, escrita pelo time ou pelo CRM, que não falhou. Cobrança = mensagem
 * nossa com link do Asaas (conferido: as 119 cobranças enviadas desde 09/09
 * têm o link asaas.com/i na conversa) ou com o link de uma parcela aberta.
 */
export async function loadReplyGuardContext(args: {
  accountId: string
  conversationId: string
  contactId: string
  newestAt: Date
  typed: string
  media: string
}): Promise<ReplyGuardData> {
  const newestIso = args.newestAt.toISOString()
  const sinceIso = new Date(args.newestAt.getTime() - DIRECT_WINDOW_MS).toISOString()
  const charges = await loadOpenChargesWithSiblings(args.accountId, args.contactId)
  const urls = [...new Set(charges.map((c) => c.invoiceUrl).filter((u): u is string => !!u))].slice(0, 20)

  const ours = () =>
    and(eq(messages.isInternal, false), inArray(messages.senderType, ['agent', 'bot']), ne(messages.status, 'failed'))

  const [collectRows, recentRows, touch] = await Promise.all([
    db
      .select({ at: messages.createdAt, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.accountId, args.accountId),
          eq(conversations.contactId, args.contactId),
          ours(),
          gte(messages.createdAt, sinceIso),
          lt(messages.createdAt, newestIso),
          or(
            sql`${messages.contentText} ~* 'asaas\\.com/(i|b)/'`,
            ...urls.map((u) => sql`position(${u} in ${messages.contentText}) > 0`),
          ),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(30),
    db
      .select({ at: messages.createdAt, text: messages.contentText })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, args.conversationId),
          ours(),
          gte(messages.createdAt, sinceIso),
          lt(messages.createdAt, newestIso),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(OURS_LIMIT),
    db
      .select({
        snoozeUntil: collectionsTouches.snoozeUntil,
        snoozeReason: collectionsTouches.snoozeReason,
        paused: collectionsTouches.paused,
        pausedSource: collectionsTouches.pausedSource,
        pausedReason: collectionsTouches.pausedReason,
        updatedAt: collectionsTouches.updatedAt,
      })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, args.accountId), eq(collectionsTouches.contactId, args.contactId)))
      .limit(1)
      .then(firstOrNull),
  ])

  const anyCollectAt = toDate(collectRows[0]?.at)
  const sameConvCollectAt = toDate(collectRows.find((r) => r.conversationId === args.conversationId)?.at)
  const ourRecent: OurMessage[] = []
  for (const r of recentRows) {
    const at = toDate(r.at)
    if (at) ourRecent.push({ at, text: r.text ?? '' })
  }
  const t = args.newestAt.getTime()
  // Contagens a partir das últimas OURS_LIMIT mensagens: só importa "até 5" e
  // "nenhuma em 72 h", e o teto passa dos dois.
  const outboundSinceCollect = sameConvCollectAt ? ourRecent.filter((m) => m.at.getTime() > sameConvCollectAt.getTime()).length : 0
  const outboundLast72h = ourRecent.filter((m) => t - m.at.getTime() <= SPONTANEOUS_QUIET_MS).length

  return {
    newestAt: args.newestAt,
    typed: args.typed,
    media: args.media,
    sameConvCollectAt,
    outboundSinceCollect,
    anyCollectAt,
    outboundLast72h,
    ourRecent,
    openCharges: charges.map((c) => ({ value: c.value, interestValue: c.interestValue })),
    otherPixLast24h: otherPixWithin(ourRecent, args.newestAt),
    touch: touch ?? null,
  }
}

export interface CollectionMarkerCheck {
  decision: ReplyDecision
  relevance: Relevance | null
}

/**
 * Marcador [[COBRANCA:]] da IA que conversa: passa pelas mesmas travas do
 * detector silencioso. Chamar ANTES de enviar a resposta — depois do envio a
 * última mensagem da conversa é a nossa e a rajada do cliente some da leitura.
 * Efeito que já está na régua vira 'skip' (sem nota repetida).
 */
export async function evaluateCollectionMarker(args: {
  accountId: string
  conversationId: string
  contactId: string
  kind: CollectionReplyKind
  date: string | null
  timezone: string
}): Promise<CollectionMarkerCheck> {
  const burst = pickBurst(await loadBurstRows(args.conversationId))
  if (!burst) return { decision: { action: 'skip', reason: 'sem mensagem do cliente para conferir' }, relevance: null }
  const ctx = await loadReplyGuardContext({
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    newestAt: burst.newestAt,
    typed: burst.typed,
    media: burst.media,
  })
  const relevance = collectionReplyRelevance(ctx)
  const decision = decideCollectionReply({
    kind: args.kind,
    date: args.date,
    // A IA que conversa leu a conversa inteira e decidiu que é sobre a dívida.
    aboutDebt: true,
    relevance,
    typed: burst.typed,
    media: burst.media,
    openCharges: ctx.openCharges,
    otherPixLast24h: ctx.otherPixLast24h,
    todayKey: dayKeyIn(args.timezone),
  })
  if (decision.action === 'apply' && alreadyApplied(ctx.touch, decision.kind, decision.date)) {
    return { decision: { action: 'skip', reason: 'mesmo efeito já aplicado' }, relevance }
  }
  return { decision, relevance }
}

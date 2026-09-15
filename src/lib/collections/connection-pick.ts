// ============================================================
// 🧾 Qual conta do Asaas recebe a cobrança — uma regra só (15/09).
//
// Caso GoLink: duas contas do Asaas (dois CNPJs). A IA e o comando do dono
// sempre caíam na conexão mais antiga ('Asaas', 33 s mais velha), e a tela
// abria com ela escolhida — cliente da 'AsaasGoLink' ganhava um SEGUNDO
// cadastro na outra conta e o dinheiro caía no CNPJ errado.
//
// Regra: a conta segue o cliente.
//   pedida (tela) > a da última cobrança do cliente, se ligada > a única >
//   a 1ª por createdAt (o padrão de antes).
// E, quando o cliente não existe na conta escolhida mas existe noutra
// (decideCustomerHome): escolhida por gente → recusa; ninguém escolheu
// (IA/dono) → troca e diz; em 2+ contas → falha com motivo.
//
// Parte pura (decideConnection, decideCustomerHome) + a leitura do histórico.
// Sem 'server-only' — roda no worker (IA e comando do dono).
// ============================================================

import { and, eq, or, sql } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections } from '@/db'

import { onlyDigits } from './document'

export interface ConnectionLite {
  id: string
  label: string
  environment: string
  /** ISO — desempate do padrão ("a 1ª conectada"). */
  createdAt: string
}

/** Uma linha por conexão onde o cliente tem cobrança (pelo contato ou pelo documento). */
export interface ConnectionHistoryRow {
  connectionId: string
  label: string
  enabled: boolean
  environment: string
  charges: number
  /** YYYY-MM-DD da cobrança mais recente (data no Asaas, vencimento ou a nossa linha). */
  lastAt: string | null
}

export type ConnectionSource = 'requested' | 'history' | 'only' | 'default' | 'none'

export interface ConnectionDecision<C extends ConnectionLite = ConnectionLite> {
  conn: C | null
  source: ConnectionSource
  /** Contas onde o cliente tem cobrança, da mais recente para a mais antiga. */
  historyLabels: string[]
  /** O histórico do cliente só está numa conta DESLIGADA (a tela avisa). */
  disabledHomeLabel?: string
}

/** Mais recente primeiro; empate de data → a com mais cobranças. */
export function sortHistory<T extends Pick<ConnectionHistoryRow, 'lastAt' | 'charges'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const la = a.lastAt ?? ''
    const lb = b.lastAt ?? ''
    if (la !== lb) return la < lb ? 1 : -1
    return (b.charges ?? 0) - (a.charges ?? 0)
  })
}

/**
 * Decide a conexão. `enabled` = só as LIGADAS da conta. Pedida e desligada (ou
 * de outra conta) → none: quem pediu uma conta específica não pode cair noutra
 * em silêncio.
 */
export function decideConnection<C extends ConnectionLite>(input: {
  enabled: readonly C[]
  history: readonly ConnectionHistoryRow[]
  requestedId?: string | null
}): ConnectionDecision<C> {
  const history = sortHistory(input.history)
  const enabledIds = new Set(input.enabled.map((c) => c.id))
  const historyLabels = [...new Set(history.map((h) => h.label))]
  // Com conta de produção ligada, histórico de TESTE (sandbox) não decide a
  // conta de uma cobrança real (revisão 15/09).
  const hasProduction = input.enabled.some((c) => c.environment !== 'sandbox')
  const homeEnabled = history.find((h) => enabledIds.has(h.connectionId) && (!hasProduction || h.environment !== 'sandbox'))
  const disabledHomeLabel = !homeEnabled && history.length ? history[0].label : undefined
  const base = { historyLabels, ...(disabledHomeLabel ? { disabledHomeLabel } : {}) }

  if (input.requestedId) {
    const conn = input.enabled.find((c) => c.id === input.requestedId) ?? null
    return { conn, source: conn ? 'requested' : 'none', ...base }
  }
  if (!input.enabled.length) return { conn: null, source: 'none', ...base }
  if (input.enabled.length === 1) return { conn: input.enabled[0], source: 'only', ...base }
  if (homeEnabled) {
    const conn = input.enabled.find((c) => c.id === homeEnabled.connectionId) ?? null
    if (conn) return { conn, source: 'history', ...base }
  }
  const first = [...input.enabled].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0]
  return { conn: first, source: 'default', ...base }
}

export interface HomeCandidate {
  id: string
  label: string
  /** Do histórico local (ordena "a mais recente"); ausente quando veio da consulta ao Asaas. */
  lastAt?: string | null
  charges?: number
}

export type CustomerHomeDecision =
  | 'create'
  | { refuse: { id: string; label: string } }
  | { switch: { id: string; label: string } }
  | { ambiguous: string[] }

/**
 * O cliente NÃO existe na conta escolhida; `candidates` = outras contas ligadas
 * (mesmo ambiente) onde ele existe.
 *   0 → cria na escolhida · escolhida por gente → recusa apontando a mais
 *   recente · ninguém escolheu e 1 → troca · ninguém escolheu e 2+ → ambíguo.
 */
export function decideCustomerHome(input: { explicit: boolean; candidates: readonly HomeCandidate[] }): CustomerHomeDecision {
  const unique = [...new Map(input.candidates.map((c) => [c.id, c])).values()]
  if (!unique.length) return 'create'
  const ordered = sortHistory(unique.map((c) => ({ ...c, lastAt: c.lastAt ?? null, charges: c.charges ?? 0 })))
  const pick = (c: HomeCandidate) => ({ id: c.id, label: c.label })
  if (input.explicit) return { refuse: pick(ordered[0]) }
  if (ordered.length === 1) return { switch: pick(ordered[0]) }
  return { ambiguous: ordered.map((c) => c.label) }
}

/**
 * Onde o cliente já tem cobrança: por contact_id OU pelo CPF/CNPJ (cliente que
 * paga numa conta e foi casado com outro contato continua achável). Só banco.
 */
export async function connectionHistoryFor(
  accountId: string,
  contactId: string | null,
  docs: readonly (string | null | undefined)[] = [],
): Promise<ConnectionHistoryRow[]> {
  const docList = [...new Set(docs.map((d) => onlyDigits(d)).filter((d) => d.length === 11 || d.length === 14))]
  const who = [
    ...(contactId ? [eq(asaasCharges.contactId, contactId)] : []),
    // Coluna QUALIFICADA à mão e lista com sql.join (gotchas do Drizzle).
    ...(docList.length
      ? [sql`regexp_replace(coalesce("asaas_charges"."cpf_cnpj", ''), '\\D', '', 'g') IN (${sql.join(docList.map((d) => sql`${d}`), sql`, `)})`]
      : []),
  ]
  if (!who.length) return []
  // Cobrança criada pelo CRM não grava asaas_created_at: sem o CASE ela entraria
  // pelo VENCIMENTO (data futura) e passaria na frente de cobrança mais nova.
  const lastAt = sql<string | null>`max(CASE WHEN "asaas_charges"."origin" IN ('ai', 'manual') THEN ("asaas_charges"."created_at")::date ELSE COALESCE("asaas_charges"."asaas_created_at", "asaas_charges"."due_date", ("asaas_charges"."created_at")::date) END)::text`
  const charges = sql<number>`count(*)::int`
  const rows = await db
    .select({
      connectionId: asaasConnections.id,
      label: asaasConnections.label,
      enabled: asaasConnections.enabled,
      environment: asaasConnections.environment,
      charges,
      lastAt,
    })
    .from(asaasCharges)
    .innerJoin(asaasConnections, eq(asaasConnections.id, asaasCharges.connectionId))
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasConnections.accountId, accountId), or(...who)))
    .groupBy(asaasConnections.id, asaasConnections.label, asaasConnections.enabled, asaasConnections.environment)
  return sortHistory(rows.map((r) => ({ ...r, charges: Number(r.charges ?? 0), lastAt: r.lastAt ? String(r.lastAt).slice(0, 10) : null })))
}

/** Quantas contas do Asaas estão ligadas (o texto ao dono só mostra a conta com 2+). */
export async function countEnabledConnections(accountId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))
  return Number(rows[0]?.n ?? 0)
}

/** Conexões LIGADAS da conta, da mais antiga para a mais nova (inclui a chave criptografada — só servidor). */
export async function enabledConnectionsOf(accountId: string): Promise<(typeof asaasConnections.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))
    .orderBy(asaasConnections.createdAt)
  return rows
}

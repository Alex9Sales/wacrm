// ============================================================
// 🧾 Régua de cobrança — o LAÇO (Fase 2).
//
// A cada ciclo: reconsulta o Asaas, monta UMA mensagem por devedor com todas
// as parcelas em aberto DELE naquele instante, e põe na fila "Precisa de você".
// É a reconsulta que faz três parcelas virarem duas quando o cliente paga uma —
// a lista nunca é congelada.
//
// Nesta fase tudo passa pela aprovação (a ação nasce em 'approve' no catálogo):
// o cliente vê as quarenta antes de saírem. Soltar o automático é a Fase 5, e
// depende da Fase 4 (parar de cobrar quem pagou) estar fechada.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq, gte, sql } from 'drizzle-orm'

import { db, agentActionRequests, aiConfigs, asaasCharges, asaasConnections, collectionsTouches, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { decide, readPolicy, type AutonomyPolicy } from '@/lib/orchestration/policy'
import { syncAccount } from '@/lib/asaas/sync'

import {
  eligibility,
  fallbackMessage,
  formatDebtSummary,
  normalizeSettings,
  withinWindow,
  type ChargeLine,
  type CollectionsSettings,
  type SkipReason,
} from './rules'

export interface CollectionsRunStats {
  /** Devedores com algo em aberto nesta rodada. */
  debtors: number
  /** Cobranças propostas (foram para a fila). */
  queued: number
  /** Devedores pulados, por motivo — sempre explicável. */
  skipped: Partial<Record<SkipReason, number>>
  /** Por que a rodada inteira não fez nada, quando for o caso. */
  haltedBecause?: string
}

/** Não bate no Asaas a cada tique: uma sincronização por hora basta. */
const SYNC_STALE_MS = 60 * 60_000

export function readCollectionsSettings(raw: unknown): CollectionsSettings {
  const bag = (raw ?? {}) as { collections?: unknown }
  return normalizeSettings(bag.collections)
}

function localParts(tz: string): { hour: number; weekday: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false, weekday: 'short' })
    const parts = fmt.formatToParts(new Date())
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10)
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? ''
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    return { hour: Number.isFinite(hour) ? hour % 24 : -1, weekday: map[wd] ?? -1 }
  } catch {
    return { hour: -1, weekday: -1 }
  }
}

export async function runCollectionsForAccount(accountId: string): Promise<CollectionsRunStats> {
  const stats: CollectionsRunStats = { debtors: 0, queued: 0, skipped: {} }
  const bump = (r: SkipReason) => {
    stats.skipped[r] = (stats.skipped[r] ?? 0) + 1
  }

  const accountSettings = await getAccountSettings(accountId)
  const s = normalizeSettings(accountSettings.collections)
  if (!s.enabled) return { ...stats, haltedBecause: 'A régua de cobrança está desligada nesta conta.' }

  const tz = accountSettings.businessTimezone || 'America/Sao_Paulo'
  const { hour, weekday } = localParts(tz)
  if (!withinWindow(hour, weekday, s)) {
    return { ...stats, haltedBecause: `Fora da janela de cobrança (${s.startHour}h–${s.endHour}h${s.weekdaysOnly ? ', dias úteis' : ''}).` }
  }

  // 1) Reconsultar o Asaas. Sem isso a régua cobraria de uma lista velha, que é
  //    exatamente como se cobra quem já pagou.
  const stale = firstOrNull(
    await db
      .select({ lastSyncAt: asaasConnections.lastSyncAt })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))
      .orderBy(desc(asaasConnections.lastSyncAt))
      .limit(1),
  )
  if (!stale) return { ...stats, haltedBecause: 'Nenhuma conta do Asaas conectada.' }
  const lastSync = stale.lastSyncAt ? new Date(stale.lastSyncAt).getTime() : 0
  if (Date.now() - lastSync > SYNC_STALE_MS) {
    const r = await syncAccount(accountId, s.overdueStatuses)
    if (!r.ok) return { ...stats, haltedBecause: `Não deu para ler o Asaas agora: ${r.error ?? 'falha'}` }
  }

  // 2) A carteira em aberto, já com o contato e o estado da régua.
  const rows = await db
    .select({
      contactId: asaasCharges.contactId,
      contactName: contacts.name,
      optedOut: contacts.optedOut,
      value: asaasCharges.value,
      dueDate: asaasCharges.dueDate,
      invoiceUrl: asaasCharges.invoiceUrl,
      connectionLabel: asaasConnections.label,
      lastTouchAt: collectionsTouches.lastTouchAt,
      touchCount: collectionsTouches.touchCount,
      snoozeUntil: collectionsTouches.snoozeUntil,
      paused: collectionsTouches.paused,
    })
    .from(asaasCharges)
    .innerJoin(asaasConnections, eq(asaasConnections.id, asaasCharges.connectionId))
    .innerJoin(contacts, eq(contacts.id, asaasCharges.contactId))
    .leftJoin(
      collectionsTouches,
      and(eq(collectionsTouches.accountId, asaasCharges.accountId), eq(collectionsTouches.contactId, asaasCharges.contactId)),
    )
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true)))

  // Cobranças sem contato casado nunca chegam aqui (o innerJoin corta), mas
  // elas existem e o time precisa saber — a tela /cobrancas mostra como
  // pendência. Contamos aqui só para o número da rodada bater.
  const orphans = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), sql`${asaasCharges.contactId} IS NULL`)),
  )
  if (orphans?.n) stats.skipped.no_contact = orphans.n

  interface Debtor {
    contactId: string
    name: string | null
    optedOut: boolean
    charges: ChargeLine[]
    lastTouchAt: string | null
    touchCount: number
    snoozeUntil: string | null
    paused: boolean
  }

  const byContact = new Map<string, Debtor>()
  const today = new Date()
  for (const r of rows) {
    if (!r.contactId) continue
    let d = byContact.get(r.contactId)
    if (!d) {
      d = {
        contactId: r.contactId,
        name: r.contactName,
        optedOut: r.optedOut,
        charges: [],
        lastTouchAt: r.lastTouchAt,
        touchCount: r.touchCount ?? 0,
        snoozeUntil: r.snoozeUntil,
        paused: r.paused ?? false,
      }
      byContact.set(r.contactId, d)
    }
    const late = r.dueDate ? Math.round((today.getTime() - new Date(`${r.dueDate}T00:00:00`).getTime()) / 86_400_000) : null
    d.charges.push({
      value: Number(r.value ?? 0),
      dueDate: r.dueDate,
      daysLate: late,
      connectionLabel: r.connectionLabel,
      invoiceUrl: r.invoiceUrl,
    })
  }
  stats.debtors = byContact.size

  // 3) Teto do dia + quem já está na fila (não empilhamos dois pedidos para a
  //    mesma pessoa: a fila viraria ruído e o cliente cobraria em dobro).
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const recent = await db
    .select({ contactId: agentActionRequests.contactId, status: agentActionRequests.status })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        gte(agentActionRequests.createdAt, dayAgo),
      ),
    )
  const alreadyQueued = new Set(recent.filter((r) => r.status === 'pending').map((r) => r.contactId))
  const usedToday = recent.filter((r) => r.status === 'sent').length
  let budget = Math.max(0, s.dailyCap - usedToday)
  if (budget === 0) return { ...stats, haltedBecause: `Teto de ${s.dailyCap} cobranças por dia já foi atingido.` }

  // 4) Política do agente (a mesma da orquestração — a cobrança não tem
  //    governança paralela).
  const agent = firstOrNull(
    await db
      .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
  const policy: AutonomyPolicy = readPolicy(agent?.autonomy ?? null)

  // Do mais atrasado para o menos: se o teto cortar, corta o que espera menos.
  const ordered = [...byContact.values()].sort(
    (a, b) => Math.max(...b.charges.map((c) => c.daysLate ?? -1)) - Math.max(...a.charges.map((c) => c.daysLate ?? -1)),
  )

  for (const d of ordered) {
    if (budget <= 0) break
    if (alreadyQueued.has(d.contactId)) {
      bump('too_soon')
      continue
    }

    const maxLate = Math.max(...d.charges.map((c) => c.daysLate ?? -1))
    const reason = eligibility(
      {
        contactId: d.contactId,
        optedOut: d.optedOut,
        maxDaysLate: Number.isFinite(maxLate) ? maxLate : null,
        state: { lastTouchAt: d.lastTouchAt, touchCount: d.touchCount, snoozeUntil: d.snoozeUntil, paused: d.paused },
      },
      s,
    )
    if (reason !== 'ok') {
      bump(reason)
      continue
    }

    const summary = formatDebtSummary(d.charges)
    const firstName = (d.name ?? '').trim().split(/\s+/)[0] || null
    const text = await draftCollectionMessage({
      accountId,
      agentId: agent?.id ?? null,
      firstName,
      summary,
      touch: d.touchCount,
      tone: s.tone,
    })

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, aiOff: conversations.aiAutoreplyDisabled })
        .from(conversations)
        .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, d.contactId)))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1),
    )

    const decision = decide({
      action: 'collect_charges',
      policy,
      accountPaused: accountSettings.autonomyPaused === true,
      accountMode: accountSettings.aiMode ?? 'on',
      withinHours: true, // a janela da régua já foi conferida no início da rodada
      optedOut: d.optedOut,
      humanActiveRecently: false,
      aiDisabledInConversation: conv?.aiOff === true,
      usedToday,
      messagesToday: usedToday,
      usedForDealToday: 0,
    })

    if (decision.decision === 'blocked') {
      bump('paused')
      continue
    }

    await db.insert(agentActionRequests).values({
      accountId,
      agentId: agent?.id ?? null,
      contactId: d.contactId,
      dealId: null,
      conversationId: conv?.id ?? null,
      actionType: 'collect_charges',
      payload: {
        total: summary.total,
        lines: summary.lines,
        links: summary.links,
        charges: d.charges.length,
        touch: d.touchCount + 1,
        maxDaysLate: maxLate,
      },
      suggestedText: text,
      reason:
        d.charges.length === 1
          ? `1 parcela vencida há ${maxLate} ${maxLate === 1 ? 'dia' : 'dias'}.`
          : `${d.charges.length} parcelas vencidas, a mais antiga há ${maxLate} ${maxLate === 1 ? 'dia' : 'dias'}.`,
      decision: decision.decision === 'auto_execute' ? 'auto' : decision.decision === 'request_approval' ? 'approve' : 'suggest',
      policy: decision.reason,
      status: 'pending',
    })

    stats.queued += 1
    budget -= 1
  }

  return stats
}

/**
 * A IA escreve o texto ao redor dos números — mas os números vêm prontos do
 * `formatDebtSummary`, e a instrução proíbe inventar valor, prazo ou desconto.
 * Somar é o tipo de coisa que um modelo erra sem ninguém perceber.
 */
async function draftCollectionMessage(args: {
  accountId: string
  agentId: string | null
  firstName: string | null
  summary: ReturnType<typeof formatDebtSummary>
  touch: number
  tone: string
}): Promise<string> {
  const fallback = fallbackMessage(args.firstName, args.summary, args.touch)
  if (!args.agentId) return fallback

  try {
    const config = await loadAiConfigById(args.accountId, args.agentId, { requireActive: false })
    if (!config) return fallback

    const system = [
      'Você escreve uma cobrança educada no WhatsApp, em português do Brasil. UMA mensagem curta (até 500 caracteres), sem markdown, sem assinatura, no máximo 1 emoji.',
      args.firstName ? `Cliente: ${args.firstName}. Use só o primeiro nome.` : 'Não sabemos o nome do cliente.',
      `Valores em aberto (copie exatamente, NUNCA recalcule nem arredonde):\n${args.summary.lines.map((l) => `- ${l}`).join('\n')}`,
      args.summary.lines.length > 1
        ? `Total: ${args.summary.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`
        : '',
      args.summary.links.length === 1 ? `Inclua este link de pagamento no final: ${args.summary.links[0]}` : '',
      args.touch === 0
        ? 'É o PRIMEIRO contato sobre isso: tom de lembrete, leve, sem cobrança dura.'
        : `Já são ${args.touch + 1} contatos sobre a mesma dívida: continue educado e sem repetir a mensagem anterior, mas seja mais direto.`,
      'NUNCA ameace, nunca fale em protesto, negativação, juros, multa, corte de serviço ou consequência jurídica. Nunca ofereça desconto, parcelamento ou prazo — se o cliente pedir, quem decide é uma pessoa.',
      'Termine convidando o cliente a responder ali mesmo se já pagou ou se quiser combinar uma data — a resposta dele é o que pausa a cobrança.',
      args.tone ? `Tom da empresa: ${args.tone}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const r = await generateReply({
      config,
      systemPrompt: system,
      messages: [{ role: 'user', content: 'Escreva a mensagem agora.' }] as unknown as Parameters<typeof generateReply>[0]['messages'],
    })
    const out = (r?.text ?? '').trim()
    return out.length >= 20 ? out : fallback
  } catch {
    return fallback
  }
}

/** Contas com régua ligada e ao menos uma conexão Asaas (para o tique do worker). */
export async function accountsWithCollections(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: asaasConnections.accountId })
    .from(asaasConnections)
    .where(eq(asaasConnections.enabled, true))
  return rows.map((r) => r.accountId)
}

// ============================================================
// 🔔 Lembrete ANTES de vencer (lacuna 2, 07/09).
//
// A régua só agia em cobrança VENCIDA. Com `reminderDaysBefore > 0`, a rodada
// também olha o que vence nos próximos N dias e propõe um aviso leve — "vence
// quinta, tá aí o link" — pela mesma fila e política da cobrança. Nada entra na
// carteira (que continua sendo a de vencidas): a lista vem do Asaas na hora e
// o executor reconfere no Asaas, cobrança por cobrança, antes de enviar.
// Um lembrete por parcela; quem já tem parcela vencida não recebe lembrete —
// recebe a cobrança.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, gte, inArray, sql } from 'drizzle-orm'

import { db, agentActionRequests, aiConfigs, asaasCharges, asaasConnections, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { fetchCustomers, getPayment, listPendingDueBetween, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { findContact } from '@/lib/asaas/sync'
import { decide, type AutonomyPolicy } from '@/lib/orchestration/policy'
import type { AccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'

import { resolveCollectionTargets } from './outreach'
import { fallbackReminderMessage, formatUpcomingSummary, greetingName, linksInstruction, type CollectionsSettings, type UpcomingLine } from './rules'
import { seedFrom, tooSimilar } from './variation'

export interface ReminderRunResult {
  queued: number
  /** Parcelas a vencer encontradas no Asaas na janela. */
  found: number
  skipped: Partial<Record<'no_contact' | 'opted_out' | 'has_overdue' | 'already' | 'no_channel' | 'paused' | 'budget', number>>
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export async function queueUpcomingReminders(args: {
  accountId: string
  settings: CollectionsSettings
  accountSettings: AccountSettings
  policy: AutonomyPolicy
  agentId: string | null
  /** Quantas ainda cabem no teto do dia. */
  budget: number
  /** Contatos que já têm pedido pendente nesta rodada. */
  alreadyQueued: Set<string>
  usedToday: number
  moment: string
  dayKey: string
}): Promise<ReminderRunResult> {
  const out: ReminderRunResult = { queued: 0, found: 0, skipped: {} }
  const bump = (k: keyof ReminderRunResult['skipped']) => {
    out.skipped[k] = (out.skipped[k] ?? 0) + 1
  }
  const s = args.settings
  if (s.reminderDaysBefore <= 0 || args.budget <= 0) return out

  const conns = await db
    .select({ id: asaasConnections.id, label: asaasConnections.label, apiKeyEnc: asaasConnections.apiKeyEnc, environment: asaasConnections.environment })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, args.accountId), eq(asaasConnections.enabled, true)))
  if (!conns.length) return out

  const today = new Date()
  const from = isoDay(today)
  const until = isoDay(new Date(today.getTime() + s.reminderDaysBefore * 86_400_000))

  interface Candidate {
    contactId: string
    name: string | null
    optedOut: boolean
    connectionId: string
    lines: UpcomingLine[]
    asaasIds: string[]
  }
  const byContact = new Map<string, Candidate>()

  for (const c of conns) {
    let cred: AsaasCredential
    try {
      cred = { apiKey: decrypt(c.apiKeyEnc), environment: c.environment as AsaasEnv }
    } catch {
      continue
    }
    let payments
    try {
      payments = await listPendingDueBetween(cred, from, until)
    } catch (err) {
      console.warn(`[lembrete] ${c.label}: não deu para listar a vencer — ${err instanceof Error ? err.message : err}`)
      continue
    }
    out.found += payments.length
    if (!payments.length) continue
    const customers = await fetchCustomers(cred, payments.map((p) => p.customer)).catch(() => new Map())
    for (const p of payments) {
      const cust = customers.get(p.customer)
      const decision = await findContact(args.accountId, cust?.mobilePhone || cust?.phone || null, cust?.email ?? null, cust?.cpfCnpj ?? null)
      if (!decision.contactId) {
        bump('no_contact')
        continue
      }
      const due = p.dueDate ? new Date(`${p.dueDate.slice(0, 10)}T00:00:00Z`) : null
      const daysUntil = due ? Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - due.getTime()) / -86_400_000) : null
      let cand = byContact.get(decision.contactId)
      if (!cand) {
        cand = { contactId: decision.contactId, name: cust?.name ?? null, optedOut: false, connectionId: c.id, lines: [], asaasIds: [] }
        byContact.set(decision.contactId, cand)
      }
      cand.lines.push({ value: Number(p.value ?? 0), dueDate: p.dueDate ? p.dueDate.slice(0, 10) : null, daysUntil, connectionLabel: c.label, invoiceUrl: p.invoiceUrl ?? null })
      cand.asaasIds.push(p.id)
    }
  }
  if (!byContact.size) return out

  const ids = [...byContact.keys()]
  // Quem já está devendo (parcela vencida na carteira) recebe cobrança, não lembrete.
  const overdue = await db
    .selectDistinct({ contactId: asaasCharges.contactId })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, args.accountId), eq(asaasCharges.open, true), inArray(asaasCharges.contactId, ids)))
  const hasOverdue = new Set(overdue.map((r) => r.contactId).filter((x): x is string => !!x))

  const contactRows = await db
    .select({ id: contacts.id, name: contacts.name, optedOut: contacts.optedOut })
    .from(contacts)
    .where(and(eq(contacts.accountId, args.accountId), inArray(contacts.id, ids)))
  const contactById = new Map(contactRows.map((r) => [r.id, r]))

  // Um lembrete por parcela: o que já foi lembrado nos últimos 45 dias não repete.
  // Expirado (envelheceu na fila, stale.ts) ou falho NÃO conta como lembrado —
  // senão a parcela ficaria sem aviso nenhum.
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString()
  const previous = await db
    .select({ payload: agentActionRequests.payload })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, args.accountId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        gte(agentActionRequests.createdAt, since),
        sql`${agentActionRequests.payload}->>'kind' = 'reminder'`,
        sql`${agentActionRequests.status} NOT IN ('expired', 'failed')`,
      ),
    )
  const reminded = new Set<string>()
  for (const r of previous) {
    const list = (r.payload as { asaasIds?: unknown } | null)?.asaasIds
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') reminded.add(id)
  }

  let budget = args.budget
  let usedToday = args.usedToday
  for (const cand of byContact.values()) {
    if (budget <= 0) {
      bump('budget')
      break
    }
    const contact = contactById.get(cand.contactId)
    if (!contact) {
      bump('no_contact')
      continue
    }
    if (contact.optedOut) {
      bump('opted_out')
      continue
    }
    if (hasOverdue.has(cand.contactId) || args.alreadyQueued.has(cand.contactId)) {
      bump('has_overdue')
      continue
    }
    const fresh = cand.asaasIds.map((id, i) => ({ id, line: cand.lines[i] })).filter((x) => !reminded.has(x.id))
    if (!fresh.length) {
      bump('already')
      continue
    }
    const delivery = await resolveCollectionTargets(args.accountId, cand.contactId, null, { dryRun: true })
    if (!delivery.ok) {
      bump('no_channel')
      continue
    }

    const summary = formatUpcomingSummary(
      fresh.map((x) => x.line),
      { showValues: s.showValues },
    )
    // Nome como está no Asaas prevalece (10/09); o contato só cobre o vazio.
    const fullName = (cand.name ?? '').trim() || contact.name || null
    const firstName = greetingName(fullName)
    const seed = seedFrom(cand.contactId, 0, args.dayKey)
    const text = await draftReminder({
      accountId: args.accountId,
      agentId: args.agentId,
      firstName,
      fullName,
      summary,
      tone: s.tone,
      seed,
      moment: args.moment,
      offerDate: s.offerDateNegotiation,
    })

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, aiOff: conversations.aiAutoreplyDisabled })
        .from(conversations)
        .where(and(eq(conversations.accountId, args.accountId), eq(conversations.contactId, cand.contactId)))
        .limit(1),
    )
    const decision = decide({
      action: 'collect_charges',
      policy: args.policy,
      accountPaused: args.accountSettings.autonomyPaused === true,
      accountMode: args.accountSettings.aiMode ?? 'on',
      withinHours: true,
      optedOut: false,
      humanActiveRecently: false,
      aiDisabledInConversation: s.autoSend ? false : conv?.aiOff === true,
      usedToday,
      messagesToday: usedToday,
      usedForDealToday: 0,
    })
    if (decision.decision === 'blocked') {
      bump('paused')
      continue
    }

    const dueIn = summary.minDays ?? s.reminderDaysBefore
    await db.insert(agentActionRequests).values({
      accountId: args.accountId,
      agentId: args.agentId,
      contactId: cand.contactId,
      dealId: null,
      conversationId: conv?.id ?? null,
      actionType: 'collect_charges',
      payload: {
        kind: 'reminder',
        connectionId: cand.connectionId,
        asaasIds: fresh.map((x) => x.id),
        total: summary.total,
        lines: summary.lines,
        links: summary.links,
        charges: fresh.length,
        dueIn,
        touch: 0,
        delivery: delivery.label,
      },
      suggestedText: text,
      reason:
        (fresh.length === 1 ? '1 parcela vence' : `${fresh.length} parcelas vencem`) +
        (dueIn <= 0 ? ' hoje' : dueIn === 1 ? ' amanhã' : ` em ${dueIn} dias`) +
        ` — lembrete antes do vencimento, não é cobrança. Vai por ${delivery.label}.`,
      decision: decision.decision === 'auto_execute' ? 'auto' : decision.decision === 'request_approval' ? 'approve' : 'suggest',
      policy: decision.reason,
      status: 'pending',
    })
    out.queued += 1
    budget -= 1
    usedToday += 1
  }
  return out
}

/** Texto do lembrete: leve, sem "atraso", com os fatos prontos. IA quando há agente; senão o de segurança. */
async function draftReminder(args: {
  accountId: string
  agentId: string | null
  firstName: string | null
  fullName: string | null
  summary: ReturnType<typeof formatUpcomingSummary>
  tone: string
  seed: number
  moment: string
  offerDate: boolean
}): Promise<string> {
  const fallback = fallbackReminderMessage(args.firstName, args.summary, args.seed, { offerDate: args.offerDate })
  if (!args.agentId) return fallback
  try {
    const config = await loadAiConfigById(args.accountId, args.agentId, { requireActive: false })
    if (!config) return fallback
    const system = [
      'Você escreve um LEMBRETE amigável no WhatsApp, em português do Brasil, sobre uma cobrança que AINDA NÃO VENCEU. UMA mensagem (até 400 caracteres), sem markdown, sem assinatura.',
      args.fullName
        ? `Cliente (nome como está no Asaas): ${args.fullName}. Se for pessoa, chame só pelo primeiro nome; se for empresa, use o nome da empresa como está (curto). Nunca invente apelido.`
        : 'Não sabemos o nome do cliente — não invente um.',
      `O que vai vencer (copie exatamente, NUNCA recalcule):\n${args.summary.lines.map((l) => `- ${l}`).join('\n')}`,
      args.summary.showValues ? '' : 'A empresa NÃO quer valores na mensagem: não cite valor em reais — só a data de vencimento e o link. O valor o cliente vê no link.',
      linksInstruction(args.summary),
      'Não é cobrança de inadimplente: nunca use "atraso", "pendente", "em aberto" nem tom de pressão. Diga que é só um lembrete e que, se já estiver programado, pode ignorar.',
      'NUNCA fale em juros, multa, protesto, negativação ou consequência. Nunca ofereça desconto ou prazo.',
      args.moment ? `Momento do envio: ${args.moment}.` : '',
      args.offerDate ? '' : 'NÃO ofereça outra data nem prazo — se já pagou, é só responder por aqui.',
      args.tone ? `Instruções da empresa (siga à risca): ${args.tone}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const r = await generateReply({
      config,
      systemPrompt: system,
      messages: [{ role: 'user', content: 'Escreva o lembrete agora.' }] as unknown as Parameters<typeof generateReply>[0]['messages'],
    })
    const text = (r?.text ?? '').trim()
    if (text.length < 20 || tooSimilar(text, [fallback])) return text.length >= 20 ? text : fallback
    return text
  } catch {
    return fallback
  }
}

/**
 * Antes de enviar um lembrete: reconfere no Asaas, parcela por parcela, se
 * ainda está PENDING. Paga/cancelada sai da lista; sem nenhuma, o envio é
 * recusado com o motivo (a fila mostra).
 */
export async function reminderStillPending(accountId: string, payload: Record<string, unknown>): Promise<{ ok: true; pending: string[] } | { ok: false; error: string }> {
  const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : null
  const asaasIds = Array.isArray(payload.asaasIds) ? payload.asaasIds.filter((x): x is string => typeof x === 'string') : []
  if (!connectionId || !asaasIds.length) return { ok: false, error: 'Lembrete sem referência das parcelas — não dá para reconferir no Asaas.' }
  const conn = firstOrNull(
    await db
      .select({ apiKeyEnc: asaasConnections.apiKeyEnc, environment: asaasConnections.environment })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.id, connectionId), eq(asaasConnections.accountId, accountId)))
      .limit(1),
  )
  if (!conn) return { ok: false, error: 'A conta do Asaas deste lembrete não existe mais no CRM.' }
  let cred: AsaasCredential
  try {
    cred = { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
  } catch {
    return { ok: false, error: 'A chave do Asaas não pôde ser lida.' }
  }
  const pending: string[] = []
  for (const id of asaasIds) {
    try {
      const p = await getPayment(cred, id)
      if (String(p.status).toUpperCase() === 'PENDING') pending.push(id)
    } catch (err) {
      return { ok: false, error: `Não deu para reconferir no Asaas agora: ${err instanceof Error ? err.message : 'falha'}` }
    }
  }
  if (!pending.length) return { ok: false, error: 'A parcela já foi paga ou cancelada no Asaas — lembrete não enviado.' }
  return { ok: true, pending }
}

/** O agente padrão da conta (política + redação). */
export async function defaultAgentFor(accountId: string): Promise<{ id: string; autonomy: unknown } | null> {
  return firstOrNull(
    await db
      .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .limit(1),
  )
}

// ============================================================
// 🔔 Lembrete ANTES de vencer (lacuna 2, 07/09).
//
// A régua só agia em cobrança VENCIDA. Com `reminderDaysBefore > 0`, a rodada
// também olha o que vence nos próximos N dias e propõe um aviso leve — "vence
// quinta, tá aí o link" — pela mesma fila e política da cobrança. Nada entra na
// carteira (que continua sendo a de vencidas): a lista vem do Asaas na hora e
// o executor reconfere no Asaas, cobrança por cobrança, antes de enviar.
//
// Regras (15/09): um lembrete por parcela, e UMA mensagem de cobrança por
// pessoa por dia — quem já recebeu ou tem na fila régua, lembrete ou aviso de
// cobrança nova hoje fica para outro dia. Quem também tem parcela vencida
// recebe o lembrete da parcela nova (antes era barrado e nunca recebia); a
// vencida a régua cobra à parte. Devedor pausado, com promessa/comprovante ou
// no limite de toques não recebe. Parcela já lembrada, ou cujo link já saiu
// numa mensagem para ele, não é lembrada. Aviso de cobrança nova só conta como
// lembrado se foi feito nos últimos reminderDaysBefore+1 dias (17/09): a
// parcela avisada 6 a 15 dias antes na criação ainda recebe o lembrete D-5.
//
// 16/09 (Veloz Gás e Água): a LEITURA (scanUpcoming) é separada da FILA
// (queueUpcomingReminders). A leitura roda antes do teto do dia e grava quem
// vai vencer sem contato no CRM — a tela mostra; antes só o log sabia.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, gte, inArray, lt, notInArray, or, sql } from 'drizzle-orm'

import {
  db,
  agentActionRequests,
  aiConfigs,
  asaasCharges,
  asaasConnections,
  collectionsTouches,
  collectionsUpcomingUnmatched,
  contacts,
  conversations,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import {
  fetchCustomers,
  getPayment,
  listPendingDueBetween,
  type AsaasCredential,
  type AsaasCustomer,
  type AsaasEnv,
} from '@/lib/asaas/collections'
import { findContact, loadCustomerLinks } from '@/lib/asaas/sync'
import { buildUnmatchedRows, purgePlan, type UnmatchedEntry, type UnmatchedRow } from './upcoming-unmatched'
import { remindedFilter } from './new-charge-rules'
import { paymentRefsFrom, paymentRefsPayload, reconferPayments } from './payment-refs'
import { linksAlreadySent } from './links-sent'
import { decide, type AutonomyPolicy } from '@/lib/orchestration/policy'
import type { AccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'

import { resolveCollectionTargets } from './outreach'
import {
  byNearestDue,
  collectionEmail,
  debtorHold,
  fallbackReminderMessage,
  formatUpcomingSummary,
  freshReminderItems,
  greetingName,
  linksInstruction,
  remindedByContact,
  type CollectionsSettings,
  type UpcomingLine,
} from './rules'
import { localDayKey } from './stale'
import { seedFrom, tooSimilar } from './variation'

export interface ReminderRunResult {
  queued: number
  /** Parcelas a vencer encontradas no Asaas na janela. */
  found: number
  /**
   * no_contact = nenhum contato casou · ambiguous = 2+ contatos com o mesmo
   * telefone · customer_unavailable = o Asaas não deixou abrir o cadastro do
   * cliente nesta rodada · same_day = já tem mensagem de cobrança hoje ·
   * on_hold = pausado, promessa/comprovante ou limite de toques · already =
   * parcela já lembrada ou avisada · link_sent = o link já saiu numa mensagem ·
   * policy = a política bloqueou.
   */
  skipped: Partial<
    Record<
      | 'no_contact'
      | 'ambiguous'
      | 'customer_unavailable'
      | 'opted_out'
      | 'same_day'
      | 'on_hold'
      | 'already'
      | 'link_sent'
      | 'no_channel'
      | 'policy'
      | 'budget',
      number
    >
  >
}

/** Quem vai receber lembrete: um por contato, com as parcelas dele de todas as contas do Asaas. */
export interface UpcomingCandidate {
  contactId: string
  name: string | null
  /** E-mail do cliente no Asaas (a parcela a vencer não está na carteira). */
  email: string | null
  optedOut: boolean
  lines: UpcomingLine[]
  asaasIds: string[]
  /** Conta do Asaas de CADA parcela, na ordem de asaasIds (ver payment-refs.ts). */
  connectionIds: string[]
}

/** A LEITURA das parcelas a vencer, separada da fila (ver scanUpcoming). */
export interface UpcomingScan {
  found: number
  byContact: Map<string, UpcomingCandidate>
  skipped: ReminderRunResult['skipped']
  /**
   * Cadastros do Asaas já abertos nesta leitura, por conexão → cliente. O aviso
   * de cobrança nova reaproveita na mesma rodada (17/09): cada GET a menos é um
   * 429 a menos no Asaas.
   */
  customers: Map<string, Map<string, AsaasCustomer>>
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Lê no Asaas o que vence nos próximos N dias e casa com os contatos. NÃO
 * enfileira nada e NÃO depende do teto do dia.
 *
 * 🐛 16/09 (Veloz Gás e Água, GoLink): a leitura vivia dentro da fila e só
 * rodava com orçamento — no dia em que o teto acabava ninguém olhava, e o
 * cliente sem contato era um `bump('no_contact')` que só o log via. Agora ela
 * roda antes do teto e grava o retrato "a vencer sem contato"
 * (collections_upcoming_unmatched) que a tela /cobrancas mostra.
 */
export async function scanUpcoming(args: { accountId: string; settings: CollectionsSettings; tz: string }): Promise<UpcomingScan> {
  const out: UpcomingScan = { found: 0, byContact: new Map(), skipped: {}, customers: new Map() }
  const bump = (k: keyof ReminderRunResult['skipped']) => {
    out.skipped[k] = (out.skipped[k] ?? 0) + 1
  }
  const s = args.settings
  if (s.reminderDaysBefore <= 0) return out

  const conns = await db
    .select({ id: asaasConnections.id, label: asaasConnections.label, apiKeyEnc: asaasConnections.apiKeyEnc, environment: asaasConnections.environment })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, args.accountId), eq(asaasConnections.enabled, true)))
  if (!conns.length) return out

  const today = new Date()
  const todayKey = localDayKey(args.tz || 'America/Sao_Paulo', today)
  const daysUntilFrom = (ymd: string): number | null => {
    const venc = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`)
    const hoje = Date.parse(`${todayKey}T00:00:00Z`)
    if (Number.isNaN(venc) || Number.isNaN(hoje)) return null
    return Math.round((venc - hoje) / 86_400_000)
  }
  const from = isoDay(today)
  const until = isoDay(new Date(today.getTime() + s.reminderDaysBefore * 86_400_000))
  const byContact = out.byContact

  for (const c of conns) {
    let cred: AsaasCredential
    try {
      cred = { apiKey: decrypt(c.apiKeyEnc), environment: c.environment as AsaasEnv }
    } catch {
      continue
    }
    // Carimbo do INÍCIO da leitura: a limpeza apaga só o que é mais velho que
    // ele — uma leitura mais nova rodando junto não perde o que gravou.
    const scanStartedAt = new Date().toISOString()
    let payments
    try {
      payments = await listPendingDueBetween(cred, from, until)
    } catch (err) {
      // Listagem falhou: nada é gravado nem apagado do retrato desta conta.
      console.warn(`[lembrete] ${c.label}: não deu para listar a vencer — ${err instanceof Error ? err.message : err}`)
      continue
    }
    out.found += payments.length
    const links = payments.length ? await loadCustomerLinks(args.accountId, c.id) : new Map<string, string>()
    let customersOk = true
    const customers = payments.length
      ? await fetchCustomers(cred, payments.map((p) => p.customer)).catch((err) => {
          customersOk = false
          console.warn(`[lembrete] ${c.label}: não deu para abrir os clientes — ${err instanceof Error ? err.message : err}`)
          return new Map<string, AsaasCustomer>()
        })
      : new Map<string, AsaasCustomer>()
    if (customers.size) out.customers.set(c.id, customers)
    const unmatched: UnmatchedEntry[] = []
    const unknown = new Set<string>()
    for (const p of payments) {
      const cust = customers.get(p.customer)
      const linked = links.get(p.customer) ?? null
      if (!cust && !linked) {
        // Sem o cadastro não dá para casar nem para mostrar: antes virava
        // "no_contact" e, no retrato, um cartão sem nome nem telefone.
        bump('customer_unavailable')
        unknown.add(p.customer)
        continue
      }
      const decision = await findContact(args.accountId, cust?.mobilePhone || cust?.phone || null, cust?.email ?? null, cust?.cpfCnpj ?? null, linked)
      if (!decision.contactId) {
        const reason = decision.ambiguous ? 'ambiguous' : 'no_contact'
        bump(reason)
        unmatched.push({
          connectionId: c.id,
          customerId: p.customer,
          customer: cust ?? {},
          reason,
          payment: { id: p.id, value: p.value, dueDate: p.dueDate, invoiceUrl: p.invoiceUrl, description: p.description },
        })
        continue
      }
      // Dias até vencer pela DATA no fuso da conta (mesma conta da régua):
      // o servidor roda em UTC e `Date.UTC(...componentes locais)` errava por
      // um dia à noite.
      const daysUntil = p.dueDate ? daysUntilFrom(p.dueDate) : null
      let cand = byContact.get(decision.contactId)
      if (!cand) {
        cand = {
          contactId: decision.contactId,
          name: cust?.name ?? null,
          email: collectionEmail(cust?.email),
          optedOut: false,
          lines: [],
          asaasIds: [],
          connectionIds: [],
        }
        byContact.set(decision.contactId, cand)
      }
      if (!cand.name && cust?.name) cand.name = cust.name
      if (!cand.email && cust?.email) cand.email = collectionEmail(cust.email)
      cand.lines.push({ value: Number(p.value ?? 0), dueDate: p.dueDate ? p.dueDate.slice(0, 10) : null, daysUntil, connectionLabel: c.label, invoiceUrl: p.invoiceUrl ?? null })
      cand.asaasIds.push(p.id)
      cand.connectionIds.push(c.id)
    }
    // O retrato não pode parar o lembrete: falhou (migração fora de ordem,
    // banco ocupado), fica no log e a fila segue.
    try {
      await writeUpcomingSnapshot(args.accountId, c.id, buildUnmatchedRows(unmatched), purgePlan({ customersOk, unknownCustomerIds: unknown }), scanStartedAt)
    } catch (err) {
      console.error(`[lembrete] ${c.label}: não deu para gravar os a vencer sem contato — ${err instanceof Error ? err.message : err}`)
    }
  }
  return out
}

/**
 * Grava o retrato "a vencer sem contato" de UMA conexão: atualiza quem apareceu
 * nesta leitura e, se a leitura dos clientes deu certo, apaga quem não
 * apareceu (pagou, venceu, saiu da janela, ganhou contato ou foi ligado) —
 * menos os clientes que o Asaas não deixou abrir.
 */
export async function writeUpcomingSnapshot(
  accountId: string,
  connectionId: string,
  rows: readonly UnmatchedRow[],
  plan: { purge: boolean; keep: readonly string[] },
  scanStartedAt: string,
): Promise<void> {
  if (!rows.length && !plan.purge) return
  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .insert(collectionsUpcomingUnmatched)
        .values({
          accountId,
          connectionId,
          asaasCustomerId: r.customerId,
          customerName: r.name,
          phone: r.phone,
          email: r.email,
          cpfCnpj: r.cpfCnpj,
          reason: r.reason,
          payments: r.payments,
          nextDueDate: r.nextDueDate,
          total: r.total.toFixed(2),
          firstSeenAt: scanStartedAt,
          lastSeenAt: scanStartedAt,
        })
        .onConflictDoUpdate({
          target: [collectionsUpcomingUnmatched.accountId, collectionsUpcomingUnmatched.connectionId, collectionsUpcomingUnmatched.asaasCustomerId],
          // first_seen_at não muda: é desde quando o cliente está sem contato.
          set: {
            customerName: sql`excluded.customer_name`,
            phone: sql`excluded.phone`,
            email: sql`excluded.email`,
            cpfCnpj: sql`excluded.cpf_cnpj`,
            reason: sql`excluded.reason`,
            payments: sql`excluded.payments`,
            nextDueDate: sql`excluded.next_due_date`,
            total: sql`excluded.total`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        })
    }
    if (!plan.purge) return
    await tx
      .delete(collectionsUpcomingUnmatched)
      .where(
        and(
          eq(collectionsUpcomingUnmatched.accountId, accountId),
          eq(collectionsUpcomingUnmatched.connectionId, connectionId),
          lt(collectionsUpcomingUnmatched.lastSeenAt, scanStartedAt),
          ...(plan.keep.length ? [notInArray(collectionsUpcomingUnmatched.asaasCustomerId, [...plan.keep])] : []),
        ),
      )
  })
}

export async function queueUpcomingReminders(args: {
  accountId: string
  settings: CollectionsSettings
  accountSettings: AccountSettings
  policy: AutonomyPolicy
  agentId: string | null
  /** Quantas ainda cabem no teto do dia. */
  budget: number
  /** Contatos que já têm pedido na fila (pending/queued), inclusive os desta rodada. */
  alreadyQueued: Set<string>
  /** Contatos com mensagem de cobrança hoje (pending/queued/sent) — ver `contactedTodaySet`. */
  contactedToday: Set<string>
  usedToday: number
  moment: string
  dayKey: string
  /** A leitura feita antes do teto (scanUpcoming). */
  scan: UpcomingScan
}): Promise<ReminderRunResult> {
  const out: ReminderRunResult = { queued: 0, found: args.scan.found, skipped: { ...args.scan.skipped } }
  const bump = (k: keyof ReminderRunResult['skipped']) => {
    out.skipped[k] = (out.skipped[k] ?? 0) + 1
  }
  const s = args.settings
  const byContact = args.scan.byContact
  if (s.reminderDaysBefore <= 0 || args.budget <= 0 || !byContact.size) return out

  const ids = [...byContact.keys()]
  // Quem também tem parcela VENCIDA recebe o lembrete da parcela nova — a
  // vencida a régua cobra à parte, em outro dia. Serve só para o motivo.
  // 🐛 Antes era um pulo: `open=true` sem olhar status barrava o lembrete de
  // quem tinha qualquer coisa aberta (GoLink 15/09: 32 devedores sem lembrete
  // da parcela seguinte, e a cobrança PENDING criada pelo CRM barrava o
  // lembrete dela mesma).
  // Conta também a vencida que o Asaas ainda mostra como PENDING (sync lê à
  // parte, ver asaas/overdue-pending.ts): vencimento antes de hoje é vencida.
  const overdue = await db
    .selectDistinct({ contactId: asaasCharges.contactId })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, args.accountId),
        eq(asaasCharges.open, true),
        or(
          inArray(asaasCharges.status, s.overdueStatuses),
          and(eq(asaasCharges.status, 'PENDING'), lt(asaasCharges.dueDate, args.dayKey)),
        ),
        inArray(asaasCharges.contactId, ids),
      ),
    )
  const withOverdue = new Set(overdue.map((r) => r.contactId).filter((x): x is string => !!x))

  // O freio do devedor (pausa, promessa/comprovante, limite de toques) vale
  // para o lembrete como vale para a régua — 15/09, Reboque Modelo pausado
  // recebeu lembrete.
  const touchRows = await db
    .select({
      contactId: collectionsTouches.contactId,
      paused: collectionsTouches.paused,
      snoozeUntil: collectionsTouches.snoozeUntil,
      touchCount: collectionsTouches.touchCount,
      lastTouchAt: collectionsTouches.lastTouchAt,
    })
    .from(collectionsTouches)
    .where(and(eq(collectionsTouches.accountId, args.accountId), inArray(collectionsTouches.contactId, ids)))
  const touchByContact = new Map(touchRows.map((r) => [r.contactId, r]))

  const contactRows = await db
    .select({ id: contacts.id, name: contacts.name, optedOut: contacts.optedOut })
    .from(contacts)
    .where(and(eq(contacts.accountId, args.accountId), inArray(contacts.id, ids)))
  const contactById = new Map(contactRows.map((r) => [r.id, r]))

  // Link que já saiu numa mensagem nestes dias (criação com "mandar o link",
  // [[COBRAR:]] da IA, colado à mão) não precisa de lembrete.
  const linksSince = new Date(Date.now() - (s.reminderDaysBefore + 1) * 86_400_000).toISOString()

  // Um lembrete por parcela: o que já foi lembrado nos últimos 45 dias não
  // repete. Expirado (envelheceu na fila, stale.ts) ou falho NÃO conta como
  // lembrado — senão a parcela ficaria sem aviso nenhum. Conta POR CONTATO
  // (revisão 16/09): o lembrete que foi (ou foi recusado) para o contato ligado
  // por engano não segura o do contato certo, ligado depois — ver
  // `remindedByContact`.
  // 🔗 Aviso de cobrança nova só conta dentro da janela do lembrete (17/09,
  // `remindedFilter`): com o aviso na criação para o que vence em até 15 dias,
  // contar por 45 dias apagava o lembrete D-5 (Ômega Gás, criada 15/09, vence
  // 26/09 — o lembrete de 21/09 não sairia).
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString()
  const previous = await db
    .select({
      contactId: agentActionRequests.contactId,
      payload: agentActionRequests.payload,
      createdAt: agentActionRequests.createdAt,
      kind: sql<string | null>`${agentActionRequests.payload}->>'kind'`,
    })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, args.accountId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        inArray(agentActionRequests.contactId, ids),
        gte(agentActionRequests.createdAt, since),
        sql`${agentActionRequests.payload}->>'kind' IN ('reminder', 'new_charge')`,
        sql`${agentActionRequests.status} NOT IN ('expired', 'failed')`,
      ),
    )
  const remindedOf = remindedByContact(remindedFilter(previous, linksSince))
  const nothingReminded: ReadonlySet<string> = new Set<string>()

  let budget = args.budget
  let usedToday = args.usedToday
  // Vence antes, sai antes: se o teto cortar, corta quem ainda tem dias de janela.
  for (const cand of byNearestDue([...byContact.values()])) {
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
    // Uma mensagem de cobrança por pessoa por dia: vale a primeira (a régua
    // roda antes na rodada); o lembrete tenta de novo no próximo dia da janela.
    if (args.alreadyQueued.has(cand.contactId) || args.contactedToday.has(cand.contactId)) {
      bump('same_day')
      continue
    }
    if (debtorHold(touchByContact.get(cand.contactId), s)) {
      bump('on_hold')
      continue
    }
    const items = cand.asaasIds.map((id, i) => ({
      id,
      connectionId: cand.connectionIds[i],
      invoiceUrl: cand.lines[i].invoiceUrl,
      line: cand.lines[i],
    }))
    const reminded = remindedOf.get(cand.contactId) ?? nothingReminded
    let fresh = freshReminderItems(items, reminded, new Set<string>())
    if (!fresh.length) {
      bump('already')
      continue
    }
    const urls = [...new Set(fresh.map((x) => x.invoiceUrl).filter((u): u is string => !!u))]
    if (urls.length) {
      const sentUrls = await linksAlreadySent(args.accountId, cand.contactId, urls, linksSince)
      fresh = freshReminderItems(fresh, reminded, sentUrls)
      if (!fresh.length) {
        bump('link_sent')
        continue
      }
    }
    const delivery = await resolveCollectionTargets(args.accountId, cand.contactId, null, { dryRun: true, fallbackEmail: cand.email })
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
      bump(/teto/i.test(decision.reason) ? 'budget' : 'policy')
      continue
    }

    const dueIn = summary.minDays ?? s.reminderDaysBefore
    // Colisão com pedido pendente (índice único por contato) vira pulo, não
    // derruba o lote de lembretes da rodada.
    const inserted = await db
      .insert(agentActionRequests)
      .values({
        accountId: args.accountId,
        agentId: args.agentId,
        contactId: cand.contactId,
        dealId: null,
        conversationId: conv?.id ?? null,
        actionType: 'collect_charges',
        payload: {
          kind: 'reminder',
          ...paymentRefsPayload(fresh.map((x) => ({ asaasId: x.id, connectionId: x.connectionId }))),
          total: summary.total,
          lines: summary.lines,
          links: summary.links,
          charges: fresh.length,
          dueIn,
          touch: 0,
          delivery: delivery.label,
          // O executor usa se o contato continuar sem e-mail na hora do envio.
          ...(cand.email ? { asaasEmail: cand.email } : {}),
        },
        suggestedText: text,
        reason:
          (fresh.length === 1 ? '1 parcela vence' : `${fresh.length} parcelas vencem`) +
          (dueIn <= 0 ? ' hoje' : dueIn === 1 ? ' amanhã' : ` em ${dueIn} dias`) +
          ' — lembrete antes do vencimento, não é cobrança.' +
          (withOverdue.has(cand.contactId) ? ' Ele também tem parcela vencida — essa a régua cobra à parte, em outro dia.' : '') +
          ` Vai por ${delivery.label}.`,
        decision: decision.decision === 'auto_execute' ? 'auto' : decision.decision === 'request_approval' ? 'approve' : 'suggest',
        policy: decision.reason,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: agentActionRequests.id })
    if (!inserted.length) {
      bump('same_day')
      continue
    }
    args.contactedToday.add(cand.contactId)
    args.alreadyQueued.add(cand.contactId)
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
export async function reminderStillPending(
  accountId: string,
  payload: Record<string, unknown>,
  /**
   * Situações que ainda valem o envio. Lembrete só vale a vencer (PENDING);
   * o aviso de COBRANÇA NOVA também vale vencida (11/09: a do João nasceu
   * vencida no mesmo dia e o cliente nunca recebeu o link).
   */
  aceitas: readonly string[] = ['PENDING'],
): Promise<{ ok: true; pending: string[] } | { ok: false; error: string }> {
  const refs = paymentRefsFrom(payload)
  if (!refs.length) return { ok: false, error: 'Sem referência das parcelas — não dá para reconferir no Asaas.' }
  const ids = [...new Set(refs.map((r) => r.connectionId))]
  const conns = await db
    .select({
      id: asaasConnections.id,
      label: asaasConnections.label,
      apiKeyEnc: asaasConnections.apiKeyEnc,
      environment: asaasConnections.environment,
    })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, accountId), inArray(asaasConnections.id, ids)))
  const byId = new Map(conns.map((c) => [c.id, c]))
  // Cada parcela é reconferida com a chave da conta DELA (payment-refs.ts).
  return reconferPayments(
    refs,
    async (connectionId) => {
      const conn = byId.get(connectionId)
      if (!conn) return { error: 'A conta do Asaas deste lembrete não existe mais no CRM.' }
      try {
        return { cred: { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }, label: conn.label }
      } catch {
        return { error: `A chave do Asaas (${conn.label}) não pôde ser lida.` }
      }
    },
    getPayment,
    aceitas,
  )
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

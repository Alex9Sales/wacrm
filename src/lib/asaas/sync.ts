// ============================================================
// 🧾 Sincronizar a carteira do Asaas para dentro do CRM (Fase 1).
//
// SOMENTE LEITURA do lado do Asaas: nada é criado, alterado ou cancelado lá,
// e nada é enviado para ninguém. O objetivo da fase é o cliente abrir a tela e
// reconhecer as cobranças dele.
//
// Sem 'server-only' — o worker precisa alcançar isso na Fase 2.
// ============================================================

import { and, eq, inArray, lte, notInArray, or, sql } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, asaasCustomerLinks, contacts } from '@/db'
import { decrypt } from '@/lib/whatsapp/encryption'

import {
  AsaasApiError,
  DEFAULT_OVERDUE_STATUSES,
  fetchCustomers,
  listAllCustomers,
  listCharges,
  listPendingDueUntil,
  setCustomerNotifications,
  type AsaasCredential,
  type AsaasEnv,
} from './collections'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { localDayKey } from '@/lib/collections/stale'
import { mergePayments, overduePendingCutoff } from './overdue-pending'
import { listChargesAtSilencing, markAsaasNotificationsSwept, recordSilenced } from '@/lib/collections/asaas-silenced'
import { fullSweepReason } from '@/lib/collections/new-charge-rules'
import { normalizeSettings } from '@/lib/collections/rules'

import {
  brPhoneCandidates,
  decideWithLink,
  normalizeDocument,
  normalizeEmail,
  type MatchCandidate,
} from './match'

/**
 * De quanto em quanto tempo a varredura de avisos olha TODOS os clientes do
 * Asaas, e não só os da carteira vencida. Cliente novo nasce lá com aviso
 * ligado; um dia é rápido o bastante para o dono não pagar por isso, e raro o
 * bastante para não pesar na rodada da régua (a listagem é paginada).
 * É a rotina: ligar "o CRM assume os avisos" antecipa a próxima (`fullSweepReason`).
 */
const FULL_SWEEP_MS = 20 * 3_600_000

export interface SyncResult {
  ok: boolean
  /** Cobranças em aberto na carteira depois desta rodada. */
  total: number
  /** Quantas casaram com um contato do CRM. */
  matched: number
  /** Quantas ficaram sem contato (pendência para resolver na tela). */
  pending: number
  /** Clientes cujas notificações do Asaas foram desligadas nesta rodada (item 5). */
  notificationsOff: number
  /** Quantas sumiram da lista do Asaas desde a última rodada (pagas/apagadas). */
  closed: number
  /** Cobranças que existem no Asaas mas AINDA NÃO venceram (só para a tela não
   *  dizer "zero" quando o cliente está olhando cobranças na conta dele). */
  upcoming: number
  /** Vencidas que o Asaas ainda mostra como PENDING (entram na carteira como vencidas). */
  pendingOverdue: number
  error?: string
}

const EMPTY: SyncResult = { ok: true, total: 0, matched: 0, pending: 0, closed: 0, upcoming: 0, pendingOverdue: 0, notificationsOff: 0 }

/**
 * Puxa a carteira de UMA conexão e espelha no CRM.
 *
 * O que sumiu da lista do Asaas não é apagado: vira `open=false` com carimbo.
 * O histórico do que já esteve na carteira precisa sobreviver — é dele que
 * sai, na Fase 5, a conta de quanto foi recuperado.
 */
export async function syncConnection(
  accountId: string,
  connectionId: string,
  statuses: readonly string[] = DEFAULT_OVERDUE_STATUSES,
): Promise<SyncResult> {
  const [conn] = await db
    .select()
    .from(asaasConnections)
    .where(and(eq(asaasConnections.id, connectionId), eq(asaasConnections.accountId, accountId)))
    .limit(1)

  if (!conn) return { ...EMPTY, ok: false, error: 'Conexão não encontrada.' }

  let cred: AsaasCredential
  try {
    cred = { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
  } catch {
    await markError(connectionId, 'A chave salva não pôde ser lida. Cadastre a chave de novo.')
    return { ...EMPTY, ok: false, error: 'A chave salva não pôde ser lida. Cadastre a chave de novo.' }
  }

  let payments
  try {
    payments = await listCharges(cred, statuses)
  } catch (err) {
    const msg = err instanceof AsaasApiError ? err.message : 'Não foi possível falar com o Asaas.'
    await markError(connectionId, msg)
    return { ...EMPTY, ok: false, error: msg }
  }

  // 🧾 Vencida que o Asaas ainda mostra como PENDING (João/GoLink 21/09: 13
  // boletos do dia 20 seguiam PENDING no dia seguinte e ninguém via). Lê à
  // parte, com vencimento até ONTEM no fuso da conta, e junta à carteira como o
  // que é: vencida. `pendingCutoff` null = essa listagem não rodou, e o
  // fechamento abaixo não pode fechar PENDING nenhuma (ver overdue-pending.ts).
  const accountSettingsRow = await getAccountSettings(accountId)
  let pendingCutoff: string | null = null
  let pendingOverdue = 0
  if (!statuses.includes('PENDING')) {
    const cutoff = overduePendingCutoff(localDayKey(accountSettingsRow.businessTimezone || 'America/Sao_Paulo'))
    try {
      const vencidasPendentes = await listPendingDueUntil(cred, cutoff)
      const antes = payments.length
      payments = mergePayments(payments, vencidasPendentes)
      pendingOverdue = payments.length - antes
      pendingCutoff = cutoff
    } catch (err) {
      console.warn(`[asaas sync] ${conn.label}: não deu para listar as vencidas ainda PENDING — ${err instanceof Error ? err.message : err}`)
    }
  }

  const customers = await fetchCustomers(cred, payments.map((p) => p.customer)).catch(() => new Map())

  // Item 5 (05/09): o CRM assume os avisos. Opt-in na régua: desliga as
  // notificações do Asaas de quem entra na carteira — o cliente paga por envio
  // lá, e a régua é quem fala. Falhou num cliente → a próxima rodada tenta.
  //
  // 11/09 (João/GoLink): "desativei tudo e o Asaas continua cobrando taxa". A
  // varredura só via quem JÁ estava vencido, e cliente novo nasce no Asaas com
  // aviso LIGADO — dois clientes criados em 24h já estavam mandando de novo.
  // Agora, uma vez por dia, a varredura pega TODOS os clientes da conta.
  let notificationsOff = 0
  let notificationsRefused = 0
  try {
    const s = normalizeSettings(accountSettingsRow.collections)
    if (s.asaasNotificationsOff) {
      // Revisão 17/09: além da rotina de 20 h, varre JÁ quando a opção foi ligada
      // depois da última varredura — antes, com a conexão varrida há pouco (selo
      // clicado antes de marcar a opção, ou desmarcar e remarcar), o aviso de
      // cobrança nova esperava até um dia e as cobranças desse meio-tempo nunca
      // eram avisadas. Regras em `fullSweepReason`.
      const motivoVarredura = fullSweepReason({
        nowMs: Date.now(),
        lastSweepAt: conn.notificationsOffAt,
        offAt: s.asaasNotificationsOffAt,
        sweptAt: s.asaasNotificationsSweptAt,
        everyMs: FULL_SWEEP_MS,
      })
      const sweepAll = motivoVarredura !== null
      if (motivoVarredura && motivoVarredura !== 'rotina') {
        console.log(`[cobranca] ${conn.label}: varredura completa dos avisos antecipada (${motivoVarredura}) — "o CRM assume os avisos" foi ligado depois da última.`)
      }
      let pool = [...customers.values()]
      // Instante da lista de clientes: quem existia até aqui foi calado (ou recusado).
      const sweepStartedAt = new Date().toISOString()
      let everyoneListed = false
      if (sweepAll) {
        // Falha na listagem não pode derrubar a sincronização: cai na carteira.
        // Mas não some em silêncio: sem a lista completa a varredura não conta
        // para o aviso de cobrança nova, que segue esperando (e tenta de novo).
        const everyone = await listAllCustomers(cred).catch((err: unknown) => {
          console.warn(
            `[cobranca] ${conn.label}: não deu para listar todos os clientes do Asaas — a varredura de avisos ficou só na carteira (${err instanceof Error ? err.message : String(err)}).`,
          )
          return null
        })
        if (everyone) {
          pool = everyone
          everyoneListed = true
        }
      }
      const calados: string[] = []
      for (const c of pool) {
        if (c.notificationDisabled === true) continue
        try {
          await setCustomerNotifications(cred, c.id, true)
          c.notificationDisabled = true
          const inWallet = customers.get(c.id)
          if (inWallet) inWallet.notificationDisabled = true
          calados.push(c.id)
          notificationsOff++
        } catch {
          // Assinatura ativa ("possui cobranças agendadas") recusa sempre — a
          // conta resolve no painel do Asaas. Contamos para não ficar invisível.
          notificationsRefused++
        }
      }
      if (calados.length) {
        // 🔕 Revisão 17/09 (aviso de cobrança nova): guarda QUANDO o CRM calou
        // esses clientes e quais cobranças deles já existiam — a do painel criada
        // antes da varredura o Asaas avisou; a criada depois, o CRM avisa. Lista
        // só se alguém foi calado (a recusa diária da assinatura ativa não gasta GET).
        await recordSilenced(connectionId, calados, await listChargesAtSilencing(cred))
      }
      if (sweepAll) {
        await db
          .update(asaasConnections)
          .set({ notificationsOffAt: new Date().toISOString() })
          .where(eq(asaasConnections.id, connectionId))
          .catch(() => {})
        // Primeira varredura COMPLETA depois de ligar a opção: é daí que o
        // aviso de cobrança nova conta o piso (não do clique). Listagem que
        // falhou não conta — a carteira sozinha não cala o cliente novo.
        if (everyoneListed) await markAsaasNotificationsSwept(accountId, sweepStartedAt)
        if (notificationsRefused) {
          console.warn(`[cobranca] ${conn.label}: ${notificationsRefused} cliente(s) o Asaas não deixou desligar os avisos (provável assinatura ativa).`)
        }
      }
    }
  } catch {
    /* configuração indisponível: segue sem mexer nos avisos */
  }
  const now = new Date().toISOString()
  const seen: string[] = []
  let matched = 0
  // Vínculos feitos na tela (migr 0178): a parcela nova do cliente segue o
  // contato que a equipe escolheu, em vez de ser casada de novo por palpite.
  const links = await loadCustomerLinks(accountId, connectionId)

  for (const p of payments) {
    const cust = customers.get(p.customer)
    const phone = cust?.mobilePhone || cust?.phone || null
    const email = cust?.email ?? null
    const doc = cust?.cpfCnpj ?? null

    const decision = await findContact(accountId, phone, email, doc, links.get(p.customer) ?? null)
    if (decision.contactId) matched++

    await db
      .insert(asaasCharges)
      .values({
        accountId,
        connectionId,
        asaasId: p.id,
        asaasCustomerId: p.customer,
        customerName: cust?.name ?? null,
        cpfCnpj: doc,
        phone,
        email,
        value: String(p.value ?? 0),
        // Juros + multa que o Asaas já calculou (só faz sentido vencida).
        interestValue: typeof p.interestValue === 'number' && Number.isFinite(p.interestValue) ? String(p.interestValue) : null,
        asaasCreatedAt: p.dateCreated ? p.dateCreated.slice(0, 10) : null,
        dueDate: p.dueDate ? p.dueDate.slice(0, 10) : null,
        status: p.status,
        billingType: p.billingType ?? null,
        description: p.description ?? null,
        invoiceUrl: p.invoiceUrl ?? null,
        bankSlipUrl: p.bankSlipUrl ?? null,
        installmentNumber: p.installmentNumber ?? null,
        contactId: decision.contactId,
        matchedBy: decision.matchedBy,
        open: true,
        closedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [asaasCharges.accountId, asaasCharges.asaasId],
        set: {
          // Dados do devedor e da cobrança: o Asaas é a fonte da verdade.
          customerName: sql`excluded.customer_name`,
          cpfCnpj: sql`excluded.cpf_cnpj`,
          phone: sql`excluded.phone`,
          email: sql`excluded.email`,
          value: sql`excluded.value`,
          interestValue: sql`excluded.interest_value`,
          dueDate: sql`excluded.due_date`,
          status: sql`excluded.status`,
          billingType: sql`excluded.billing_type`,
          description: sql`excluded.description`,
          invoiceUrl: sql`excluded.invoice_url`,
          bankSlipUrl: sql`excluded.bank_slip_url`,
          installmentNumber: sql`excluded.installment_number`,
          open: sql`true`,
          closedAt: sql`NULL`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
          // Casamento feito na MÃO não é sobrescrito por um palpite automático:
          // quem corrigiu na tela sabia mais que a heurística. E o vínculo ATUAL
          // (asaas_customer_links, que chega aqui como 'manual') vence um
          // 'manual' antigo gravado na linha: cobrança que reabre, ligada a A no
          // passado, segue o contato B que a equipe escolheu depois (16/09).
          // Só na cobrança espelhada (origin 'sync') ou sem contato: a que o CRM
          // emitiu (IA ou "Nova cobrança" — emit.ts grava 'manual') é do contato
          // da conversa em que nasceu. Revisão 16/09: cliente cus_X ligado ao
          // financeiro (B) e cobrança pedida pelo sócio (C, mesmo CNPJ) depois
          // do vínculo — ao vencer, a sincronização a mudava para B e a régua
          // cobrava quem não pediu. Linha sem contato (ficha apagada), o vínculo preenche.
          contactId: sql`CASE WHEN excluded.matched_by = 'manual' AND (${asaasCharges.origin} = 'sync' OR ${asaasCharges.contactId} IS NULL) THEN excluded.contact_id WHEN ${asaasCharges.matchedBy} = 'manual' THEN ${asaasCharges.contactId} ELSE excluded.contact_id END`,
          matchedBy: sql`CASE WHEN excluded.matched_by = 'manual' OR ${asaasCharges.matchedBy} = 'manual' THEN 'manual' ELSE excluded.matched_by END`,
        },
      })

    seen.push(p.id)
  }

  // Sumiu da lista do Asaas → saiu da carteira (pagou, ou apagaram lá).
  const closedRows = await db
    .update(asaasCharges)
    .set({ open: false, closedAt: now, updatedAt: now })
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.connectionId, connectionId),
        eq(asaasCharges.open, true),
        // Só o que ESTAVA numa listagem desta rodada pode "sumir" (pagou/apagou):
        // os status sincronizados e, quando a listagem rodou, a PENDING com
        // vencimento até o corte. Cobrança criada pela IA ou à mão nasce PENDING
        // com vencimento FUTURO, não vem em listagem nenhuma — e continuava
        // aberta no Asaas: fechá-la aqui era mentira (achado de 05/09, ao
        // construir a "Nova cobrança"). Regra pura: `mayCloseUnseen`.
        pendingCutoff
          ? or(
              inArray(asaasCharges.status, [...statuses]),
              and(eq(asaasCharges.status, 'PENDING'), lte(asaasCharges.dueDate, pendingCutoff)),
            )
          : inArray(asaasCharges.status, [...statuses]),
        seen.length ? notInArray(asaasCharges.asaasId, seen) : sql`true`,
      ),
    )
    .returning({ id: asaasCharges.id })

  await db
    .update(asaasConnections)
    .set({ lastSyncAt: now, lastSyncError: null, lastSyncCount: payments.length, updatedAt: now })
    .where(eq(asaasConnections.id, connectionId))

  // Quantas ainda vão vencer. É uma chamada a mais, e ela existe só para a tela
  // conseguir dizer "nenhuma vencida, mas você tem N a vencer" em vez de um
  // zero que parece falha (caso Alex 04/09: 6 parcelas no Asaas, nenhuma vencida).
  let upcoming = 0
  if (!statuses.includes('PENDING')) {
    try {
      upcoming = (await listCharges(cred, ['PENDING'])).length
    } catch {
      /* contexto é bônus: se falhar, a sincronização continua válida */
    }
  }

  return {
    ok: true,
    total: payments.length,
    matched,
    pending: payments.length - matched,
    closed: closedRows.length,
    upcoming,
    pendingOverdue,
    notificationsOff,
  }
}

/** Sincroniza todas as conexões ligadas da conta e soma o resultado. */
export async function syncAccount(accountId: string, statuses?: readonly string[]): Promise<SyncResult> {
  const conns = await db
    .select({ id: asaasConnections.id })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))

  if (!conns.length) return { ...EMPTY, ok: false, error: 'Nenhuma conta do Asaas conectada.' }

  const totals = { ...EMPTY }
  const errors: string[] = []
  for (const c of conns) {
    const r = await syncConnection(accountId, c.id, statuses)
    if (!r.ok) {
      errors.push(r.error ?? 'falha')
      continue
    }
    totals.total += r.total
    totals.matched += r.matched
    totals.pending += r.pending
    totals.closed += r.closed
    totals.upcoming += r.upcoming
    totals.pendingOverdue += r.pendingOverdue
    totals.notificationsOff += r.notificationsOff
  }

  // Uma conexão quebrada não some em silêncio, mesmo que a outra tenha ido bem.
  return errors.length === conns.length
    ? { ...totals, ok: false, error: errors[0] }
    : { ...totals, ok: true, error: errors.length ? errors.join(' · ') : undefined }
}

async function markError(connectionId: string, error: string): Promise<void> {
  await db
    .update(asaasConnections)
    .set({ lastSyncError: error, updatedAt: new Date().toISOString() })
    .where(eq(asaasConnections.id, connectionId))
}

/**
 * Vínculos "cliente do Asaas → contato" desta conexão (migr 0178), só para
 * contato que ainda existe nesta conta. Nunca lança: se a tabela não existir
 * (migração fora de ordem) ou a consulta falhar, devolve vazio e o casamento
 * automático segue — a régua e o lembrete não param por causa do vínculo.
 */
export async function loadCustomerLinks(accountId: string, connectionId: string): Promise<Map<string, string>> {
  try {
    const rows = await db
      .select({ customerId: asaasCustomerLinks.asaasCustomerId, contactId: asaasCustomerLinks.contactId })
      .from(asaasCustomerLinks)
      .innerJoin(contacts, and(eq(contacts.id, asaasCustomerLinks.contactId), eq(contacts.accountId, accountId)))
      .where(and(eq(asaasCustomerLinks.accountId, accountId), eq(asaasCustomerLinks.connectionId, connectionId)))
    return new Map(rows.map((r) => [r.customerId, r.contactId]))
  } catch (err) {
    console.warn('[cobranca] vínculos do Asaas indisponíveis — segue o casamento automático:', err instanceof Error ? err.message : err)
    return new Map()
  }
}

/**
 * Procura o contato do CRM por telefone, e-mail e código do cliente — nessa
 * ordem de confiança. Empate em qualquer nível devolve "sem contato".
 * Com `linkedContactId` (vínculo feito na tela, ver loadCustomerLinks) nem
 * procura: quem ligou na mão sabia mais que a heurística.
 */
export async function findContact(
  accountId: string,
  phone: string | null,
  email: string | null,
  document: string | null,
  linkedContactId?: string | null,
) {
  if (linkedContactId) return decideWithLink(linkedContactId, [])
  const found: MatchCandidate[] = []

  const phones = brPhoneCandidates(phone)
  if (phones.length) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), inArray(contacts.phoneNormalized, phones)))
      .limit(5)
    found.push(...rows.map((r) => ({ id: r.id, via: 'phone' as const })))
  }

  const mail = normalizeEmail(email)
  if (mail) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), sql`lower(${contacts.email}) = ${mail}`))
      .limit(5)
    found.push(...rows.map((r) => ({ id: r.id, via: 'email' as const })))
  }

  const doc = normalizeDocument(document)
  if (doc) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), sql`${contacts.customerCodes} @> ARRAY[${doc}]::text[]`))
      .limit(5)
    found.push(...rows.map((r) => ({ id: r.id, via: 'code' as const })))
  }

  return decideWithLink(null, found)
}

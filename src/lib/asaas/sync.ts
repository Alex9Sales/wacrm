// ============================================================
// 🧾 Sincronizar a carteira do Asaas para dentro do CRM (Fase 1).
//
// SOMENTE LEITURA do lado do Asaas: nada é criado, alterado ou cancelado lá,
// e nada é enviado para ninguém. O objetivo da fase é o cliente abrir a tela e
// reconhecer as cobranças dele.
//
// Sem 'server-only' — o worker precisa alcançar isso na Fase 2.
// ============================================================

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, contacts } from '@/db'
import { decrypt } from '@/lib/whatsapp/encryption'

import {
  AsaasApiError,
  DEFAULT_OVERDUE_STATUSES,
  fetchCustomers,
  listCharges,
  setCustomerNotifications,
  type AsaasCredential,
  type AsaasEnv,
} from './collections'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { normalizeSettings } from '@/lib/collections/rules'

import {
  brPhoneCandidates,
  decideMatch,
  normalizeDocument,
  normalizeEmail,
  type MatchCandidate,
} from './match'

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
  error?: string
}

const EMPTY: SyncResult = { ok: true, total: 0, matched: 0, pending: 0, closed: 0, upcoming: 0, notificationsOff: 0 }

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

  const customers = await fetchCustomers(cred, payments.map((p) => p.customer)).catch(() => new Map())

  // Item 5 (05/09): o CRM assume os avisos. Opt-in na régua: desliga as
  // notificações do Asaas de quem entra na carteira — o cliente paga por envio
  // lá, e a régua é quem fala. Falhou num cliente → a próxima rodada tenta.
  let notificationsOff = 0
  try {
    const s = normalizeSettings((await getAccountSettings(accountId)).collections)
    if (s.asaasNotificationsOff) {
      for (const c of customers.values()) {
        if (c.notificationDisabled !== false) continue
        try {
          await setCustomerNotifications(cred, c.id, true)
          c.notificationDisabled = true
          notificationsOff++
        } catch {
          /* próxima rodada */
        }
      }
    }
  } catch {
    /* configuração indisponível: segue sem mexer nos avisos */
  }
  const now = new Date().toISOString()
  const seen: string[] = []
  let matched = 0

  for (const p of payments) {
    const cust = customers.get(p.customer)
    const phone = cust?.mobilePhone || cust?.phone || null
    const email = cust?.email ?? null
    const doc = cust?.cpfCnpj ?? null

    const decision = await findContact(accountId, phone, email, doc)
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
          // quem corrigiu na tela sabia mais que a heurística.
          contactId: sql`CASE WHEN ${asaasCharges.matchedBy} = 'manual' THEN ${asaasCharges.contactId} ELSE excluded.contact_id END`,
          matchedBy: sql`CASE WHEN ${asaasCharges.matchedBy} = 'manual' THEN 'manual' ELSE excluded.matched_by END`,
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
        // Só o que ESTAVA nos status sincronizados pode "sumir" (pagou/apagou).
        // Cobrança criada pela IA ou à mão nasce PENDING, não vem na lista de
        // vencidas — e continuava aberta no Asaas: fechá-la aqui era mentira
        // (achado de 05/09, ao construir a "Nova cobrança").
        inArray(asaasCharges.status, [...statuses]),
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
 * Procura o contato do CRM por telefone, e-mail e código do cliente — nessa
 * ordem de confiança. Empate em qualquer nível devolve "sem contato".
 */
async function findContact(
  accountId: string,
  phone: string | null,
  email: string | null,
  document: string | null,
) {
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

  return decideMatch(found)
}

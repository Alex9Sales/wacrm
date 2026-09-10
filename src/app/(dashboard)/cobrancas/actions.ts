'use server'

// ============================================================
// 🧾 Carteira vencida (tela /cobrancas) — agente de cobrança, Fase 1.
//
// Esta fase é SOMENTE LEITURA: conecta o Asaas do cliente, espelha a carteira
// e mostra na tela. Nenhuma mensagem sai daqui.
//
// Duas regras que valem para o arquivo inteiro:
//   • a chave da API NUNCA volta pro cliente — só os 4 últimos caracteres;
//   • erro ESPERADO volta como { ok:false, error }, porque `throw` em Server
//     Action chega sanitizado ("digest") no navegador em produção.
// ============================================================

import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, aiConfigs, asaasCharges, asaasConnections, channels, collectionsTouches, contacts, conversations, decisionFeedback, member, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { getAccountSettings, updateAccountSettings } from '@/lib/settings/account-settings'
import { runCollectionsForAccount } from '@/lib/collections/engine'
import { duplicateSuspects, normalizeSettings, type CollectionsSettings } from '@/lib/collections/rules'
import { evaluatePromotion, promotionHeadline, type PromotionVerdict } from '@/lib/collections/promotion'
import { criteriaFor, readPromotionOverride, statsFromFeedback } from '@/lib/orchestration/validation'
import { levelFor, readPolicy } from '@/lib/orchestration/policy'
import { AsaasApiError, listAllCustomers, setCustomerNotifications, testCredential, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { asaasPhoneForContact, daysOverdue, groupDuplicateCustomers, normalizeEmail, type DuplicateGroup } from '@/lib/asaas/match'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { resolveCollectionTargets, WHATSAPP_PROVIDERS } from '@/lib/collections/outreach'
import { createChargeForContact } from '@/lib/collections/emit'
import { changeChargeDueDateCore } from '@/lib/collections/due-date'
import { manualChargeMessage, parseDueDate, parseValue, validateEmit } from '@/lib/collections/emit-rules'
import { postInternalNote } from '@/lib/ai/close-actions'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { syncAccount, syncConnection, type SyncResult } from '@/lib/asaas/sync'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { randomBytes } from 'node:crypto'

export interface ActionResult<T = unknown> {
  ok: boolean
  error?: string
  data?: T
}

// ------------------------------------------------------------------ conexões

export interface ConnectionView {
  id: string
  label: string
  environment: AsaasEnv
  enabled: boolean
  /** Só o fim da chave, para o cliente reconhecer qual conta é. */
  keyHint: string
  lastSyncAt: string | null
  lastSyncError: string | null
  lastSyncCount: number
  openCharges: number
  /** URL para colar no Asaas (Fase 4). Uma por conexão. */
  webhookUrl: string | null
  /** Último evento recebido — prova que a URL foi mesmo colada lá. */
  webhookLastAt: string | null
  /** Item 5: clientes duplicados no Asaas (mesmo CPF/telefone/e-mail), da última verificação. */
  duplicatesReport: DuplicateGroup[]
  duplicatesCheckedAt: string | null
  /** Quando os avisos do Asaas foram desligados em massa por aqui. */
  notificationsOffAt: string | null
  webhookEvents: number
}

export async function listConnections(): Promise<ConnectionView[]> {
  const { accountId } = await getCurrentAccount()

  const rows = await db
    .select({
      id: asaasConnections.id,
      label: asaasConnections.label,
      environment: asaasConnections.environment,
      enabled: asaasConnections.enabled,
      lastSyncAt: asaasConnections.lastSyncAt,
      lastSyncError: asaasConnections.lastSyncError,
      lastSyncCount: asaasConnections.lastSyncCount,
      webhookToken: asaasConnections.webhookToken,
      webhookLastAt: asaasConnections.webhookLastAt,
      webhookEvents: asaasConnections.webhookEvents,
      duplicatesReport: asaasConnections.duplicatesReport,
      duplicatesCheckedAt: asaasConnections.duplicatesCheckedAt,
      notificationsOffAt: asaasConnections.notificationsOffAt,
      openCharges: sql<number>`(
        SELECT count(*)::int FROM asaas_charges c
        WHERE c.connection_id = ${asaasConnections.id} AND c.open
      )`,
    })
    .from(asaasConnections)
    .where(eq(asaasConnections.accountId, accountId))
    .orderBy(asaasConnections.label)

  // APP_URL está vazio em produção; BETTER_AUTH_URL é o que realmente carrega o
  // domínio. O último recurso repete o padrão usado no resto do projeto.
  const base = (process.env.APP_URL || process.env.BETTER_AUTH_URL || 'https://crm.salestecnologia.com.br').replace(
    /\/+$/,
    '',
  )
  return rows.map(({ webhookToken, ...r }) => ({
    ...r,
    environment: r.environment as AsaasEnv,
    duplicatesReport: (r.duplicatesReport ?? []) as DuplicateGroup[],
    // A chave nunca sai daqui; o cliente identifica a conta pelo rótulo.
    keyHint: '••••',
    // O token só sai dentro da URL que ele vai colar no Asaas — é o uso dele.
    webhookUrl: webhookToken ? `${base}/api/webhooks/asaas-cobranca/${webhookToken}` : null,
  }))
}

export async function saveConnection(input: {
  label: string
  apiKey: string
  environment: AsaasEnv
}): Promise<ActionResult<{ id: string }>> {
  const { accountId } = await requireRole('admin')

  const label = input.label.trim()
  const apiKey = input.apiKey.trim()
  if (!label) return { ok: false, error: 'Dê um nome para esta conta (ex.: "Minha conta", "Conta do pai").' }
  if (!apiKey) return { ok: false, error: 'Cole a chave de API do Asaas.' }
  if (input.environment !== 'sandbox' && input.environment !== 'production') {
    return { ok: false, error: 'Ambiente inválido.' }
  }

  // Conferimos a chave ANTES de salvar: melhor recusar aqui do que guardar uma
  // credencial que só vai falhar na primeira sincronização.
  const test = await testCredential({ apiKey, environment: input.environment })
  if (!test.ok) return { ok: false, error: test.error }

  const dup = await db
    .select({ id: asaasConnections.id })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, accountId), sql`lower(${asaasConnections.label}) = ${label.toLowerCase()}`))
    .limit(1)
  if (dup.length) return { ok: false, error: `Já existe uma conta chamada "${label}".` }

  const [row] = await db
    .insert(asaasConnections)
    .values({
      accountId,
      label,
      apiKeyEnc: encrypt(apiKey),
      environment: input.environment,
      // 🧾 Fase 4: cada conexão nasce com o próprio segredo de webhook.
      webhookToken: randomBytes(24).toString('hex'),
    })
    .returning({ id: asaasConnections.id })

  revalidatePath('/cobrancas')
  return { ok: true, data: { id: row.id } }
}

export async function setConnectionEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const { accountId } = await requireRole('admin')
  await db
    .update(asaasConnections)
    .set({ enabled, updatedAt: new Date().toISOString() })
    .where(and(eq(asaasConnections.id, id), eq(asaasConnections.accountId, accountId)))
  revalidatePath('/cobrancas')
  return { ok: true }
}

export async function removeConnection(id: string): Promise<ActionResult> {
  const { accountId } = await requireRole('admin')
  const [conn] = await db
    .select({ label: asaasConnections.label })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.id, id), eq(asaasConnections.accountId, accountId)))
    .limit(1)
  if (!conn) return { ok: false, error: 'Conta não encontrada.' }

  // As cobranças espelhadas dessa conexão saem junto (ON DELETE CASCADE); nada
  // é tocado no Asaas.
  await db.delete(asaasConnections).where(and(eq(asaasConnections.id, id), eq(asaasConnections.accountId, accountId)))
  revalidatePath('/cobrancas')
  return { ok: true }
}

// ----------------------------------------------------------- sincronização

export async function syncNow(connectionId?: string): Promise<ActionResult<SyncResult>> {
  const { accountId } = await requireRole('supervisor')
  // Usa os status que a conta escolheu — o botão "Atualizar" ignorava isso e
  // sempre pedia só OVERDUE (achado 04/09, carteira do Alex vinha vazia).
  const { overdueStatuses } = normalizeSettings((await getAccountSettings(accountId)).collections)
  const res = connectionId
    ? await syncConnection(accountId, connectionId, overdueStatuses)
    : await syncAccount(accountId, overdueStatuses)
  revalidatePath('/cobrancas')
  return res.ok ? { ok: true, data: res } : { ok: false, error: res.error, data: res }
}

// --------------------------------------------------------------- a carteira

export interface WalletCharge {
  id: string
  asaasId: string
  value: string
  dueDate: string | null
  daysLate: number | null
  status: string
  description: string | null
  invoiceUrl: string | null
  connectionLabel: string
  /** Conta do Asaas de onde veio — a carteira filtra por ela (09/09, GoLink com 2 contas). */
  connectionId: string
  /** Cadastro do Asaas de onde veio (detector de duplicata). */
  asaasCustomerId: string | null
}

export interface WalletDebtor {
  key: string
  name: string
  phone: string | null
  email: string | null
  cpfCnpj: string | null
  contactId: string | null
  matchedBy: string | null
  total: number
  oldestDaysLate: number | null
  charges: WalletCharge[]
  /** Estado da régua neste devedor (só existe quando casou com um contato). */
  paused: boolean
  pausedReason: string | null
  snoozeReason: string | null
  touchCount: number
  lastTouchAt: string | null
  snoozeUntil: string | null
  /** Parcela idêntica em dois cadastros do Asaas — a régua não cobra até resolver. */
  duplicateSuspect: boolean
}

/** Lacuna 4 (07/09): o que entrou depois que a régua falou — o gancho em reais. */
export interface RecoveredSummary {
  days: number
  /** Cobranças pagas no período (todas as que passaram pela carteira). */
  paidCount: number
  paidTotal: number
  /** Pagas DEPOIS de uma mensagem da régua (ou criadas pelo CRM): influência, não causalidade. */
  afterTouchCount: number
  afterTouchTotal: number
}

export interface WalletSummary {
  debtors: WalletDebtor[]
  totalValue: number
  totalCharges: number
  pendingMatch: number
  recovered: RecoveredSummary
}

/**
 * A carteira agrupada por DEVEDOR, não por cobrança — porque é assim que a
 * Fase 2 vai cobrar: uma mensagem por pessoa, com as parcelas dela juntas.
 * Ver a tela já nesse formato mostra hoje o que vai sair depois.
 */
export async function getWallet(): Promise<WalletSummary> {
  const { accountId } = await getCurrentAccount()

  const rows = await db
    .select({
      id: asaasCharges.id,
      asaasId: asaasCharges.asaasId,
      customerName: asaasCharges.customerName,
      cpfCnpj: asaasCharges.cpfCnpj,
      phone: asaasCharges.phone,
      email: asaasCharges.email,
      value: asaasCharges.value,
      dueDate: asaasCharges.dueDate,
      status: asaasCharges.status,
      description: asaasCharges.description,
      invoiceUrl: asaasCharges.invoiceUrl,
      contactId: asaasCharges.contactId,
      matchedBy: asaasCharges.matchedBy,
      asaasCustomerId: asaasCharges.asaasCustomerId,
      connectionLabel: asaasConnections.label,
      connectionId: asaasCharges.connectionId,
      contactName: contacts.name,
      paused: collectionsTouches.paused,
      pausedReason: collectionsTouches.pausedReason,
      touchCount: collectionsTouches.touchCount,
      lastTouchAt: collectionsTouches.lastTouchAt,
      snoozeUntil: collectionsTouches.snoozeUntil,
      snoozeReason: collectionsTouches.snoozeReason,
    })
    .from(asaasCharges)
    .innerJoin(asaasConnections, eq(asaasConnections.id, asaasCharges.connectionId))
    .leftJoin(contacts, eq(contacts.id, asaasCharges.contactId))
    .leftJoin(
      collectionsTouches,
      and(eq(collectionsTouches.accountId, asaasCharges.accountId), eq(collectionsTouches.contactId, asaasCharges.contactId)),
    )
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true)))
    .orderBy(asaasCharges.dueDate)

  const byDebtor = new Map<string, WalletDebtor>()
  let totalValue = 0

  for (const r of rows) {
    const key = r.asaasCustomerId ?? r.cpfCnpj ?? r.asaasId
    const late = daysOverdue(r.dueDate)
    const value = Number(r.value ?? 0)
    totalValue += value

    let d = byDebtor.get(key)
    if (!d) {
      d = {
        key,
        name: r.contactName || r.customerName || 'Sem nome',
        phone: r.phone,
        email: r.email,
        cpfCnpj: r.cpfCnpj,
        contactId: r.contactId,
        matchedBy: r.matchedBy,
        total: 0,
        oldestDaysLate: null,
        charges: [],
        paused: r.paused ?? false,
        pausedReason: r.pausedReason,
        touchCount: r.touchCount ?? 0,
        lastTouchAt: r.lastTouchAt,
        snoozeUntil: r.snoozeUntil,
        snoozeReason: r.snoozeReason,
        duplicateSuspect: false,
      }
      byDebtor.set(key, d)
    }
    d.total += value
    if (late != null && (d.oldestDaysLate == null || late > d.oldestDaysLate)) d.oldestDaysLate = late
    d.charges.push({
      id: r.id,
      asaasId: r.asaasId,
      value: r.value,
      dueDate: r.dueDate,
      daysLate: late,
      status: r.status,
      description: r.description,
      invoiceUrl: r.invoiceUrl,
      connectionLabel: r.connectionLabel,
      connectionId: r.connectionId,
      asaasCustomerId: r.asaasCustomerId,
    })
  }

  // Parcela idêntica em dois cadastros do Asaas (Renato ×3): a tela avisa e a
  // régua não cobra até resolver lá.
  for (const d of byDebtor.values()) {
    d.duplicateSuspect = duplicateSuspects(
      d.charges.map((c) => ({ customerId: c.asaasCustomerId, value: Number(c.value), dueDate: c.dueDate })),
    )
  }

  const debtors = [...byDebtor.values()].sort((a, b) => (b.oldestDaysLate ?? -1) - (a.oldestDaysLate ?? -1))

  return {
    debtors,
    totalValue,
    totalCharges: rows.length,
    pendingMatch: debtors.filter((d) => !d.contactId).length,
    recovered: await recoveredSummary(accountId, 30),
  }
}

/**
 * Quanto entrou nos últimos N dias e quanto disso veio DEPOIS de uma mensagem
 * da régua (ou de cobrança criada pelo CRM). É influência, não causalidade —
 * mas é o número que o cliente consegue medir em reais.
 */
async function recoveredSummary(accountId: string, days: number): Promise<RecoveredSummary> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const paid = await db
    .select({
      value: asaasCharges.value,
      closedAt: asaasCharges.closedAt,
      origin: asaasCharges.origin,
      lastTouchAt: collectionsTouches.lastTouchAt,
    })
    .from(asaasCharges)
    .leftJoin(
      collectionsTouches,
      and(eq(collectionsTouches.accountId, asaasCharges.accountId), eq(collectionsTouches.contactId, asaasCharges.contactId)),
    )
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.open, false),
        inArray(asaasCharges.status, ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']),
        sql`${asaasCharges.closedAt} >= ${since}`,
      ),
    )
  const out: RecoveredSummary = { days, paidCount: 0, paidTotal: 0, afterTouchCount: 0, afterTouchTotal: 0 }
  for (const p of paid) {
    const v = Number(p.value ?? 0)
    out.paidCount += 1
    out.paidTotal += v
    const touchedBefore = !!p.lastTouchAt && !!p.closedAt && new Date(p.lastTouchAt).getTime() <= new Date(p.closedAt).getTime()
    if (touchedBefore || p.origin === 'ai' || p.origin === 'manual') {
      out.afterTouchCount += 1
      out.afterTouchTotal += v
    }
  }
  return out
}

/**
 * Lacuna 3 (07/09): mover o vencimento de uma cobrança no Asaas pela tela.
 * Aceita "10/09", "dia 10", "+7" ou 2026-09-10. A régua dorme até a nova data.
 */
export async function changeChargeDueDate(chargeId: string, dueDateRaw: string): Promise<ActionResult<{ dueDate: string; invoiceUrl: string | null }>> {
  const { accountId, userId } = await requireRole('agent')
  const dueDate = parseDueDate(dueDateRaw)
  if (!dueDate) return { ok: false, error: 'Data inválida. Exemplo: 10/09, "dia 10" ou +7.' }
  const who = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))
  const r = await changeChargeDueDateCore({ accountId, chargeId, dueDate, actor: who?.name ? `por ${who.name}` : 'pela equipe' })
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath('/cobrancas')
  return { ok: true, data: { dueDate: r.dueDate, invoiceUrl: r.invoiceUrl } }
}

// ------------------------------------------------------ casamento na mão

export interface ContactOption {
  id: string
  name: string
  phone: string
  email: string | null
}

/** Busca contatos para resolver uma pendência de casamento na mão. */
export async function searchContactsForCharge(query: string): Promise<ContactOption[]> {
  const { accountId } = await getCurrentAccount()
  const q = query.trim()
  if (q.length < 2) return []

  const rows = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        eq(contacts.isGroup, false),
        or(
          ilike(contacts.name, `%${q}%`),
          ilike(contacts.phone, `%${q.replace(/\D/g, '')}%`),
          ilike(contacts.email, `%${q}%`),
        ),
      ),
    )
    .limit(20)

  return rows.map((r) => ({ id: r.id, name: r.name ?? r.phone, phone: r.phone, email: r.email }))
}

/**
 * Liga todas as cobranças em aberto de um devedor a um contato do CRM.
 * Fica marcado como `manual`, e a sincronização seguinte não sobrescreve — quem
 * corrigiu na tela sabia mais do que a heurística.
 */
export async function linkDebtorToContact(debtorKey: string, contactId: string): Promise<ActionResult<{ linked: number }>> {
  const { accountId } = await requireRole('agent')

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
    .limit(1)
  if (!contact) return { ok: false, error: 'Contato não encontrado nesta conta.' }

  const updated = await db
    .update(asaasCharges)
    .set({ contactId, matchedBy: 'manual', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.open, true),
        or(eq(asaasCharges.asaasCustomerId, debtorKey), eq(asaasCharges.cpfCnpj, debtorKey), eq(asaasCharges.asaasId, debtorKey)),
      ),
    )
    .returning({ id: asaasCharges.id })

  if (!updated.length) return { ok: false, error: 'Nenhuma cobrança em aberto para este devedor.' }

  revalidatePath('/cobrancas')
  return { ok: true, data: { linked: updated.length } }
}

/** Desfaz um casamento feito na mão (volta a ser pendência). */
export async function unlinkDebtor(debtorKey: string): Promise<ActionResult> {
  const { accountId } = await requireRole('agent')
  await db
    .update(asaasCharges)
    .set({ contactId: null, matchedBy: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.open, true),
        or(eq(asaasCharges.asaasCustomerId, debtorKey), eq(asaasCharges.cpfCnpj, debtorKey), eq(asaasCharges.asaasId, debtorKey)),
      ),
    )
  revalidatePath('/cobrancas')
  return { ok: true }
}

/** Cobranças que saíram da carteira desde a última rodada (pagas/apagadas). */
export async function listRecentlyClosed(limit = 20) {
  const { accountId } = await getCurrentAccount()
  return db
    .select({
      id: asaasCharges.id,
      customerName: asaasCharges.customerName,
      value: asaasCharges.value,
      dueDate: asaasCharges.dueDate,
      closedAt: asaasCharges.closedAt,
      connectionLabel: asaasConnections.label,
    })
    .from(asaasCharges)
    .innerJoin(asaasConnections, eq(asaasConnections.id, asaasCharges.connectionId))
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, false), sql`${asaasCharges.closedAt} IS NOT NULL`))
    .orderBy(desc(asaasCharges.closedAt))
    .limit(limit)
}

// ---------------------------------------------------------- régua (Fase 2)

/**
 * Configuração da régua. Vive em `account_settings.settings.collections`, e
 * não em código: é o que faz o segundo cliente não exigir reescrita.
 */
export async function getCollectionsSettings(): Promise<CollectionsSettings> {
  const { accountId } = await getCurrentAccount()
  const s = await getAccountSettings(accountId)
  return normalizeSettings(s.collections)
}

export async function saveCollectionsSettings(input: Partial<CollectionsSettings>): Promise<ActionResult<CollectionsSettings>> {
  const { accountId } = await requireRole('admin')
  const current = normalizeSettings((await getAccountSettings(accountId)).collections)
  const next = normalizeSettings({ ...current, ...input })

  if (next.endHour <= next.startHour) {
    return { ok: false, error: 'A janela de cobrança precisa terminar depois de começar.' }
  }

  // Ligar a régua sem ter o que ler só produziria uma fila vazia e a impressão
  // de que não funciona.
  if (next.enabled && !current.enabled) {
    const conn = await db
      .select({ id: asaasConnections.id })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))
      .limit(1)
    if (!conn.length) return { ok: false, error: 'Conecte uma conta do Asaas antes de ligar a régua.' }
  }

  await updateAccountSettings(accountId, { collections: next })
  revalidatePath('/cobrancas')
  return { ok: true, data: next }
}

/** Roda a régua agora (sem esperar o tique) e conta o que entrou na fila. */
export async function runCollectionsNow(): Promise<ActionResult<{ queued: number; debtors: number; halted?: string }>> {
  const { accountId } = await requireRole('supervisor')
  const r = await runCollectionsForAccount(accountId)
  revalidatePath('/cobrancas')
  revalidatePath('/aprovacoes')
  if (r.haltedBecause) return { ok: false, error: r.haltedBecause, data: { queued: 0, debtors: r.debtors, halted: r.haltedBecause } }
  return { ok: true, data: { queued: r.queued, debtors: r.debtors } }
}

/** Pausa/retoma a régua num devedor (acordo em andamento, caso jurídico…). */
// ------------------------------------------------- promessa de pagamento (10/09)
// O cliente disse "pago dia 15" — para o Leonardo (ou quem atende), por
// telefone ou num áudio que a IA não leu. Mesmo efeito do marcador da IA:
// a régua dorme até a data (+1 dia de folga) e, se "mover vencimento" estiver
// ligado em Ajustar, o boleto no Asaas vai junto. Nota interna na conversa.

export async function registerPaymentPromise(input: {
  contactId: string
  /** "15/09", "dia 15", "+5" ou 2026-09-15 */
  dateRaw: string
  note?: string | null
  conversationId?: string | null
}): Promise<ActionResult<{ until: string }>> {
  const { accountId, userId } = await requireRole('agent')
  const c = firstOrNull(
    await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, accountId))).limit(1),
  )
  if (!c) return { ok: false, error: 'Contato não encontrado nesta conta.' }
  const date = parseDueDate(input.dateRaw)
  if (!date) return { ok: false, error: 'Data inválida. Exemplo: 15/09, "dia 15" ou +5.' }

  const { applyCollectionReply } = await import('@/lib/collections/reply')
  const r = await applyCollectionReply({ accountId, contactId: c.id, conversationId: input.conversationId ?? null, kind: 'promessa', date })
  if (!r.applied) return { ok: false, error: 'Este contato não tem cobrança em aberto na carteira.' }

  const who = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))
  const extra = (input.note ?? '').trim()
  const reason = `Prometeu pagar em ${date.split('-').reverse().join('/')} — registrado por ${who?.name ?? 'alguém da equipe'}${extra ? `: ${extra}` : ''}`
  const touch = firstOrNull(
    await db
      .select({ until: collectionsTouches.snoozeUntil })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, c.id)))
      .limit(1),
  )
  await db
    .update(collectionsTouches)
    .set({ snoozeReason: reason, updatedAt: new Date().toISOString() })
    .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, c.id)))

  // Nota na conversa (a informada ou a mais recente do contato).
  const convId =
    input.conversationId ??
    firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, c.id)))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1),
    )?.id ??
    null
  if (convId) await postInternalNote({ conversationId: convId, text: `${r.note} (${reason})` })

  revalidatePath('/cobrancas')
  return { ok: true, data: { until: touch?.until ?? date } }
}

/** "Cobrar agora": tira a promessa e a régua volta a valer no próximo ciclo. */
export async function clearPaymentPromise(contactId: string): Promise<ActionResult> {
  const { accountId } = await requireRole('agent')
  const now = new Date().toISOString()
  await db
    .update(collectionsTouches)
    .set({ snoozeUntil: null, snoozeReason: null, updatedAt: now })
    .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
  revalidatePath('/cobrancas')
  return { ok: true }
}

export interface ContactCollectionStatus {
  openCount: number
  total: number
  oldestDaysLate: number | null
  snoozeUntil: string | null
  snoozeReason: string | null
  paused: boolean
  pausedReason: string | null
  lastTouchAt: string | null
  touchCount: number
}

/** Situação de cobrança de UM contato — a lateral da conversa mostra e age. */
export async function getContactCollectionStatus(contactId: string): Promise<ContactCollectionStatus | null> {
  const { accountId } = await getCurrentAccount()
  const rows = await db
    .select({ value: asaasCharges.value, dueDate: asaasCharges.dueDate })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), eq(asaasCharges.open, true)))
  if (!rows.length) return null
  const today = new Date()
  let oldest: number | null = null
  for (const r of rows) {
    if (!r.dueDate) continue
    const d = Math.floor((today.getTime() - new Date(`${r.dueDate}T12:00:00Z`).getTime()) / 86_400_000)
    if (oldest == null || d > oldest) oldest = d
  }
  const t = firstOrNull(
    await db
      .select({
        snoozeUntil: collectionsTouches.snoozeUntil,
        snoozeReason: collectionsTouches.snoozeReason,
        paused: collectionsTouches.paused,
        pausedReason: collectionsTouches.pausedReason,
        lastTouchAt: collectionsTouches.lastTouchAt,
        touchCount: collectionsTouches.touchCount,
      })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
      .limit(1),
  )
  return {
    openCount: rows.length,
    total: rows.reduce((s, r) => s + (Number(r.value) || 0), 0),
    oldestDaysLate: oldest,
    snoozeUntil: t?.snoozeUntil ?? null,
    snoozeReason: t?.snoozeReason ?? null,
    paused: t?.paused ?? false,
    pausedReason: t?.pausedReason ?? null,
    lastTouchAt: t?.lastTouchAt ?? null,
    touchCount: t?.touchCount ?? 0,
  }
}

export async function setDebtorPaused(contactId: string, paused: boolean, reason: string | null): Promise<ActionResult> {
  const { accountId, userId } = await requireRole('agent')

  const [c] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
    .limit(1)
  if (!c) return { ok: false, error: 'Contato não encontrado nesta conta.' }

  const now = new Date().toISOString()
  await db
    .insert(collectionsTouches)
    .values({ accountId, contactId, paused, pausedReason: reason, pausedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: [collectionsTouches.accountId, collectionsTouches.contactId],
      set: { paused, pausedReason: reason, pausedBy: userId, updatedAt: now },
    })
  revalidatePath('/cobrancas')
  return { ok: true }
}

// ------------------------------------------------- Fase 5: portão de promoção

export interface PromotionView {
  verdict: PromotionVerdict
  headline: string
  /** Nível atual da ação de cobrança: suggest | approve | auto. */
  level: string
  /** Já está no automático? */
  isAuto: boolean
}

/**
 * O histórico REAL de decisões humanas sobre cobrança nesta conta.
 * `decision_feedback` (migr 0156) é a fonte: aprovado / editado / recusado /
 * revertido / resultado ruim, com data.
 */
export async function getCollectionsPromotion(): Promise<PromotionView> {
  const { accountId } = await getCurrentAccount()

  const rows = await db
    .select({ decision: decisionFeedback.decision, createdAt: decisionFeedback.createdAt })
    .from(decisionFeedback)
    .where(and(eq(decisionFeedback.accountId, accountId), eq(decisionFeedback.actionType, 'collect_charges')))
    .orderBy(decisionFeedback.createdAt)

  const agent = await db
    .select({ autonomy: aiConfigs.autonomy })
    .from(aiConfigs)
    .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
    .limit(1)
  const autonomy = agent[0]?.autonomy ?? null
  // Mesmo critério do painel Validação da autonomia (override da conta;
  // cobrança nunca tolera reversão). Reversão conta como erro, não como decisão.
  const verdict = evaluatePromotion(statsFromFeedback(rows), criteriaFor('collect_charges', readPromotionOverride(autonomy)), { noun: 'cobrança' })
  const level = levelFor(readPolicy(autonomy), 'collect_charges')

  return { verdict, headline: promotionHeadline(verdict), level, isAuto: level === 'auto' }
}

/**
 * Libera (ou recolhe) o automático da cobrança.
 *
 * Recusa liberar sem histórico: o portão existe para a decisão ser por
 * evidência e não por vontade. Voltar para aprovação, sim, é sempre imediato —
 * recolher autonomia nunca pode ter atrito.
 */
export async function setCollectionsAutonomy(auto: boolean): Promise<ActionResult<{ level: string }>> {
  const { accountId } = await requireRole('admin')

  if (auto) {
    const { verdict } = await getCollectionsPromotion()
    if (!verdict.ready) {
      return { ok: false, error: verdict.blockers[0]?.label ?? 'A régua ainda não tem histórico para operar sozinha.' }
    }
  }

  const [agent] = await db
    .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy })
    .from(aiConfigs)
    .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
    .limit(1)
  if (!agent) return { ok: false, error: 'Nenhum agente padrão configurado nesta conta.' }

  const current = (agent.autonomy ?? {}) as Record<string, unknown>
  const actions = { ...((current.actions as Record<string, string>) ?? {}), collect_charges: auto ? 'auto' : 'approve' }

  await db
    .update(aiConfigs)
    .set({ autonomy: { ...current, actions } })
    .where(eq(aiConfigs.id, agent.id))

  revalidatePath('/cobrancas')
  revalidatePath('/aprovacoes')
  return { ok: true, data: { level: auto ? 'auto' : 'approve' } }
}

// ------------------------------------ contato a partir do Asaas (gap nº1, 05/09)
// Devedor que não casou com ninguém ficava parado em "sem contato" e só dava
// para ESCOLHER um contato existente. Numa carteira nova, a maioria não existe
// no CRM ainda — criar a partir do que o Asaas já sabe é o caminho normal.

export interface CreatedFromAsaas {
  contactId: string
  /** true = contato novo; false = já existia um com esse telefone e foi ligado a ele. */
  created: boolean
  linked: number
}

function debtorFilter(debtorKey: string) {
  return or(eq(asaasCharges.asaasCustomerId, debtorKey), eq(asaasCharges.cpfCnpj, debtorKey), eq(asaasCharges.asaasId, debtorKey))
}

async function createAndLink(accountId: string, userId: string, debtorKey: string): Promise<ActionResult<CreatedFromAsaas>> {
  const src = firstOrNull(
    await db
      .select({ name: asaasCharges.customerName, phone: asaasCharges.phone, email: asaasCharges.email })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), isNull(asaasCharges.contactId), debtorFilter(debtorKey)))
      .limit(1),
  )
  if (!src) return { ok: false, error: 'Nenhuma cobrança pendente para este devedor.' }

  const phone = asaasPhoneForContact(src.phone)
  const email = normalizeEmail(src.email)
  if (!phone && !email) {
    return { ok: false, error: 'Este devedor não tem telefone válido nem e-mail no Asaas. Cadastre o contato na mão e ligue aqui.' }
  }

  let found: { id: string; created: boolean }
  try {
    if (phone) {
      // Mesma trava anti-duplicado do inbound e da API: telefone já existente
      // (com ou sem 55, com ou sem 9º dígito) reaproveita o contato em vez de
      // criar um segundo.
      found = await findOrCreateContact(accountId, userId, {
        phone,
        name: src.name?.trim() || null,
        email: email || null,
      })
    } else {
      // Só e-mail: mesmo formato do inbound de e-mail (phone vazio, índice único
      // de telefone é parcial). Reaproveita quem já tem esse e-mail na conta.
      const existing = firstOrNull(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.accountId, accountId), sql`lower(${contacts.email}) = ${email}`))
          .limit(1),
      )
      if (existing) found = { id: existing.id, created: false }
      else {
        const inserted = firstOrNull(
          await db
            .insert(contacts)
            .values({ accountId, userId, phone: '', name: src.name?.trim() || email, email })
            .returning({ id: contacts.id }),
        )
        if (!inserted) return { ok: false, error: 'Não foi possível criar o contato.' }
        found = { id: inserted.id, created: true }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Não foi possível criar o contato.' }
  }

  const linked = await db
    .update(asaasCharges)
    .set({ contactId: found.id, matchedBy: 'manual', updatedAt: new Date().toISOString() })
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), debtorFilter(debtorKey)))
    .returning({ id: asaasCharges.id })

  return { ok: true, data: { contactId: found.id, created: found.created, linked: linked.length } }
}

/** Cria (ou reencontra) o contato com nome/telefone/e-mail do Asaas e liga as cobranças dele. */
export async function createContactForDebtor(debtorKey: string): Promise<ActionResult<CreatedFromAsaas>> {
  const { accountId, userId } = await requireRole('agent')
  const res = await createAndLink(accountId, userId, debtorKey)
  if (res.ok) revalidatePath('/cobrancas')
  return res
}

export interface BulkCreateResult {
  created: number
  linked: number
  skipped: { name: string; reason: string }[]
}

/** O mesmo, para todas as pendências de uma vez. Quem não tem telefone fica listado, não some. */
export async function createContactsForPendingDebtors(): Promise<ActionResult<BulkCreateResult>> {
  const { accountId, userId } = await requireRole('agent')
  const wallet = await getWallet()
  const out: BulkCreateResult = { created: 0, linked: 0, skipped: [] }
  for (const d of wallet.debtors.filter((x) => !x.contactId)) {
    const res = await createAndLink(accountId, userId, d.key)
    if (!res.ok) out.skipped.push({ name: d.name, reason: res.error ?? 'falhou' })
    else if (res.data!.created) out.created += 1
    else out.linked += 1
  }
  revalidatePath('/cobrancas')
  return { ok: true, data: out }
}

// ---------------------------------------------- número que envia a cobrança

export interface CollectionChannelOption {
  id: string
  name: string
  phone: string | null
  connected: boolean
}

/** Números de WhatsApp da conta, para escolher qual envia as cobranças. */
export interface CollectionAssigneeOption {
  id: string
  name: string
  role: string
}

/** Membros da conta pra "Quem cuida das respostas" (Ajustar). Viewer não atende. */
export async function listCollectionAssignees(): Promise<CollectionAssigneeOption[]> {
  const { accountId } = await getCurrentAccount()
  const rows = await db
    .select({ id: user.id, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, accountId))
    .orderBy(user.name)
  return rows.filter((r) => r.role !== 'viewer').map((r) => ({ id: r.id, name: r.name ?? '', role: r.role }))
}

export interface CollectionSectorOption {
  id: string
  name: string
}

/** Setores da conta pra "Setor das conversas de cobrança" (Ajustar). */
export async function listCollectionSectors(): Promise<CollectionSectorOption[]> {
  const { accountId } = await getCurrentAccount()
  const { sectors } = await import('@/db')
  const rows = await db.select({ id: sectors.id, name: sectors.name }).from(sectors).where(eq(sectors.accountId, accountId)).orderBy(sectors.name)
  return rows.map((r) => ({ id: r.id, name: r.name }))
}

export async function listCollectionChannels(): Promise<CollectionChannelOption[]> {
  const { accountId } = await getCurrentAccount()
  const rows = await db
    .select({ id: channels.id, name: channels.name, phone: channels.phoneNumber, status: channels.status })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...WHATSAPP_PROVIDERS])))
    .orderBy(channels.name)
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, connected: r.status === 'connected' }))
}

// ------------------------------------------------ nova cobrança à mão (item 4)
// O operador gera a cobrança no Asaas pelo CRM (contato, valor, vencimento,
// descrição, conta) e, se quiser, o link já vai na conversa. É o "cria uma
// cobrança de tanto pro fulano" do João/GoLink — sem depender da IA.

export interface ManualChargeInput {
  contactId: string
  /** Conta do Asaas; null = a primeira ligada. */
  connectionId: string | null
  valueRaw: string
  /** YYYY-MM-DD */
  dueDate: string
  description: string
  /** Mandar o link na conversa (abre a conversa se não existir). */
  sendLink: boolean
  /** Forma de pagamento: UNDEFINED = cliente escolhe (padrão), PIX, BOLETO, CREDIT_CARD. */
  billingType?: 'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD'
  /** CPF/CNPJ do cliente, se o cadastro não tiver (Asaas de produção exige). */
  cpfCnpj?: string
}

export interface ManualChargeResult {
  invoiceUrl: string
  /** Já existia uma igual aberta, criada há pouco — link reaproveitado. */
  reused: boolean
  /** "WhatsApp", "e-mail", "WhatsApp e e-mail" ou null quando não enviou. */
  sentVia: string | null
  sendError: string | null
  connectionLabel: string
}

export async function createChargeManual(input: ManualChargeInput): Promise<ActionResult<ManualChargeResult>> {
  const { accountId, userId } = await requireRole('agent')

  const value = parseValue(input.valueRaw)
  if (!value) return { ok: false, error: 'Valor inválido. Exemplo: 125,00' }
  const dueDate = parseDueDate(input.dueDate)
  const description = input.description.trim()
  // Sem teto: quem decide é gente. Vencimento até 1 ano.
  const verdict = validateEmit({ value, dueDate, description }, { maxValue: Number.MAX_SAFE_INTEGER, maxDueDays: 365 })
  if (!verdict.ok) return { ok: false, error: `Não dá para gerar: ${verdict.reason}.` }

  const contact = firstOrNull(
    await db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { ok: false, error: 'Contato não encontrado.' }

  // Por onde o link vai — decidido ANTES de criar: se não dá para enviar, o
  // operador escolhe desmarcar o envio, em vez de ficar com cobrança criada e
  // link parado.
  let targets: Awaited<ReturnType<typeof resolveCollectionTargets>> | null = null
  if (input.sendLink) {
    targets = await resolveCollectionTargets(accountId, input.contactId, null)
    if (!targets.ok) {
      return { ok: false, error: `Não dá para enviar o link: ${targets.error}. Desmarque "mandar o link" para só gerar a cobrança.` }
    }
  }
  let conversationId: string | null = targets?.ok ? (targets.whatsapp?.conversationId ?? targets.email?.conversationId ?? null) : null
  if (!conversationId) {
    const latest = firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, input.contactId)))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1),
    )
    conversationId = latest?.id ?? null
  }

  const who = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))
  const created = await createChargeForContact({
    accountId,
    contactId: input.contactId,
    conversationId,
    connectionId: input.connectionId,
    value,
    dueDate: dueDate!,
    description,
    origin: 'manual',
    actorLabel: `por ${who?.name?.trim() || 'alguém da equipe'}`,
    noteSuffix: targets?.ok ? `Link enviado por ${targets.label}.` : '',
    billingType: input.billingType && input.billingType !== 'UNDEFINED' ? input.billingType : undefined,
    cpfCnpj: (input.cpfCnpj ?? '').replace(/\D/g, '') || undefined,
  })
  if (!created.ok) return { ok: false, error: created.reason }

  let sentVia: string | null = null
  let sendError: string | null = null
  if (targets?.ok) {
    const firstName = (contact.name ?? '').trim().split(/\s+/)[0] || null
    const text = manualChargeMessage(firstName, value, dueDate!, description, created.invoiceUrl)
    const convIds = [targets.whatsapp?.conversationId, targets.email?.conversationId].filter((c): c is string => !!c)
    try {
      for (const cid of convIds) {
        await sendMessageToConversation(accountId, { conversationId: cid, messageType: 'text', contentText: text, subject: 'Link para pagamento' })
      }
      sentVia = targets.label
    } catch (err) {
      sendError = err instanceof Error ? err.message : 'falha ao enviar'
      if (conversationId) {
        await postInternalNote({
          conversationId,
          text: `⚠️ A cobrança foi criada, mas o link NÃO foi enviado (${sendError}). Mande você: ${created.invoiceUrl}`,
        }).catch(() => {})
      }
    }
  }

  revalidatePath('/cobrancas')
  return { ok: true, data: { invoiceUrl: created.invoiceUrl, reused: created.reused, sentVia, sendError, connectionLabel: created.connectionLabel } }
}

// ---------------------------------------------- item 5: avisos + duplicados

async function connectionCred(accountId: string, connectionId: string): Promise<{ id: string; label: string; cred: AsaasCredential } | null> {
  const row = firstOrNull(
    await db
      .select({ id: asaasConnections.id, label: asaasConnections.label, environment: asaasConnections.environment, apiKeyEnc: asaasConnections.apiKeyEnc })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.id, connectionId)))
      .limit(1),
  )
  if (!row) return null
  return { id: row.id, label: row.label, cred: { apiKey: decrypt(row.apiKeyEnc), environment: row.environment as AsaasEnv } }
}

export interface DuplicateCheckResult {
  groups: DuplicateGroup[]
  customers: number
  checkedAt: string
}

/**
 * Procura cadastros repetidos no Asaas (mesmo CPF/CNPJ, telefone ou e-mail).
 * Só mostra — apagar é decisão de gente, no Asaas. Caso Renato ×3 (05/09).
 */
export async function checkAsaasDuplicates(connectionId: string): Promise<ActionResult<DuplicateCheckResult>> {
  const { accountId } = await requireRole('supervisor')
  const c = await connectionCred(accountId, connectionId)
  if (!c) return { ok: false, error: 'Conexão não encontrada.' }
  try {
    const all = await listAllCustomers(c.cred)
    const groups = groupDuplicateCustomers(all)
    const now = new Date().toISOString()
    await db
      .update(asaasConnections)
      .set({ duplicatesReport: groups, duplicatesCheckedAt: now, updatedAt: now })
      .where(eq(asaasConnections.id, c.id))
    revalidatePath('/cobrancas')
    return { ok: true, data: { groups, customers: all.length, checkedAt: now } }
  } catch (err) {
    return { ok: false, error: err instanceof AsaasApiError ? err.message : 'Não foi possível ler os clientes do Asaas.' }
  }
}

export interface NotificationsBulkResult {
  changed: number
  alreadyDone: number
  failed: number
  total: number
  /** Ficaram por fazer (teto por rodada) — clicar de novo continua. */
  remaining: number
}

/** Teto por clique: o Asaas limita requisições por minuto; 400 já cobre a maioria das contas. */
const NOTIFICATIONS_BATCH = 400

/**
 * Desliga (ou religa) os avisos do Asaas de TODOS os clientes desta conta.
 * O cliente da Fluxia paga por envio lá; ligando a régua, o CRM é quem avisa.
 * Reversível: o mesmo botão religa.
 */
export async function setAsaasNotifications(connectionId: string, disabled: boolean): Promise<ActionResult<NotificationsBulkResult>> {
  const { accountId } = await requireRole('admin')
  const c = await connectionCred(accountId, connectionId)
  if (!c) return { ok: false, error: 'Conexão não encontrada.' }
  try {
    const all = await listAllCustomers(c.cred)
    const pending = all.filter((cu) => (cu.notificationDisabled === true) !== disabled)
    const batch = pending.slice(0, NOTIFICATIONS_BATCH)
    let changed = 0
    let failed = 0
    for (const cu of batch) {
      try {
        await setCustomerNotifications(c.cred, cu.id, disabled)
        changed++
      } catch (err) {
        failed++
        if (err instanceof AsaasApiError && err.status === 429) break
      }
    }
    const remaining = pending.length - changed
    const now = new Date().toISOString()
    await db
      .update(asaasConnections)
      .set({ notificationsOffAt: disabled ? (remaining === 0 ? now : null) : null, updatedAt: now })
      .where(eq(asaasConnections.id, c.id))
    revalidatePath('/cobrancas')
    return { ok: true, data: { changed, alreadyDone: all.length - pending.length, failed, total: all.length, remaining } }
  } catch (err) {
    return { ok: false, error: err instanceof AsaasApiError ? err.message : 'Não foi possível falar com o Asaas.' }
  }
}

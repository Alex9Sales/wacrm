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

import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  db,
  aiConfigs,
  asaasCharges,
  asaasConnections,
  asaasCustomerLinks,
  channels,
  collectionsTouches,
  collectionsUpcomingUnmatched,
  contacts,
  conversations,
  decisionFeedback,
  member,
  user,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { getAccountSettings, updateAccountSettings } from '@/lib/settings/account-settings'
import { runCollectionsForAccount } from '@/lib/collections/engine'
import { listChargesAtSilencing, markAsaasNotificationsSwept, recordSilenced } from '@/lib/collections/asaas-silenced'
import { countsAsOverdue, debtorHold, duplicateSuspects, greetingName, normalizeSettings, phoneSearchDigits, type CollectionsSettings } from '@/lib/collections/rules'
import { evaluatePromotion, promotionHeadline, type PromotionVerdict } from '@/lib/collections/promotion'
import { criteriaFor, readPromotionOverride, statsFromFeedback } from '@/lib/orchestration/validation'
import { levelFor, readPolicy } from '@/lib/orchestration/policy'
import { AsaasApiError, listAllCustomers, setCustomerNotifications, testCredential, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { asaasPhoneForContact, daysOverdue, groupDuplicateCustomers, normalizeEmail, type DuplicateGroup } from '@/lib/asaas/match'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { resolveCollectionTargets, WHATSAPP_PROVIDERS } from '@/lib/collections/outreach'
import { createChargeForContact, precheckChargeDocument, resolveChargeDocument } from '@/lib/collections/emit'
import { connectionHistoryFor, decideConnection, enabledConnectionsOf } from '@/lib/collections/connection-pick'
import { maskDocument } from '@/lib/collections/document'
import {
  accountRefusalText,
  MANUAL_DOCUMENT_REQUIRED_ERROR,
  MANUAL_INVALID_DOCUMENT_ERROR,
  type AccountHistoryView,
} from '@/lib/collections/charge-form'
import { changeChargeDueDateCore } from '@/lib/collections/due-date'
import { manualPromiseReasonPrefix } from '@/lib/collections/reply-guard'
import { localDayKey } from '@/lib/collections/stale'
import {
  canCreateFromAsaas,
  canRemoveCreatedContact,
  chargesChangedByLink,
  CREATE_AMBIGUOUS_ERROR,
  createProbeKeys,
  createRefusal,
  customerRefKey,
  isUuid,
  linkDeliveryInfo,
  linkMayMoveCharge,
  recentLinksSince,
  relinkCustomerName,
  restoreTarget,
  RECENT_LINKS_LIMIT,
  sameDocumentOthers,
  sanitizeChargeRestore,
  uniqueCustomerRefs,
  visibleUpcoming,
  type ChargeRestore,
  type DeliveryCheck,
  type DeliveryHold,
  type LinkDeliveryInfo,
  type UnmatchedCustomerRef,
  type UnmatchedPayment,
  type UnmatchedReason,
} from '@/lib/collections/upcoming-unmatched'
import { manualChargeMessage, parseDueDate, parseValue, validateEmit } from '@/lib/collections/emit-rules'
import { postInternalNote } from '@/lib/ai/close-actions'
import { numberHasWhatsApp } from '@/lib/whatsapp/number-exists'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { findContact, syncAccount, syncConnection, type SyncResult } from '@/lib/asaas/sync'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { randomBytes } from 'node:crypto'

export interface ActionResult<T = unknown> {
  ok: boolean
  error?: string
  data?: T
  /** Qual campo a tela destaca (15/09): falta o CPF/CNPJ ou o digitado é inválido.
   *  'phone_clash' (16/09): o número já é de outro contato — `clash` diz qual. */
  code?: 'needs_document' | 'invalid_document' | 'phone_clash'
  clash?: { id: string; name: string }
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
  // 10/09 (João/GoLink): "removi os duplicados no Asaas e cliquei em Atualizar,
  // mas continua acusando". O selo vinha de um relatório antigo — só o botão
  // "verificar de novo" refazia. Atualizar agora reconta também (best-effort:
  // falha aqui não derruba a sincronização).
  await refreshDuplicateReports(accountId, connectionId).catch(() => {})
  revalidatePath('/cobrancas')
  return res.ok ? { ok: true, data: res } : { ok: false, error: res.error, data: res }
}

/** Reconta os cadastros duplicados de cada conta do Asaas (ou só de uma). */
async function refreshDuplicateReports(accountId: string, connectionId?: string): Promise<void> {
  const conns = await db
    .select({ id: asaasConnections.id })
    .from(asaasConnections)
    .where(
      and(
        eq(asaasConnections.accountId, accountId),
        eq(asaasConnections.enabled, true),
        ...(connectionId ? [eq(asaasConnections.id, connectionId)] : []),
      ),
    )
  for (const c of conns) {
    const cred = await connectionCred(accountId, c.id)
    if (!cred) continue
    try {
      const all = await listAllCustomers(cred.cred)
      const groups = groupDuplicateCustomers(all)
      const now = new Date().toISOString()
      await db
        .update(asaasConnections)
        .set({ duplicatesReport: groups, duplicatesCheckedAt: now, updatedAt: now })
        .where(eq(asaasConnections.id, c.id))
    } catch (err) {
      console.warn(`[cobranca] recontar duplicados (${cred.label}) falhou: ${err instanceof Error ? err.message : err}`)
    }
  }
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
  /**
   * O cadastro do Asaas tem um celular DIFERENTE do que está na ficha do
   * contato — e é a ficha que manda no envio (11/09, João/GoLink: trocou o
   * telefone no Asaas e a cobrança continuou indo para o número antigo).
   * `null` quando batem, quando o Asaas não tem celular válido ou quando o
   * número do Asaas é fixo (aí não serve para WhatsApp e o aviso seria ruído).
   */
  phoneDiffers: { asaas: string; crm: string | null } | null
  /**
   * Nome do contato do CRM que está recebendo esta cobrança — para a tela poder
   * dizer PARA QUEM vai e abrir a ficha (11/09: o João ligou no contato errado e
   * não tinha como ver nem como voltar: "cliquei errado, como volto?").
   * `null` quando o contato não tem nome próprio (aí o cabeçalho usa o do Asaas).
   */
  contactName: string | null
  /** A ficha do contato ligado tem telefone? Sem ele a cobrança não sai por
   *  WhatsApp — só por e-mail (16/09, L&M Vidros: "2 cobranças enviadas", 1 só
   *  chegou no WhatsApp, e a tela não dizia). */
  contactHasPhone: boolean
}

/**
 * O contato do WhatsApp que nunca teve nome salvo vem com o próprio número no
 * lugar do nome. Mostrar isso como nome do devedor esconde de quem é a cobrança
 * (11/09: "Center Pisos Raspadora" aparecia como 5512991103109).
 */
function looksLikeBarePhone(name: string | null | undefined): boolean {
  const t = (name ?? '').trim()
  if (!t) return false
  const digits = t.replace(/\D/g, '')
  return digits.length >= 8 && digits.length === t.replace(/[\s()+-]/g, '').length
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
 * Celular do Asaas × telefone da ficha. Só aponta o que resolve alguma coisa:
 * precisa haver contato ligado, o número do Asaas precisa ser um CELULAR
 * válido (fixo não tem WhatsApp, avisar seria ruído) e ele tem que ser
 * realmente outro número — os últimos 8 dígitos decidem, para "com 9" e "sem
 * 9" não virarem falso alarme.
 */
function phoneDiff(
  asaasRaw: string | null,
  crmRaw: string | null,
  contactId: string | null,
): { asaas: string; crm: string | null } | null {
  if (!contactId) return null
  // Fixo TAMBÉM entra: o WhatsApp Business aceita número fixo, e o do cliente
  // da GoLink (12 3648-8533) respondeu `numberExists: true` no check-exists
  // (11/09). Quem decide se o número serve é o WhatsApp, na hora de adotar —
  // não o formato.
  const asaas = asaasPhoneForContact(asaasRaw)
  if (!asaas) return null
  const crmDigits = (crmRaw ?? '').replace(/\D/g, '')
  const tail = (d: string) => d.slice(-8)
  if (crmDigits && tail(crmDigits) === tail(asaas)) return null
  return { asaas, crm: crmDigits ? (crmRaw ?? '').trim() : null }
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
      contactPhone: contacts.phone,
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
        // Nome do Asaas vence o contato quando o contato só tem o número.
        name: (looksLikeBarePhone(r.contactName) ? r.customerName : r.contactName) || r.customerName || 'Sem nome',
        contactName: looksLikeBarePhone(r.contactName) ? null : (r.contactName ?? null),
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
        phoneDiffers: phoneDiff(r.phone, r.contactPhone, r.contactId),
        contactHasPhone: (r.contactPhone ?? '').replace(/\D/g, '').length >= 10,
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
  // régua não cobra até resolver lá. Calculado como a RÉGUA calcula — por
  // contato, juntando os cadastros e só com as vencidas. Por devedor (um
  // cadastro por grupo) dava sempre false: a régua pulava e a tela não dizia.
  const byContact = new Map<string, WalletDebtor[]>()
  for (const d of byDebtor.values()) {
    if (!d.contactId) continue
    byContact.set(d.contactId, [...(byContact.get(d.contactId) ?? []), d])
  }
  for (const list of byContact.values()) {
    const suspect = duplicateSuspects(
      list.flatMap((d) =>
        d.charges
          .filter((c) => countsAsOverdue(c.daysLate))
          .map((c) => ({ customerId: c.asaasCustomerId, connectionId: c.connectionId, document: d.cpfCnpj, value: Number(c.value), dueDate: c.dueDate })),
      ),
    )
    for (const d of list) d.duplicateSuspect = suspect
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

/**
 * Busca contatos para resolver uma pendência de casamento na mão.
 * @param asaasPhone telefone do cadastro no Asaas: quem tem o MESMO número vem
 *   primeiro, qualquer que seja o termo (16/09, L&M Vidros: a busca começava
 *   por "L&M Vidros" e o contato certo se chamava "LM Vidros").
 */
export async function searchContactsForCharge(query: string, asaasPhone?: string | null): Promise<ContactOption[]> {
  const { accountId } = await getCurrentAccount()
  const q = query.trim()
  const tail = (asaasPhone ?? '').replace(/\D/g, '').slice(-8)
  // phone_normalized = só dígitos (coluna gerada): a ficha guarda como foi digitado.
  const samePhone = tail.length === 8 ? sql`right(${contacts.phoneNormalized}, 8) = ${tail}` : null
  if (q.length < 2 && !samePhone) return []

  // 🐛 11/09 (João): buscar "Center Pisos Raspadora" não achava o contato que
  // EXISTIA. A busca por telefone usava `q.replace(/\D/g,'')`, que numa busca
  // sem dígitos vira string vazia — `phone ILIKE '%%'` casa com TODO MUNDO.
  // Com o OR, a lista virava "os 20 primeiros contatos da conta", e o certo
  // quase nunca estava neles. Só procura por telefone quando há dígitos.
  const digitos = phoneSearchDigits(q)
  const termos = q.length >= 2 ? [ilike(contacts.name, `%${q}%`), ilike(contacts.email, `%${q}%`)] : []
  if (digitos) termos.push(ilike(contacts.phone, `%${digitos}%`))
  if (samePhone) termos.push(samePhone)

  const rows = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.isGroup, false), or(...termos)))
    // Quem começa com o que foi digitado vem primeiro — sem isso o contato
    // certo podia ficar fora das 20 linhas.
    .orderBy(
      ...(samePhone ? [sql`CASE WHEN ${samePhone} THEN 0 ELSE 1 END`] : []),
      sql`CASE WHEN ${contacts.name} ILIKE ${q + '%'} THEN 0 ELSE 1 END`,
      contacts.name,
    )
    .limit(20)

  return rows.map((r) => ({ id: r.id, name: r.name ?? r.phone, phone: r.phone, email: r.email }))
}

// ------------------------------- vínculo cliente do Asaas → contato (migr 0178)
// 16/09 (Ultra Visão): a ligação feita à mão valia só para as cobranças já
// espelhadas; a PRÓXIMA parcela casava de novo por palpite, com outro contato.
// Agora toda ligação feita na tela grava o vínculo, que a sincronização e o
// lembrete respeitam — e "desligar contato" apaga.

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function linkRefsWhere(refs: readonly UnmatchedCustomerRef[]) {
  return or(...refs.map((r) => and(eq(asaasCustomerLinks.connectionId, r.connectionId), eq(asaasCustomerLinks.asaasCustomerId, r.customerId))))
}

function snapshotRefsWhere(refs: readonly UnmatchedCustomerRef[]) {
  return or(
    ...refs.map((r) => and(eq(collectionsUpcomingUnmatched.connectionId, r.connectionId), eq(collectionsUpcomingUnmatched.asaasCustomerId, r.customerId))),
  )
}

function chargeRefsWhere(refs: readonly UnmatchedCustomerRef[]) {
  return or(...refs.map((r) => and(eq(asaasCharges.connectionId, r.connectionId), eq(asaasCharges.asaasCustomerId, r.customerId))))
}

/**
 * Grava (ou troca) o vínculo destes clientes do Asaas com o contato e tira os
 * clientes do retrato "a vencer sem contato" — ligar num lugar vale nos dois
 * (cliente com uma parcela vencida na carteira e outra a vencer no painel).
 * O nome do Asaas vai junto (migr 0179): o retrato é apagado aqui, e a lista
 * "Ligados nos últimos dias" precisa dizer QUEM foi ligado.
 */
async function upsertCustomerLinks(tx: DbTx, accountId: string, userId: string | null, refs: readonly UnmatchedCustomerRef[], contactId: string): Promise<void> {
  const unique = [...new Map(refs.map((r) => [customerRefKey(r), r])).values()]
  if (!unique.length) return
  const now = new Date().toISOString()
  await tx
    .insert(asaasCustomerLinks)
    .values(
      unique.map((r) => ({
        accountId,
        connectionId: r.connectionId,
        asaasCustomerId: r.customerId,
        contactId,
        linkedBy: userId,
        customerName: (r.customerName ?? '').trim() || null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [asaasCustomerLinks.accountId, asaasCustomerLinks.connectionId, asaasCustomerLinks.asaasCustomerId],
      set: {
        contactId: sql`excluded.contact_id`,
        linkedBy: sql`excluded.linked_by`,
        // Religado sem nome à mão (retrato já limpo): fica o nome que já estava.
        customerName: sql`coalesce(excluded.customer_name, ${asaasCustomerLinks.customerName})`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
  await tx.delete(collectionsUpcomingUnmatched).where(and(eq(collectionsUpcomingUnmatched.accountId, accountId), snapshotRefsWhere(unique)))
}

/**
 * Liga todas as cobranças em aberto de um devedor a um contato do CRM.
 * Fica marcado como `manual`, e a sincronização seguinte não sobrescreve — quem
 * corrigiu na tela sabia mais do que a heurística. Grava também o vínculo do
 * cliente do Asaas: a próxima parcela dele já nasce ligada a este contato.
 */
export async function linkDebtorToContact(debtorKey: string, contactId: string): Promise<ActionResult<{ linked: number }>> {
  const { accountId, userId } = await requireRole('agent')

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
    .limit(1)
  if (!contact) return { ok: false, error: 'Contato não encontrado nesta conta.' }

  let linked = 0
  try {
    linked = await db.transaction(async (tx) => {
      const updated = await tx
        .update(asaasCharges)
        .set({ contactId, matchedBy: 'manual', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(asaasCharges.accountId, accountId),
            eq(asaasCharges.open, true),
            or(eq(asaasCharges.asaasCustomerId, debtorKey), eq(asaasCharges.cpfCnpj, debtorKey), eq(asaasCharges.asaasId, debtorKey)),
          ),
        )
        .returning({
          id: asaasCharges.id,
          connectionId: asaasCharges.connectionId,
          asaasCustomerId: asaasCharges.asaasCustomerId,
          customerName: asaasCharges.customerName,
        })
      if (updated.length) await upsertCustomerLinks(tx, accountId, userId, uniqueCustomerRefs(updated), contactId)
      return updated.length
    })
  } catch (err) {
    console.error('[cobranca] ligar devedor ao contato falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não foi possível ligar. Tente de novo.' }
  }

  if (!linked) return { ok: false, error: 'Nenhuma cobrança em aberto para este devedor.' }

  revalidatePath('/cobrancas')
  return { ok: true, data: { linked } }
}

/** Desfaz um casamento feito na mão (volta a ser pendência). */
/**
 * Adota na ficha do contato o celular que está no cadastro do Asaas. É o
 * botão do aviso "telefone diferente do Asaas": o envio usa a ficha, então sem
 * isso trocar o número lá não muda para onde a cobrança vai. Nunca sobrescreve
 * às cegas — recusa quando outro contato da conta já usa esse número, que é o
 * caminho de criar dois cadastros da mesma pessoa.
 */
export async function adoptAsaasPhone(
  contactId: string,
  /** O devedor do cartão: o número é o DELE (contato ligado a dois cadastros com telefones diferentes). */
  debtorKey?: string,
): Promise<ActionResult<{ phone: string; previousPhone: string | null }>> {
  const { accountId } = await requireRole('agent')

  const charge = firstOrNull(
    await db
      .select({ phone: asaasCharges.phone })
      .from(asaasCharges)
      .where(
        and(
          eq(asaasCharges.accountId, accountId),
          eq(asaasCharges.contactId, contactId),
          eq(asaasCharges.open, true),
          ...(debtorKey ? [debtorFilter(debtorKey)] : []),
        ),
      )
      .orderBy(desc(asaasCharges.updatedAt))
      .limit(1),
  )
  const phone = asaasPhoneForContact(charge?.phone ?? null)
  if (!phone) return { ok: false, error: 'O cadastro do Asaas não tem um telefone válido para este cliente.' }

  // Pergunta ao WhatsApp se o número recebe mensagem, em vez de adivinhar pelo
  // formato: fixo pode ter WhatsApp Business e celular pode não ter. Só o
  // "não existe" barra — quando não dá para checar, seguimos (fail-open).
  const settings = normalizeSettings((await getAccountSettings(accountId)).collections)
  const check = await numberHasWhatsApp(accountId, phone, settings.channelId)
  if (check.exists === false) {
    return {
      ok: false,
      error: 'Esse número do Asaas não está no WhatsApp, então a cobrança não chegaria. Confirme o número com o cliente e corrija no Asaas.',
    }
  }

  const clash = firstOrNull(
    await db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          sql`${contacts.id} <> ${contactId}`,
          sql`right(regexp_replace(${contacts.phone}, '\\D', '', 'g'), 8) = ${phone.slice(-8)}`,
        ),
      )
      .limit(1),
  )
  if (clash) {
    return {
      ok: false,
      code: 'phone_clash',
      clash: { id: clash.id, name: clash.name ?? 'sem nome' },
      error: `Esse número já é do contato "${clash.name ?? 'sem nome'}". Ligue a cobrança a ele, para não ficar com o cliente em dois cadastros.`,
    }
  }

  // Guarda o número anterior para o "Desfazer" do aviso — clicar errado aqui
  // troca para onde a cobrança vai, e sem volta o cliente fica sem saída
  // (11/09, João: "cliquei errado aqui em center piso raspadora, como volto?").
  const antes = firstOrNull(
    await db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )

  await db.update(contacts).set({ phone, updatedAt: new Date().toISOString() }).where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
  revalidatePath('/cobrancas')
  return { ok: true, data: { phone, previousPhone: antes?.phone?.trim() || null } }
}

/**
 * Desfaz o "Usar o do Asaas": devolve à ficha o telefone que estava lá antes.
 * Só aceita o número que a própria ação acabou de devolver, e só quando ele
 * ainda não é de outro contato.
 */
export async function restoreContactPhone(contactId: string, phone: string): Promise<ActionResult> {
  const { accountId } = await requireRole('agent')
  const limpo = (phone ?? '').trim()
  if (!limpo) return { ok: false, error: 'Não há um telefone anterior para voltar.' }

  const clash = firstOrNull(
    await db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          sql`${contacts.id} <> ${contactId}`,
          sql`right(regexp_replace(${contacts.phone}, '\\D', '', 'g'), 8) = ${limpo.replace(/\D/g, '').slice(-8)}`,
        ),
      )
      .limit(1),
  )
  if (clash) return { ok: false, error: `Não dá para voltar: esse número agora é do contato "${clash.name ?? 'sem nome'}".` }

  await db.update(contacts).set({ phone: limpo, updatedAt: new Date().toISOString() }).where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
  revalidatePath('/cobrancas')
  return { ok: true }
}

export async function unlinkDebtor(debtorKey: string): Promise<ActionResult> {
  const { accountId } = await requireRole('agent')
  try {
    await db.transaction(async (tx) => {
      // O vínculo do cliente do Asaas sai junto (16/09). Sem isso a sincronização
      // seguinte religava a cobrança ao MESMO contato pelo vínculo, e o "desligar
      // contato" deixava de funcionar sem ninguém perceber. Todas as cobranças do
      // devedor contam (não só as abertas): o vínculo é do cliente, não da parcela.
      const pairs = await tx
        .selectDistinct({ connectionId: asaasCharges.connectionId, asaasCustomerId: asaasCharges.asaasCustomerId })
        .from(asaasCharges)
        .where(and(eq(asaasCharges.accountId, accountId), debtorFilter(debtorKey), isNotNull(asaasCharges.asaasCustomerId)))
      const refs = uniqueCustomerRefs(pairs)
      if (refs.length) await tx.delete(asaasCustomerLinks).where(and(eq(asaasCustomerLinks.accountId, accountId), linkRefsWhere(refs)))
      await tx
        .update(asaasCharges)
        .set({ contactId: null, matchedBy: null, updatedAt: new Date().toISOString() })
        .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), debtorFilter(debtorKey)))
    })
  } catch (err) {
    console.error('[cobranca] desligar contato falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não foi possível desligar o contato. Tente de novo.' }
  }
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
  // 🔗 Piso do aviso de cobrança nova (17/09): quando o "CRM assume os avisos"
  // é LIGADO agora, guarda o instante — a cobrança criada até aqui o próprio
  // Asaas já avisou. O campo é do servidor: o que a tela manda é ignorado.
  const ligandoAvisos = next.asaasNotificationsOff && !current.asaasNotificationsOff
  next.asaasNotificationsOffAt = ligandoAvisos ? new Date().toISOString() : current.asaasNotificationsOffAt
  // Revisão 17/09: o piso conta da primeira varredura DEPOIS de ligar (o Asaas
  // só para de avisar quando ela cala os clientes). Ligar de novo zera; quem
  // grava é a varredura (sync.ts) ou o botão de desligar avisos — nunca a tela.
  // Zerado, a próxima sincronização varre na hora, sem a rotina de 20 h da
  // conexão (`fullSweepReason`): com o selo clicado antes, o aviso esperava um dia.
  next.asaasNotificationsSweptAt = ligandoAvisos ? null : current.asaasNotificationsSweptAt

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
  // Aviso de cobrança nova e lembrete entram na mesma fila: "Rodar agora" que
  // enfileirou só esses dizia "Nenhum devedor elegível" (17/09).
  return { ok: true, data: { queued: r.queued + (r.newCharges ?? 0) + (r.reminders ?? 0), debtors: r.debtors } }
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
  // O começo do motivo é lido pela trava de promessa repetida da IA (reply-guard.ts).
  const reason = `${manualPromiseReasonPrefix(date)} — registrado por ${who?.name ?? 'alguém da equipe'}${extra ? `: ${extra}` : ''}`
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
  /** 'human' | 'ai' | 'revert' | null (linha antiga) — migração 0177. */
  pausedSource: string | null
  pausedAt: string | null
  lastTouchAt: string | null
  touchCount: number
  /** Chegou no limite de toques da régua (não recebe mais nada). */
  maxed: boolean
}

/**
 * Situação de cobrança de UM contato — a lateral da conversa mostra e age.
 * 16/09: também devolve quem está SEGURADO sem nada vencido na carteira
 * (pausa, promessa, limite de toques) — antes voltava null e a pausa ficava
 * invisível para sempre (Guincho Ribeiro).
 */
export async function getContactCollectionStatus(contactId: string): Promise<ContactCollectionStatus | null> {
  const { accountId } = await getCurrentAccount()
  const rows = await db
    .select({ value: asaasCharges.value, dueDate: asaasCharges.dueDate })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), eq(asaasCharges.open, true)))
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
        pausedSource: collectionsTouches.pausedSource,
        pausedAt: collectionsTouches.pausedAt,
        lastTouchAt: collectionsTouches.lastTouchAt,
        touchCount: collectionsTouches.touchCount,
      })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
      .limit(1),
  )
  const settings = normalizeSettings((await getAccountSettings(accountId)).collections)
  const maxed = !!t && t.touchCount >= settings.maxTouches
  const snoozing = !!t?.snoozeUntil && Date.parse(t.snoozeUntil) > today.getTime()
  if (!rows.length && !(t?.paused || snoozing || maxed)) return null
  return {
    openCount: rows.length,
    total: rows.reduce((s, r) => s + (Number(r.value) || 0), 0),
    oldestDaysLate: oldest,
    snoozeUntil: t?.snoozeUntil ?? null,
    snoozeReason: t?.snoozeReason ?? null,
    paused: t?.paused ?? false,
    pausedReason: t?.pausedReason ?? null,
    pausedSource: t?.pausedSource ?? null,
    pausedAt: t?.pausedAt ?? null,
    lastTouchAt: t?.lastTouchAt ?? null,
    touchCount: t?.touchCount ?? 0,
    maxed,
  }
}

export interface HeldDebtor {
  contactId: string
  name: string | null
  phone: string | null
  conversationId: string | null
  paused: boolean
  pausedReason: string | null
  pausedSource: string | null
  pausedAt: string | null
  snoozeUntil: string | null
  snoozeReason: string | null
  touchCount: number
  maxed: boolean
}

/**
 * Régua parada em quem NÃO tem nada vencido na carteira — a lista da carteira
 * só mostra quem deve, então essas pausas ficavam invisíveis (16/09). Promessa
 * sem cobrança aberta fica de fora: vence sozinha e costuma ser vencimento
 * movido no Asaas (caso Silvia).
 */
export async function listHeldDebtors(): Promise<HeldDebtor[]> {
  const { accountId } = await getCurrentAccount()
  const settings = normalizeSettings((await getAccountSettings(accountId)).collections)
  const rows = await db
    .select({
      contactId: collectionsTouches.contactId,
      name: contacts.name,
      phone: contacts.phone,
      paused: collectionsTouches.paused,
      pausedReason: collectionsTouches.pausedReason,
      pausedSource: collectionsTouches.pausedSource,
      pausedAt: collectionsTouches.pausedAt,
      snoozeUntil: collectionsTouches.snoozeUntil,
      snoozeReason: collectionsTouches.snoozeReason,
      touchCount: collectionsTouches.touchCount,
      conversationId: sql<string | null>`(SELECT "conversations"."id" FROM "conversations" WHERE "conversations"."account_id" = "collections_touches"."account_id" AND "conversations"."contact_id" = "collections_touches"."contact_id" ORDER BY COALESCE("conversations"."last_message_at", "conversations"."created_at") DESC LIMIT 1)`,
    })
    .from(collectionsTouches)
    .innerJoin(contacts, eq(contacts.id, collectionsTouches.contactId))
    .where(
      and(
        eq(collectionsTouches.accountId, accountId),
        or(eq(collectionsTouches.paused, true), sql`${collectionsTouches.touchCount} >= ${settings.maxTouches}`),
        sql`NOT EXISTS (SELECT 1 FROM "asaas_charges" WHERE "asaas_charges"."account_id" = "collections_touches"."account_id" AND "asaas_charges"."contact_id" = "collections_touches"."contact_id" AND "asaas_charges"."open" = true)`,
      ),
    )
    .orderBy(desc(collectionsTouches.updatedAt))
    .limit(200)
  return rows.map((r) => ({ ...r, maxed: r.touchCount >= settings.maxTouches }))
}

/** Zera os toques da régua de um contato que chegou no limite. */
export async function resetDebtorTouches(contactId: string): Promise<ActionResult> {
  const { accountId } = await requireRole('agent')
  const now = new Date().toISOString()
  const done = await db
    .update(collectionsTouches)
    .set({ touchCount: 0, updatedAt: now })
    .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
    .returning({ contactId: collectionsTouches.contactId })
  if (!done.length) return { ok: false, error: 'Este contato não tem régua registrada.' }
  revalidatePath('/cobrancas')
  return { ok: true }
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
  // Pausa da equipe nunca some sozinha (pause-rules.ts). Retomar grava
  // 'resumed' + quando: a IA não pausa de novo por 7 dias (pause.ts).
  const pause = paused
    ? { paused, pausedReason: reason, pausedBy: userId, pausedSource: 'human', pausedAt: now }
    : { paused, pausedReason: null, pausedBy: userId, pausedSource: 'resumed', pausedAt: now }
  await db
    .insert(collectionsTouches)
    .values({ accountId, contactId, ...pause, updatedAt: now })
    .onConflictDoUpdate({
      target: [collectionsTouches.accountId, collectionsTouches.contactId],
      set: { ...pause, updatedAt: now },
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

const NO_ASAAS_CONTACT_DATA = 'Este devedor não tem telefone válido nem e-mail no Asaas. Cadastre o contato na mão e ligue aqui.'

async function createAndLink(
  accountId: string,
  userId: string,
  debtorKey: string,
  /** Em massa: só quem continua sem contato (alguém pode ter ligado à mão no meio). */
  opts: { onlyUnlinked?: boolean } = {},
): Promise<ActionResult<CreatedFromAsaas>> {
  const unlinked = opts.onlyUnlinked ? [isNull(asaasCharges.contactId)] : []
  const src = firstOrNull(
    await db
      .select({ name: asaasCharges.customerName, phone: asaasCharges.phone, email: asaasCharges.email, cpfCnpj: asaasCharges.cpfCnpj })
      .from(asaasCharges)
      // O botão individual não exige "sem contato": na troca de contato
      // (devedor já ligado) findOrCreateContact reencontra quem tem o número.
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), debtorFilter(debtorKey), ...unlinked))
      .limit(1),
  )
  if (!src) return { ok: false, error: 'Nenhuma cobrança em aberto para este devedor.' }
  if (!canCreateFromAsaas(src.phone, src.email)) return { ok: false, error: NO_ASAAS_CONTACT_DATA }

  // Ambíguo não cria nem liga — em massa, vai para `skipped` (revisão 16/09).
  const refused = await createAmbiguityRefusal(accountId, src)
  if (refused) return { ok: false, error: refused }

  const made = await createOrFindContactFromAsaas(accountId, userId, src)
  if (!made.ok || !made.data) return { ok: false, error: made.error ?? 'Não foi possível criar o contato.' }
  const found = made.data

  let linked = 0
  try {
    linked = await db.transaction(async (tx) => {
      const rows = await tx
        .update(asaasCharges)
        .set({ contactId: found.id, matchedBy: 'manual', updatedAt: new Date().toISOString() })
        .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), debtorFilter(debtorKey), ...unlinked))
        .returning({
          id: asaasCharges.id,
          connectionId: asaasCharges.connectionId,
          asaasCustomerId: asaasCharges.asaasCustomerId,
          customerName: asaasCharges.customerName,
        })
      // A próxima parcela deste cliente já nasce ligada ao contato (vínculo, 16/09).
      if (rows.length) await upsertCustomerLinks(tx, accountId, userId, uniqueCustomerRefs(rows), found.id)
      return rows.length
    })
  } catch (err) {
    console.error('[cobranca] ligar contato criado do Asaas falhou:', err instanceof Error ? err.message : err)
    return {
      ok: false,
      error: found.created
        ? 'O contato foi criado, mas não deu para ligar as cobranças. Use "Ligar a um contato" e escolha ele.'
        : 'Não foi possível ligar. Tente de novo.',
    }
  }

  return { ok: true, data: { contactId: found.id, created: found.created, linked } }
}

/**
 * "Criar contato" nunca escolhe entre dois contatos (revisão 16/09). Devedor
 * com 2+ contatos com o telefone, o e-mail ou o CPF/CNPJ dele: findOrCreateContact
 * reaproveitaria o primeiro que o banco devolver, e o clique grava o vínculo
 * cliente do Asaas → contato — que vence o casamento automático nas próximas
 * parcelas e no lembrete. O chute virava regra. A conferência é o casamento da
 * sincronização SEM o vínculo ("quem tem estes dados?"), na hora do clique: a
 * carteira e o retrato do painel podem ser de horas atrás. Confere pela MESMA
 * chave que a criação usa (createProbeKeys: telefone, ou só o e-mail). Devolve
 * o erro para a tela, ou null quando pode criar; se a conferência falhar, recusa.
 */
async function createAmbiguityRefusal(accountId: string, src: { phone: string | null; email: string | null }): Promise<string | null> {
  const keys = createProbeKeys(src.phone, src.email)
  try {
    return createRefusal(await findContact(accountId, keys.phone, keys.email, null))
  } catch (err) {
    console.error('[cobranca] conferir contatos antes de criar falhou:', err instanceof Error ? err.message : err)
    return createRefusal(null)
  }
}

/**
 * Cria (ou reencontra) o contato com nome/telefone/e-mail do jeito que estão no
 * Asaas. Usada pela carteira ("Criar contato e ligar") e pelo painel "A vencer
 * sem contato" (16/09) — a mesma trava anti-duplicado nos dois. Quem chama
 * confere antes que o caso não é ambíguo (createAmbiguityRefusal).
 */
async function createOrFindContactFromAsaas(
  accountId: string,
  userId: string,
  src: { name: string | null; phone: string | null; email: string | null },
): Promise<ActionResult<{ id: string; created: boolean }>> {
  const phone = asaasPhoneForContact(src.phone)
  const email = normalizeEmail(src.email)
  if (!phone && !email) return { ok: false, error: NO_ASAAS_CONTACT_DATA }

  try {
    if (phone) {
      // Mesma trava anti-duplicado do inbound e da API: telefone já existente
      // (com ou sem 55, com ou sem 9º dígito) reaproveita o contato em vez de
      // criar um segundo.
      const found = await findOrCreateContact(accountId, userId, {
        phone,
        name: src.name?.trim() || null,
        email: email || null,
      })
      return { ok: true, data: found }
    }
    // Só e-mail: mesmo formato do inbound de e-mail (phone vazio, índice único
    // de telefone é parcial). Reaproveita quem já tem esse e-mail na conta.
    const existing = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.accountId, accountId), sql`lower(${contacts.email}) = ${email}`))
        .limit(1),
    )
    if (existing) return { ok: true, data: { id: existing.id, created: false } }
    const inserted = firstOrNull(
      await db
        .insert(contacts)
        .values({ accountId, userId, phone: '', name: src.name?.trim() || email, email })
        .returning({ id: contacts.id }),
    )
    if (!inserted) return { ok: false, error: 'Não foi possível criar o contato.' }
    return { ok: true, data: { id: inserted.id, created: true } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Não foi possível criar o contato.' }
  }
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
    const res = await createAndLink(accountId, userId, d.key, { onlyUnlinked: true })
    if (!res.ok) out.skipped.push({ name: d.name, reason: res.error ?? 'falhou' })
    else if (res.data!.created) out.created += 1
    else out.linked += 1
  }
  revalidatePath('/cobrancas')
  return { ok: true, data: out }
}

// ------------------------------------------ a vencer sem contato (16/09)
// Speed Gás e Água (GoLink): a parcela a vencer de cliente do Asaas que não
// casava com contato não recebia o lembrete antes do vencimento, e só o log do
// worker sabia. A rodada do lembrete grava o retrato
// (collections_upcoming_unmatched) e a tela resolve um por um — o CRM nunca
// cria contato nem vínculo sozinho, sempre alguém clica.

export interface UpcomingUnmatchedCard {
  connectionId: string
  connectionLabel: string
  customerId: string
  /** Nome como está no Asaas ("Sem nome" quando o cadastro não tem). */
  name: string
  phone: string | null
  email: string | null
  cpfCnpj: string | null
  reason: UnmatchedReason
  /** Só as parcelas da janela do lembrete (de hoje até hoje + N dias). */
  payments: UnmatchedPayment[]
  nextDueDate: string | null
  total: number
  /** Tem telefone brasileiro válido ou e-mail no Asaas — dá para criar o contato. */
  canCreate: boolean
  /** Outros cartões com o mesmo CPF/CNPJ (só dica: ligar o outro é um clique próprio). */
  sameDocumentOthers: number
}

export interface UpcomingUnmatchedView {
  /** Lembrete antes do vencimento ligado em Ajustar. Desligado = nada a mostrar. */
  enabled: boolean
  /**
   * A régua está ligada. Desligada, o worker nem lê o Asaas: a lista fica
   * parada na última leitura (pode ter quem já pagou) e o lembrete não sai —
   * a tela avisa em vez de prometer "na próxima rodada" (16/09).
   */
  ruleEnabled: boolean
  daysBefore: number
  /** Hoje no fuso da conta (YYYY-MM-DD) — "vence hoje/amanhã" na tela. */
  todayKey: string
  /** Última leitura que gravou alguém na lista (ISO). */
  checkedAt: string | null
  cards: UpcomingUnmatchedCard[]
  /** Ligados nos últimos dias sem cobrança aberta — onde dá para desligar depois que o "Desfazer" some. */
  recentLinks: UpcomingRecentLink[]
  /** A lista acima não carregou: a tela diz, em vez de parecer que não há o que desligar. */
  recentLinksFailed: boolean
}

/**
 * Vínculo recente de cliente do Asaas SEM cobrança aberta na carteira (revisão
 * 16/09). Ligado errado no painel, o "Desfazer" durava 12 s; depois o cartão
 * sumia, a carteira não mostrava o cliente (parcela a vencer não entra lá) e o
 * lembrete saía com o valor e o link de um cliente para o contato errado.
 */
export interface UpcomingRecentLink {
  connectionId: string
  connectionLabel: string
  customerId: string
  /** Nome no Asaas quando foi ligado (null = ligado antes da 0179, ou cadastro sem nome). */
  customerName: string | null
  contactId: string
  contactName: string
  contactHasPhone: boolean
  /** Quem ligou (null = não sabemos). */
  linkedByName: string | null
  /** Quando foi ligado (ou religado) — ISO. */
  linkedAt: string
}

/** Resultado do "Ligar a um contato" e do "Criar contato" do painel: o aviso sabe por onde o lembrete sai. */
export interface UpcomingLinkResult extends LinkDeliveryInfo {
  contactId: string
  contactPhone: string | null
  /** Vínculo que já existia antes do clique (o mesmo contato — linkCustomerTo recusa outro). */
  previousContactId: string | null
  restore: ChargeRestore[]
}

const UPCOMING_GONE = 'Este cliente já saiu da lista (pagou, venceu ou já foi ligado). Atualize a tela.'
const UPCOMING_ALREADY_LINKED = 'Este cliente do Asaas já foi ligado a outro contato (por outra pessoa ou em outra aba). Atualize a tela.'
const UPCOMING_RELINKED = 'Este cliente foi ligado de novo depois (por outra pessoa ou em outra aba). Atualize a tela antes de desfazer.'
const UPCOMING_NO_DATA = 'Este cliente não tem telefone válido nem e-mail no Asaas. Cadastre o contato na mão e use "Ligar a um contato".'
const UPCOMING_HAS_OPEN_CHARGE =
  'Este cliente já tem cobrança aberta na carteira — desligue por lá ("desligar contato" no cartão dele), que as cobranças saem junto. Atualize a tela.'

/**
 * Quem vence na janela do lembrete e não tem contato no CRM. Só conexões
 * ligadas, só quem ainda não foi ligado (o vínculo esconde na hora, mesmo que
 * uma leitura do worker em andamento grave o cartão de novo) e só as parcelas
 * que ainda não venceram — filtrando pelas parcelas, não pela menor data.
 */
export async function getUpcomingUnmatched(): Promise<ActionResult<UpcomingUnmatchedView>> {
  const { accountId } = await getCurrentAccount()
  try {
    const accountSettings = await getAccountSettings(accountId)
    const s = normalizeSettings(accountSettings.collections)
    const todayKey = localDayKey(accountSettings.businessTimezone || 'America/Sao_Paulo')
    if (s.reminderDaysBefore <= 0) {
      return {
        ok: true,
        data: { enabled: false, ruleEnabled: s.enabled, daysBefore: 0, todayKey, checkedAt: null, cards: [], recentLinks: [], recentLinksFailed: false },
      }
    }

    // Extra: falhar aqui não esconde os cartões, mas a tela diz que falhou.
    let recentLinksFailed = false
    const recentLinks = await recentUpcomingLinks(accountId, s.reminderDaysBefore).catch((err) => {
      console.error('[cobranca] ligados nos últimos dias (a vencer) falhou:', err instanceof Error ? err.message : err)
      recentLinksFailed = true
      return [] as UpcomingRecentLink[]
    })

    const rows = await db
      .select({
        connectionId: collectionsUpcomingUnmatched.connectionId,
        connectionLabel: asaasConnections.label,
        customerId: collectionsUpcomingUnmatched.asaasCustomerId,
        name: collectionsUpcomingUnmatched.customerName,
        phone: collectionsUpcomingUnmatched.phone,
        email: collectionsUpcomingUnmatched.email,
        cpfCnpj: collectionsUpcomingUnmatched.cpfCnpj,
        reason: collectionsUpcomingUnmatched.reason,
        payments: collectionsUpcomingUnmatched.payments,
        nextDueDate: collectionsUpcomingUnmatched.nextDueDate,
        total: collectionsUpcomingUnmatched.total,
        lastSeenAt: collectionsUpcomingUnmatched.lastSeenAt,
      })
      .from(collectionsUpcomingUnmatched)
      .innerJoin(
        asaasConnections,
        and(
          eq(asaasConnections.id, collectionsUpcomingUnmatched.connectionId),
          eq(asaasConnections.accountId, accountId),
          eq(asaasConnections.enabled, true),
        ),
      )
      .leftJoin(
        asaasCustomerLinks,
        and(
          eq(asaasCustomerLinks.accountId, collectionsUpcomingUnmatched.accountId),
          eq(asaasCustomerLinks.connectionId, collectionsUpcomingUnmatched.connectionId),
          eq(asaasCustomerLinks.asaasCustomerId, collectionsUpcomingUnmatched.asaasCustomerId),
        ),
      )
      .where(and(eq(collectionsUpcomingUnmatched.accountId, accountId), isNull(asaasCustomerLinks.id)))
      .orderBy(collectionsUpcomingUnmatched.nextDueDate)
      .limit(300)

    let checkedAtMs = 0
    const base = rows.map((r) => {
      const seen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0
      if (Number.isFinite(seen) && seen > checkedAtMs) checkedAtMs = seen
      const payments: UnmatchedPayment[] = (Array.isArray(r.payments) ? r.payments : [])
        .filter((p) => !!p && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          value: Number(p.value) || 0,
          dueDate: typeof p.dueDate === 'string' ? p.dueDate.slice(0, 10) : null,
          invoiceUrl: p.invoiceUrl ?? null,
          description: p.description ?? null,
        }))
      return {
        connectionId: r.connectionId,
        connectionLabel: r.connectionLabel,
        customerId: r.customerId,
        name: (r.name ?? '').trim() || 'Sem nome',
        phone: r.phone,
        email: r.email,
        cpfCnpj: r.cpfCnpj,
        reason: (r.reason === 'ambiguous' ? 'ambiguous' : 'no_contact') as UnmatchedReason,
        payments,
        nextDueDate: r.nextDueDate,
        total: Number(r.total) || 0,
      }
    })
    const visible = visibleUpcoming(base, todayKey, s.reminderDaysBefore)
    const others = sameDocumentOthers(visible)
    const cards: UpcomingUnmatchedCard[] = visible
      .map((r) => ({
        ...r,
        canCreate: canCreateFromAsaas(r.phone, r.email),
        sameDocumentOthers: others.get(customerRefKey(r)) ?? 0,
      }))
      .sort((a, b) => (a.nextDueDate ?? '9999').localeCompare(b.nextDueDate ?? '9999') || a.name.localeCompare(b.name, 'pt-BR'))

    return {
      ok: true,
      data: {
        enabled: true,
        ruleEnabled: s.enabled,
        daysBefore: s.reminderDaysBefore,
        todayKey,
        checkedAt: checkedAtMs ? new Date(checkedAtMs).toISOString() : null,
        cards,
        recentLinks,
        recentLinksFailed,
      },
    }
  } catch (err) {
    console.error('[cobranca] a vencer sem contato: leitura falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não deu para carregar os clientes a vencer sem contato.' }
  }
}

/**
 * Vínculos dos últimos dias (lembrete + uma semana) de clientes SEM cobrança
 * aberta — quem tem cobrança aberta aparece na carteira, com "desligar contato"
 * no cartão. Só conta do Asaas ligada e contato que ainda existe. Vale também
 * para ligação feita na carteira cuja parcela foi paga: o vínculo continua
 * valendo para a próxima parcela, e sem cartão não haveria onde desligar.
 */
async function recentUpcomingLinks(accountId: string, reminderDaysBefore: number): Promise<UpcomingRecentLink[]> {
  const l = asaasCustomerLinks
  const rows = await db
    .select({
      connectionId: l.connectionId,
      connectionLabel: asaasConnections.label,
      customerId: l.asaasCustomerId,
      customerName: l.customerName,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      linkedByName: user.name,
      linkedAt: l.updatedAt,
    })
    .from(l)
    .innerJoin(asaasConnections, and(eq(asaasConnections.id, l.connectionId), eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true)))
    .innerJoin(contacts, and(eq(contacts.id, l.contactId), eq(contacts.accountId, accountId)))
    .leftJoin(user, eq(user.id, l.linkedBy))
    .where(
      and(
        eq(l.accountId, accountId),
        gte(l.updatedAt, recentLinksSince(Date.now(), reminderDaysBefore)),
        // Subquery raw com "tabela"."coluna": sem qualificar, a coluna casa com a tabela de fora.
        sql`NOT EXISTS (SELECT 1 FROM "asaas_charges" WHERE "asaas_charges"."account_id" = "asaas_customer_links"."account_id" AND "asaas_charges"."connection_id" = "asaas_customer_links"."connection_id" AND "asaas_charges"."asaas_customer_id" = "asaas_customer_links"."asaas_customer_id" AND "asaas_charges"."open" = true)`,
      ),
    )
    .orderBy(desc(l.updatedAt))
    .limit(RECENT_LINKS_LIMIT)

  return rows.map((r) => ({
    connectionId: r.connectionId,
    connectionLabel: r.connectionLabel,
    customerId: r.customerId,
    customerName: (r.customerName ?? '').trim() || null,
    contactId: r.contactId,
    contactName: (r.contactName ?? '').trim() || (r.contactPhone ?? '').trim() || 'contato sem nome',
    contactHasPhone: (r.contactPhone ?? '').replace(/\D/g, '').length >= 10,
    linkedByName: (r.linkedByName ?? '').trim() || null,
    linkedAt: r.linkedAt,
  }))
}

/**
 * Por onde sai o lembrete para o contato que acabou de ser ligado, com os
 * MESMOS testes da fila do lembrete, na mesma ordem: quem pediu SAIR, o freio
 * do devedor (debtorHold com as settings da conta — pausa, limite de toques,
 * promessa) e o canal (resolveCollectionTargets em dryRun, com o e-mail do
 * Asaas de reserva). A ligação já foi gravada: conferir é só para o aviso,
 * nunca desfaz nem lança — se falhar, a tela diz que não deu para conferir em
 * vez de prometer canal (e o clique não vira "Não foi possível ligar" com a
 * ligação feita).
 */
async function upcomingDeliveryInfo(
  accountId: string,
  contactId: string,
  asaas: { phone: string | null; email: string | null },
): Promise<LinkDeliveryInfo & { contactPhone: string | null }> {
  let contact: { name: string | null; phone: string; optedOut: boolean } | null
  try {
    contact = firstOrNull(
      await db
        .select({ name: contacts.name, phone: contacts.phone, optedOut: contacts.optedOut })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
  } catch (err) {
    console.warn('[cobranca] ler a ficha para o aviso do lembrete (a vencer) falhou:', err instanceof Error ? err.message : err)
    // Sem a ficha não dá para dizer nada: nem canal, nem "sem telefone".
    return { contactName: 'o contato', contactHasPhone: true, phoneDiffers: false, deliveryLabel: null, deliveryError: null, contactPhone: null }
  }

  // Revisão 16/09: o freio que a fila confere antes do canal. Contato em
  // "Régua parada" (pausa humana só sai no Retomar) ou com promessa ganhava
  // "O lembrete sai por WhatsApp" e a rodada pulava calada.
  let hold: DeliveryHold | null = null
  let holdChecked = false
  let timeZone = 'America/Sao_Paulo'
  try {
    const accountSettings = await getAccountSettings(accountId)
    timeZone = accountSettings.businessTimezone || timeZone
    const st = firstOrNull(
      await db
        .select({
          paused: collectionsTouches.paused,
          pausedReason: collectionsTouches.pausedReason,
          touchCount: collectionsTouches.touchCount,
          lastTouchAt: collectionsTouches.lastTouchAt,
          snoozeUntil: collectionsTouches.snoozeUntil,
          snoozeReason: collectionsTouches.snoozeReason,
        })
        .from(collectionsTouches)
        .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
        .limit(1),
    )
    const kind = debtorHold(st, normalizeSettings(accountSettings.collections))
    if (kind) {
      hold = {
        kind,
        reason: kind === 'paused' ? st?.pausedReason : kind === 'snoozed' ? st?.snoozeReason : null,
        until: kind === 'snoozed' ? st?.snoozeUntil : null,
      }
    }
    holdChecked = true
  } catch (err) {
    console.warn('[cobranca] ler o freio da régua para o aviso do lembrete (a vencer) falhou:', err instanceof Error ? err.message : err)
  }

  // Freio ligado: o canal nem importa. Freio não conferido: não promete canal.
  const delivery: DeliveryCheck =
    holdChecked && !hold
      ? await resolveCollectionTargets(accountId, contactId, null, { dryRun: true, fallbackEmail: asaas.email }).catch((err) => {
          console.warn('[cobranca] conferir canal do lembrete (a vencer) falhou:', err instanceof Error ? err.message : err)
          return null
        })
      : null
  const info = linkDeliveryInfo({
    contactName: contact?.name ?? null,
    contactPhone: contact?.phone ?? null,
    optedOut: contact?.optedOut === true,
    asaasPhone: asaas.phone,
    delivery,
    hold,
    timeZone,
  })
  return { ...info, contactPhone: (contact?.phone ?? '').trim() || null }
}

/** Nome, telefone e e-mail do cliente no retrato — lidos ANTES de ligar, porque ligar apaga a linha. */
async function upcomingSnapshotRow(
  accountId: string,
  ref: UnmatchedCustomerRef,
): Promise<{ name: string | null; phone: string | null; email: string | null; cpfCnpj: string | null; reason: string } | null> {
  return firstOrNull(
    await db
      .select({
        name: collectionsUpcomingUnmatched.customerName,
        phone: collectionsUpcomingUnmatched.phone,
        email: collectionsUpcomingUnmatched.email,
        cpfCnpj: collectionsUpcomingUnmatched.cpfCnpj,
        reason: collectionsUpcomingUnmatched.reason,
      })
      .from(collectionsUpcomingUnmatched)
      .where(
        and(
          eq(collectionsUpcomingUnmatched.accountId, accountId),
          eq(collectionsUpcomingUnmatched.connectionId, ref.connectionId),
          eq(collectionsUpcomingUnmatched.asaasCustomerId, ref.customerId),
        ),
      )
      .limit(1),
  )
}

/**
 * Liga UM cliente do Asaas (numa conta do Asaas) a um contato: grava o vínculo,
 * leva junto as cobranças abertas dele na carteira (menos a emitida pelo CRM
 * que já tem contato) e tira o cartão do painel.
 * Recusa quando outra pessoa já ligou o mesmo cliente a outro contato — a tela
 * estava velha, e trocar calado seria pior. Devolve para o "Desfazer" o vínculo
 * anterior (o mesmo contato, quando o clique repete) e o estado de ANTES das
 * cobranças que o clique mudou.
 */
async function linkCustomerTo(
  accountId: string,
  userId: string,
  ref: UnmatchedCustomerRef,
  contactId: string,
): Promise<{ ok: true; previousContactId: string | null; restore: ChargeRestore[] } | { ok: false; error: string }> {
  const previous = firstOrNull(
    await db
      .select({ contactId: asaasCustomerLinks.contactId })
      .from(asaasCustomerLinks)
      .where(
        and(
          eq(asaasCustomerLinks.accountId, accountId),
          eq(asaasCustomerLinks.connectionId, ref.connectionId),
          eq(asaasCustomerLinks.asaasCustomerId, ref.customerId),
        ),
      )
      .limit(1),
  )
  if (previous && previous.contactId !== contactId) return { ok: false, error: UPCOMING_ALREADY_LINKED }

  const restore = await db.transaction(async (tx) => {
    await upsertCustomerLinks(tx, accountId, userId, [ref], contactId)
    // 16/09: o estado de ANTES, só das linhas que o clique muda — o RETURNING
    // do update devolveria os valores novos. Sem isso o "Desfazer" zerava a
    // vencida ligada à mão na carteira antes da 0178 (sem vínculo retroativo)
    // ou a cobrança criada pela IA (emit.ts nasce 'manual' sem vínculo): ela
    // virava "Sem contato" e a régua parava de cobrá-la.
    const open = await tx
      .select({ id: asaasCharges.id, contactId: asaasCharges.contactId, matchedBy: asaasCharges.matchedBy, origin: asaasCharges.origin })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), chargeRefsWhere([ref])))
      .for('update')
    // Cobrança emitida pelo CRM fica com o contato da conversa (revisão 16/09,
    // linkMayMoveCharge) — a mesma regra da sincronização.
    const changed = chargesChangedByLink(open.filter(linkMayMoveCharge), contactId)
    if (changed.length) {
      await tx
        .update(asaasCharges)
        .set({ contactId, matchedBy: 'manual', updatedAt: new Date().toISOString() })
        .where(and(eq(asaasCharges.accountId, accountId), inArray(asaasCharges.id, changed.map((c) => c.id))))
    }
    return changed
  })
  return { ok: true, previousContactId: previous?.contactId ?? null, restore }
}

async function connectionOfAccount(accountId: string, connectionId: string): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: asaasConnections.id })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.id, connectionId), eq(asaasConnections.accountId, accountId)))
      .limit(1),
  )
  return !!row
}

export async function linkUpcomingCustomer(
  connectionId: string,
  customerId: string,
  contactId: string,
  /**
   * Só o "Desfazer" do Desligar manda (revisão 16/09): o retrato foi apagado ao
   * ligar e o vínculo ao desligar — sem isto, religar perdia o nome do Asaas e
   * a lista mostraria só o cus_.
   */
  customerName?: string | null,
): Promise<ActionResult<UpcomingLinkResult>> {
  const { accountId, userId } = await requireRole('agent')
  try {
    const contact = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId), eq(contacts.isGroup, false)))
        .limit(1),
    )
    if (!contact) return { ok: false, error: 'Contato não encontrado nesta conta.' }
    if (!customerId || !(await connectionOfAccount(accountId, connectionId))) return { ok: false, error: UPCOMING_GONE }

    // Antes de ligar: ligar apaga a linha do retrato, e dela vêm o nome (para
    // o vínculo) e o telefone/e-mail do Asaas (para o aviso de canal).
    const snap = await upcomingSnapshotRow(accountId, { connectionId, customerId })
    const name = (snap?.name ?? '').trim() || relinkCustomerName(customerName)
    const r = await linkCustomerTo(accountId, userId, { connectionId, customerId, customerName: name }, contact.id)
    if (!r.ok) return { ok: false, error: r.error }
    const info = await upcomingDeliveryInfo(accountId, contact.id, { phone: snap?.phone ?? null, email: snap?.email ?? null })
    revalidatePath('/cobrancas')
    return {
      ok: true,
      data: { ...info, contactId: contact.id, previousContactId: r.previousContactId, restore: r.restore },
    }
  } catch (err) {
    console.error('[cobranca] ligar cliente a vencer falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não foi possível ligar. Tente de novo.' }
  }
}

/**
 * "Criar contato" no painel: com nome/telefone/e-mail do Asaas, a mesma trava
 * anti-duplicado da carteira. Cliente AMBÍGUO nunca: findOrCreateContact
 * escolheria sozinho um dos contatos com aquele telefone — é chute. O retrato
 * é da última leitura (pode ser de horas atrás): um duplicado criado depois
 * deixaria o cartão "sem contato", então o casamento é conferido de novo aqui.
 */
export async function createContactForUpcoming(
  connectionId: string,
  customerId: string,
): Promise<ActionResult<UpcomingLinkResult & { created: boolean }>> {
  const { accountId, userId } = await requireRole('agent')
  try {
    const row = await upcomingSnapshotRow(accountId, { connectionId, customerId })
    if (!row) return { ok: false, error: UPCOMING_GONE }
    if (row.reason === 'ambiguous') return { ok: false, error: CREATE_AMBIGUOUS_ERROR }
    if (!canCreateFromAsaas(row.phone, row.email)) return { ok: false, error: UPCOMING_NO_DATA }
    const refused = await createAmbiguityRefusal(accountId, row)
    if (refused) return { ok: false, error: refused }

    const made = await createOrFindContactFromAsaas(accountId, userId, { name: row.name, phone: row.phone, email: row.email })
    if (!made.ok || !made.data) return { ok: false, error: made.error ?? 'Não foi possível criar o contato.' }

    const r = await linkCustomerTo(accountId, userId, { connectionId, customerId, customerName: row.name }, made.data.id)
    if (!r.ok) return { ok: false, error: r.error }

    // O nome é o da FICHA (contato que já existia fala o nome dele, não o do
    // Asaas — o desfazer avisa que é este contato que continua casando).
    const info = await upcomingDeliveryInfo(accountId, made.data.id, { phone: row.phone, email: row.email })
    revalidatePath('/cobrancas')
    return {
      ok: true,
      data: {
        ...info,
        contactId: made.data.id,
        created: made.data.created,
        previousContactId: r.previousContactId,
        restore: r.restore,
      },
    }
  } catch (err) {
    console.error('[cobranca] criar contato para cliente a vencer falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não foi possível criar o contato.' }
  }
}

export interface UpcomingUndoInput {
  /** O contato que o clique ligou. O desfazer só age se o vínculo ainda aponta para ele. */
  contactId: string
  /** Vínculo que já existia antes do clique (é o mesmo contato — linkCustomerTo recusa outro): ele fica. */
  previousContactId: string | null
  /** Cobranças abertas que o clique mudou, com o contato e o matched_by de antes (linkCustomerTo). */
  restore: ChargeRestore[]
  /** O "Criar contato" CRIOU este contato: sai junto quando nada depende dele. */
  createdContactId: string | null
}

/**
 * Apaga o contato que o "Criar contato" acabou de criar, se foi quem desfaz que
 * criou e nada depende dele (canRemoveCreatedContact). Roda na transação do
 * desfazer, DEPOIS de apagar o vínculo e devolver as cobranças — senão o
 * próprio clique o prenderia. O id volta do navegador: autor e idade são
 * conferidos aqui. Contato que já não existe conta como apagado.
 */
async function removeCreatedContact(tx: DbTx, accountId: string, userId: string, contactId: string): Promise<boolean> {
  // Subquery raw com "tabela"."coluna" (gotcha do Drizzle: sem qualificar, a
  // coluna casa com a tabela de fora). O apagar é em cascata: nota, etiqueta,
  // régua e fila iriam junto — qualquer uso segura o contato (revisão 16/09).
  const deps = firstOrNull(
    await tx
      .select({
        recent: sql<boolean>`"contacts"."created_at" > now() - interval '15 minutes'`,
        createdByUser: sql<boolean>`coalesce("contacts"."user_id" = ${userId}::uuid, false)`,
        conversations: sql<boolean>`EXISTS (SELECT 1 FROM "conversations" WHERE "conversations"."contact_id" = "contacts"."id")`,
        deals: sql<boolean>`(EXISTS (SELECT 1 FROM "deals" WHERE "deals"."contact_id" = "contacts"."id") OR EXISTS (SELECT 1 FROM "deal_contacts" WHERE "deal_contacts"."contact_id" = "contacts"."id"))`,
        links: sql<boolean>`EXISTS (SELECT 1 FROM "asaas_customer_links" WHERE "asaas_customer_links"."contact_id" = "contacts"."id")`,
        charges: sql<boolean>`EXISTS (SELECT 1 FROM "asaas_charges" WHERE "asaas_charges"."contact_id" = "contacts"."id")`,
        actionRequests: sql<boolean>`EXISTS (SELECT 1 FROM "agent_action_requests" WHERE "agent_action_requests"."contact_id" = "contacts"."id")`,
        notes: sql<boolean>`(EXISTS (SELECT 1 FROM "contact_notes" WHERE "contact_notes"."contact_id" = "contacts"."id") OR EXISTS (SELECT 1 FROM "tasks" WHERE "tasks"."contact_id" = "contacts"."id"))`,
        tags: sql<boolean>`EXISTS (SELECT 1 FROM "contact_tags" WHERE "contact_tags"."contact_id" = "contacts"."id")`,
        schedule: sql<boolean>`(EXISTS (SELECT 1 FROM "scheduled_messages" WHERE "scheduled_messages"."contact_id" = "contacts"."id") OR EXISTS (SELECT 1 FROM "calendar_events" WHERE "calendar_events"."contact_id" = "contacts"."id"))`,
        history: sql<boolean>`(EXISTS (SELECT 1 FROM "collections_touches" WHERE "collections_touches"."contact_id" = "contacts"."id") OR EXISTS (SELECT 1 FROM "customer_transactions" WHERE "customer_transactions"."contact_id" = "contacts"."id"))`,
      })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .for('update')
      .limit(1),
  )
  if (!deps) return true
  if (!canRemoveCreatedContact(deps)) return false
  await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
  return true
}

/**
 * "Desfazer" do painel. Devolve cada cobrança que o clique mudou ao estado de
 * antes (contato e matched_by) — só enquanto ela está como o clique deixou,
 * para não passar por cima de quem mexeu depois — e apaga o vínculo quando
 * ele não existia antes do clique. O contato que o clique CRIOU sai junto se
 * acabou de nascer e nada depende dele: com o telefone/e-mail do Asaas, ele
 * casaria sozinho na leitura seguinte e o desfazer não desfaria nada (16/09).
 *
 * O cliente só volta para a lista se nenhum contato casar pelo telefone,
 * e-mail ou CPF/CNPJ na próxima leitura — a tela diz isso (undoResultText).
 */
export async function unlinkUpcomingCustomer(
  connectionId: string,
  customerId: string,
  undo: UpcomingUndoInput,
): Promise<ActionResult<{ contactRemoved: boolean }>> {
  return undoUpcomingLink(connectionId, customerId, undo, { refuseOpenCharge: false })
}

/**
 * "Desligar" da lista "Ligados nos últimos dias" (revisão 16/09): sem cobrança
 * para devolver, sem vínculo anterior e sem contato criado — só o vínculo sai,
 * e só se ainda aponta para o contato da lista.
 *
 * Recusa quando o cliente tem cobrança aberta. A lista pode ser de manhã: a
 * parcela venceu, a rodada espelhou a cobrança já no contato do vínculo (B,
 * 'manual') e o Desligar da lista velha apagava só o vínculo — a cobrança
 * seguia em B, e a sincronização nunca corrige 'manual'. Cobrança aberta = o
 * cliente está na carteira: desliga por lá, onde as cobranças saem junto. (O
 * "Desfazer" do clique não recusa: a cobrança que ele não mudou já era assim.)
 */
export async function unlinkRecentUpcomingCustomer(
  connectionId: string,
  customerId: string,
  contactId: string,
): Promise<ActionResult<{ contactRemoved: boolean }>> {
  return undoUpcomingLink(connectionId, customerId, { contactId, previousContactId: null, restore: [], createdContactId: null }, { refuseOpenCharge: true })
}

async function undoUpcomingLink(
  connectionId: string,
  customerId: string,
  undo: UpcomingUndoInput,
  opts: { refuseOpenCharge: boolean },
): Promise<ActionResult<{ contactRemoved: boolean }>> {
  const { accountId, userId } = await requireRole('agent')
  try {
    if (!customerId || !isUuid(connectionId) || !(await connectionOfAccount(accountId, connectionId))) return { ok: false, error: UPCOMING_GONE }
    const linkedContactId = undo?.contactId
    if (!isUuid(linkedContactId)) return { ok: false, error: 'Não há o que desfazer. Atualize a tela.' }
    const ref: UnmatchedCustomerRef = { connectionId, customerId }
    const current = firstOrNull(
      await db
        .select({ contactId: asaasCustomerLinks.contactId })
        .from(asaasCustomerLinks)
        .where(
          and(
            eq(asaasCustomerLinks.accountId, accountId),
            eq(asaasCustomerLinks.connectionId, connectionId),
            eq(asaasCustomerLinks.asaasCustomerId, customerId),
          ),
        )
        .limit(1),
    )
    // Outra pessoa (ou outra aba) ligou a outro contato depois do clique:
    // desfazer agora apagaria a decisão DELA.
    if (current && current.contactId !== linkedContactId) return { ok: false, error: UPCOMING_RELINKED }

    const restore = sanitizeChargeRestore(undo.restore)
    const before = [...new Set(restore.map((r) => r.contactId).filter((id): id is string => !!id))]
    const stillThere = new Set(
      before.length
        ? (await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.accountId, accountId), inArray(contacts.id, before)))).map((r) => r.id)
        : [],
    )
    const keepLink = !!undo.previousContactId
    const createdContactId = !keepLink && undo.createdContactId === linkedContactId ? linkedContactId : null

    const outcome = await db.transaction(async (tx): Promise<{ openCharge: true } | { openCharge: false; contactRemoved: boolean }> => {
      // Só o "Desligar" da lista (ver unlinkRecentUpcomingCustomer).
      if (opts.refuseOpenCharge) {
        const open = firstOrNull(
          await tx
            .select({ id: asaasCharges.id })
            .from(asaasCharges)
            .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), chargeRefsWhere([ref])))
            .limit(1),
        )
        if (open) return { openCharge: true }
      }
      if (current && !keepLink) {
        await tx.delete(asaasCustomerLinks).where(and(eq(asaasCustomerLinks.accountId, accountId), linkRefsWhere([ref])))
      }
      const now = new Date().toISOString()
      for (const item of restore) {
        const target = restoreTarget(item, stillThere)
        // A lista veio do navegador: conta, cliente e "ainda como o clique
        // deixou" são conferidos aqui, linha por linha.
        await tx
          .update(asaasCharges)
          .set({ contactId: target.contactId, matchedBy: target.matchedBy, updatedAt: now })
          .where(
            and(
              eq(asaasCharges.id, item.id),
              eq(asaasCharges.accountId, accountId),
              eq(asaasCharges.open, true),
              chargeRefsWhere([ref]),
              eq(asaasCharges.contactId, linkedContactId),
              eq(asaasCharges.matchedBy, 'manual'),
            ),
          )
      }
      return { openCharge: false, contactRemoved: createdContactId ? await removeCreatedContact(tx, accountId, userId, createdContactId) : false }
    })
    if (outcome.openCharge) return { ok: false, error: UPCOMING_HAS_OPEN_CHARGE }
    revalidatePath('/cobrancas')
    return { ok: true, data: { contactRemoved: outcome.contactRemoved } }
  } catch (err) {
    console.error('[cobranca] desfazer/desligar ligação de cliente a vencer falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: opts.refuseOpenCharge ? 'Não foi possível desligar. Tente de novo.' : 'Não foi possível desfazer. Tente de novo.' }
  }
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
  /**
   * CPF/CNPJ digitado. Vence o conhecido (carteira > ficha); digitado inválido é
   * recusado. Em produção sem nenhum dos dois, a action recusa ANTES de tudo.
   */
  cpfCnpj?: string
  /** Assinatura mensal sem fim (o Asaas gera uma cobrança por mês a partir do vencimento). */
  recurring?: 'MONTHLY'
  /**
   * E-mail e endereço para o cadastro do Asaas — o que ele exige para emitir
   * NOTA FISCAL (11/09, João/GoLink). Tudo opcional. Fica guardado no Asaas,
   * então só precisa ser preenchido uma vez por cliente.
   */
  email?: string
  postalCode?: string
  address?: string
  addressNumber?: string
  complement?: string
  province?: string
  /**
   * "Cadastrar também na conta escolhida" (15/09): o cliente já existe noutra
   * conta do Asaas e quem gera confirmou que é cliente das duas empresas.
   */
  allowNewCustomerHere?: boolean
}

export interface ManualChargeResult {
  /** Vazio só em assinatura cuja 1ª cobrança o Asaas ainda não gerou. */
  invoiceUrl: string
  /** Já existia uma igual aberta, criada há pouco — link reaproveitado. */
  reused: boolean
  /** "WhatsApp", "e-mail", "WhatsApp e e-mail" ou null quando não enviou. */
  sentVia: string | null
  sendError: string | null
  connectionLabel: string
  /** Id da assinatura no Asaas, quando foi recorrência. */
  subscriptionId?: string | null
}

/** Recusa por conta (15/09): a tela oferece "Usar a conta X" ou "Cadastrar também na Y". */
export type ManualChargeOutcome = ActionResult<ManualChargeResult> & { otherConnection?: { id: string; label: string } }

export async function createChargeManual(input: ManualChargeInput): Promise<ManualChargeOutcome> {
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
      .select({ id: contacts.id, name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { ok: false, error: 'Contato não encontrado.' }

  // 🛡️ Trava do documento (15/09), ANTES de gravar e-mail na ficha e de abrir
  // conversa: uma tentativa que o servidor vai recusar não deixa rastro. Só
  // banco (digitado > carteira > ficha), a mesma regra do createChargeForContact.
  const pre = await precheckChargeDocument(accountId, input.contactId, input.connectionId, input.cpfCnpj)
  if (!pre.ok) {
    if (pre.invalidDocument) return { ok: false, code: 'invalid_document', error: MANUAL_INVALID_DOCUMENT_ERROR }
    if (pre.needsDocument) return { ok: false, code: 'needs_document', error: MANUAL_DOCUMENT_REQUIRED_ERROR }
    return { ok: false, error: `Não dá para gerar: ${pre.reason}.` }
  }

  // E-mail digitado aqui também fica na ficha, se ela ainda não tinha um —
  // senão o operador redigita a cada cobrança. Nunca sobrescreve o que existe.
  const emailDigitado = (input.email ?? '').trim()
  if (emailDigitado && !contact.email?.trim()) {
    await db
      .update(contacts)
      .set({ email: emailDigitado, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, accountId)))
  }

  // Por onde o link vai — decidido ANTES de criar: se não dá para enviar, o
  // operador escolhe desmarcar o envio, em vez de ficar com cobrança criada e
  // link parado.
  let targets: Awaited<ReturnType<typeof resolveCollectionTargets>> | null = null
  if (input.sendLink) {
    // O e-mail digitado no formulário vale como destino se o contato não tiver.
    targets = await resolveCollectionTargets(accountId, input.contactId, null, { fallbackEmail: input.email })
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
    recurring: input.recurring === 'MONTHLY' ? 'MONTHLY' : null,
    email: input.email?.trim() || null,
    billingAddress: {
      postalCode: input.postalCode ?? null,
      address: input.address ?? null,
      addressNumber: input.addressNumber ?? null,
      complement: input.complement ?? null,
      province: input.province ?? null,
    },
    allowNewCustomerHere: input.allowNewCustomerHere === true,
  })
  if (!created.ok) {
    // O cliente já existe noutra conta do Asaas e a conta foi escolhida aqui:
    // nada foi criado; a tela oferece trocar a conta ou cadastrar também nesta.
    if (created.otherConnection) {
      return {
        ok: false,
        error: accountRefusalText(created.otherConnection.label, pre.connection.label),
        otherConnection: { id: created.otherConnection.id, label: created.otherConnection.label },
      }
    }
    if (created.invalidDocument) return { ok: false, code: 'invalid_document', error: MANUAL_INVALID_DOCUMENT_ERROR }
    // Com documento indo e o Asaas reclamando do CPF/CNPJ, o motivo dele é mais
    // útil que "falta o documento" — mas o campo é o mesmo.
    if (created.needsDocument) return { ok: false, code: 'needs_document', error: pre.doc ? created.reason : MANUAL_DOCUMENT_REQUIRED_ERROR }
    return { ok: false, error: created.reason }
  }

  let sentVia: string | null = null
  let sendError: string | null = null
  // Assinatura cuja 1ª cobrança ainda não existe: sem link pra mandar agora.
  if (targets?.ok && created.invoiceUrl) {
    // 11/09 (João): a primeira palavra crua virava "Oi, Dom!" para
    // "Dom Burguer Susan". Mesma regra da régua (greetingName), e o nome do
    // ASAAS na frente do apelido do CRM — que às vezes é só o número.
    const asaasName = firstOrNull(
      await db
        .select({ name: asaasCharges.customerName })
        .from(asaasCharges)
        .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, input.contactId)))
        .orderBy(desc(asaasCharges.updatedAt))
        .limit(1),
    )?.name
    const nomeBase = asaasName?.trim() || (looksLikeBarePhone(contact.name) ? null : contact.name)
    const firstName = greetingName(nomeBase)
    const text = manualChargeMessage(
      firstName,
      value,
      dueDate!,
      input.recurring === 'MONTHLY' ? `${description} · assinatura mensal` : description,
      created.invoiceUrl,
    )
    const convIds = [targets.whatsapp?.conversationId, targets.email?.conversationId].filter((c): c is string => !!c)
    try {
      for (const cid of convIds) {
        await sendMessageToConversation(accountId, {
          conversationId: cid,
          messageType: 'text',
          contentText: text,
          subject: 'Link para pagamento',
          // Na conversa de e-mail, o endereço resolvido (contato, formulário ou Asaas).
          emailTo: cid === targets.email?.conversationId ? targets.email.address : null,
        })
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
  return {
    ok: true,
    data: {
      invoiceUrl: created.invoiceUrl,
      reused: created.reused,
      sentVia,
      sendError,
      connectionLabel: created.connectionLabel,
      subscriptionId: created.subscriptionId ?? null,
    },
  }
}

// ------------------------------- Nova cobrança: documento e conta (15/09)
// Leituras leves (só banco, nenhuma chamada ao Asaas) que o diálogo faz ao
// escolher o contato. Falha vira { ok:false } — nunca "sem documento" ou "sem
// histórico" fingido, senão a tela afirmaria algo que não conferiu.

export interface ChargeDocumentStatus {
  known: boolean
  /** Só o mascarado ("123.***.***-09") — o documento inteiro não sai do servidor. */
  masked: string | null
  source: 'wallet' | 'custom_field' | null
  /** Nome do cadastro no Asaas da cobrança que deu o documento (carteira). */
  asaasName: string | null
}

/** Já temos o CPF/CNPJ deste contato? A mesma regra da trava (carteira > ficha). */
export async function getChargeDocumentStatus(contactId: string): Promise<ActionResult<ChargeDocumentStatus>> {
  const { accountId } = await requireRole('agent')
  try {
    const contact = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, error: 'Contato não encontrado.' }
    const r = await resolveChargeDocument(accountId, contactId)
    const source = r.source === 'wallet' || r.source === 'custom_field' ? r.source : null
    return {
      ok: true,
      data: {
        known: !!r.doc,
        masked: r.doc ? maskDocument(r.doc) : null,
        source: r.doc ? source : null,
        asaasName: r.doc ? r.asaasName : null,
      },
    }
  } catch (err) {
    console.error('[cobranca] conferir documento (tela) falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não deu para conferir o cadastro agora.' }
  }
}

export interface ContactAsaasAccount {
  /** Contas LIGADAS da conta do CRM. Com 1, a tela não muda nada. */
  enabledCount: number
  /** A conta da última cobrança do cliente, se ligada (com uma conta só, ela). null = sem sugestão. */
  suggestedId: string | null
  /** Onde o cliente tem cobrança no CRM, mais recente primeiro (ligadas ou não). */
  accounts: AccountHistoryView[]
  /** O histórico só está numa conta desligada. */
  disabledHomeLabel: string | null
}

/**
 * Em qual conta do Asaas este cliente já é cobrado — para o diálogo pré-escolher
 * a conta (a conta segue o cliente). Mesma regra da IA e do dono
 * (decideConnection sem conta pedida), mas a tela só pré-escolhe pelo
 * HISTÓRICO: sem ele, com 2+ contas, quem gera escolhe.
 */
export async function getContactAsaasAccount(contactId: string): Promise<ActionResult<ContactAsaasAccount>> {
  const { accountId } = await getCurrentAccount()
  try {
    const contact = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, error: 'Contato não encontrado.' }

    const enabled = await enabledConnectionsOf(accountId)
    // Uma conta só (ou nenhuma): não há o que decidir — nem lê o histórico.
    if (enabled.length <= 1) {
      return { ok: true, data: { enabledCount: enabled.length, suggestedId: enabled[0]?.id ?? null, accounts: [], disabledHomeLabel: null } }
    }
    const { doc } = await resolveChargeDocument(accountId, contactId)
    const history = await connectionHistoryFor(accountId, contactId, doc ? [doc] : [])
    const d = decideConnection({ enabled, history, requestedId: null })
    return {
      ok: true,
      data: {
        enabledCount: enabled.length,
        suggestedId: d.source === 'history' && d.conn ? d.conn.id : null,
        // Só o que a tela precisa — a linha da conexão tem a chave criptografada.
        accounts: history.map((h) => ({ id: h.connectionId, label: h.label, enabled: h.enabled, charges: h.charges, lastAt: h.lastAt })),
        disabledHomeLabel: d.disabledHomeLabel ?? null,
      },
    }
  } catch (err) {
    console.error('[cobranca] conferir conta do cliente (tela) falhou:', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Não deu para conferir a conta deste cliente agora.' }
  }
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
    // Instante da lista: quem existia até aqui fica calado se não sobrar ninguém.
    const listedAt = new Date().toISOString()
    const all = await listAllCustomers(c.cred)
    const pending = all.filter((cu) => (cu.notificationDisabled === true) !== disabled)
    const batch = pending.slice(0, NOTIFICATIONS_BATCH)
    const calados: string[] = []
    let changed = 0
    let failed = 0
    for (const cu of batch) {
      try {
        await setCustomerNotifications(c.cred, cu.id, disabled)
        changed++
        if (disabled) calados.push(cu.id)
      } catch (err) {
        failed++
        if (err instanceof AsaasApiError && err.status === 429) break
      }
    }
    if (calados.length) {
      // 🔕 Revisão 17/09 (aviso de cobrança nova): guarda quando o CRM calou
      // esses clientes e quais cobranças deles já existiam (listadas logo
      // depois — essas o Asaas avisou; as que nascerem daqui em diante, não).
      await recordSilenced(c.id, calados, await listChargesAtSilencing(c.cred))
    }
    const remaining = pending.length - changed
    const now = new Date().toISOString()
    await db
      .update(asaasConnections)
      .set({ notificationsOffAt: disabled ? (remaining === 0 ? now : null) : null, updatedAt: now })
      .where(eq(asaasConnections.id, c.id))
    // Todos calados = varredura completa: vale como piso do aviso de cobrança
    // nova (só grava se "o CRM assume os avisos" já estava ligado antes).
    if (disabled && remaining === 0) await markAsaasNotificationsSwept(accountId, listedAt)
    revalidatePath('/cobrancas')
    return { ok: true, data: { changed, alreadyDone: all.length - pending.length, failed, total: all.length, remaining } }
  } catch (err) {
    return { ok: false, error: err instanceof AsaasApiError ? err.message : 'Não foi possível falar com o Asaas.' }
  }
}

export interface CepLookup {
  /** Logradouro, sem número. */
  address: string | null
  /** Bairro. */
  province: string | null
  city: string | null
  state: string | null
  error?: string
}

/**
 * Preenche o endereço a partir do CEP (BrasilAPI, pública e grátis — a mesma
 * usada na busca de CNPJ em Dados da empresa).
 *
 * 11/09 (Alex, a partir do João): "tem como colocar o CEP e já carregar o
 * endereço?". O CRM já fazia isso para CNPJ; para CEP é a mesma porta.
 * Cidade e estado voltam só para conferência — quem grava esses dois é o
 * Asaas, pelo próprio CEP.
 */
export async function lookupCep(cep: string): Promise<CepLookup> {
  await getCurrentAccount()
  const digits = (cep ?? '').replace(/\D/g, '')
  const vazio: CepLookup = { address: null, province: null, city: null, state: null }
  if (digits.length !== 8) return { ...vazio, error: 'CEP precisa ter 8 dígitos.' }
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cep/v2/${digits}`, {
      // Mesma pegadinha do CNPJ: sem user-agent de browser o Cloudflare devolve 403.
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; FluxiaCRM/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      return { ...vazio, error: res.status === 404 ? 'CEP não encontrado.' : 'Não foi possível consultar o CEP agora.' }
    }
    const d = (await res.json()) as Record<string, unknown>
    const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string).trim() : '')
    return {
      address: s('street') || null,
      province: s('neighborhood') || null,
      city: s('city') || null,
      state: s('state') || null,
    }
  } catch {
    // Falha de rede nunca trava o preenchimento à mão.
    return { ...vazio, error: 'Não foi possível consultar o CEP agora. Dá para preencher à mão.' }
  }
}

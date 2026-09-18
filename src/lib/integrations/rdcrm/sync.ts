// ============================================================
// 🔁 Espelho FluxiaCRM ↔ RD Station CRM.
//
// Conta que usa o RD CRM como BASE da operação e o FluxiaCRM como "backend" (a
// IA atende e move os cards) — Zelo 18/09, pedido do consultor de RD: "a
// Fluxia manda as informações pra lá, movendo os cards, atualizando eles".
//
// IDA (card daqui → negócio de lá): o gatilho em `deals` (migração 0184) põe o
//   card na fila `crm_sync_outbox`; o worker chama `processCrmSyncOutbox` a cada
//   20 s. Pra cada card: acha (ou cria) o negócio no RD e deixa etapa e status
//   iguais aos daqui, lendo o estado AO VIVO do RD antes de mexer.
// VOLTA (negócio de lá → card daqui): webhook `crm_deal_updated` →
//   `applyRdWebhook` move/fecha o card daqui (o que o time arrasta no RD).
// Anti-eco: cada lado só mexe quando o outro está DIFERENTE — o eco de uma
//   mudança chega igual e morre sem fazer nada.
//
// Cuidados (vistos ao vivo em 18/09):
//   • lead do RD Marketing: o próprio RD cria o negócio dele segundos depois
//     da conversão — espera até 10 min por ele antes de criar um nosso;
//   • negociação do lead que já ANDOU no RD (fora da etapa de entrada) nunca é
//     puxada de volta pro pré-vendas: registra e não mexe;
//   • negócio FECHADO no RD não reabre pela API — registra a divergência.
// Sem 'server-only' — roda no worker.
// ============================================================

import { randomBytes } from 'crypto'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'

import {
  calendarEvents,
  contacts,
  crmDealLinks,
  crmIntegrations,
  crmSyncOutbox,
  db,
  dealEvents,
  deals,
  leadAdSources,
  pipelines,
  pipelineStages,
  user,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { formatMeetingWhen } from '@/lib/ai/schedule-actions'
import { rdCrm, rid, type RdContact, type RdCrmClient, type RdDeal } from './client'
import {
  canonName,
  indexRdStages,
  localStageFor,
  localStatusOf,
  lostReasonIdFor,
  phoneVariants,
  planRdUpdate,
  rdStageFor,
  rdStatusOf,
  type LocalFunnel,
  type RdStageRef,
} from './mapping'

export const RD_CRM_PROVIDER = 'rdstation_crm'
const CONTEXT_TTL_MS = 5 * 60_000
/** Lead que veio do RD Marketing: espera o negócio que o RD cria sozinho. */
const WAIT_FOR_RD_DEAL_MS = 10 * 60_000
/** Negócio de entrada do RD "é deste lead" se nasceu até 3 dias do card daqui. */
const LINK_WINDOW_MS = 3 * 86_400_000
/** Junta mudanças seguidas do mesmo card (IA move + abre card novo). */
const DEBOUNCE_MS = 20_000
const MAX_ATTEMPTS = 10

export interface RdIntegration {
  id: string
  accountId: string
  token: string
  webhookSecret: string
  config: { defaultOwnerExternalId?: string }
}

type Ctx = {
  rdIndex: ReturnType<typeof indexRdStages>
  /** Etapa de ENTRADA (1ª) de cada funil do RD. */
  rdEntryStageIds: Set<string>
  lostReasons: { id?: string; _id?: string; name?: string }[]
  rdUserIdByEmail: Map<string, string>
  funnels: LocalFunnel[]
  /** Funil de entrada dos leads do RD Marketing (fonte 'rdstation'), se houver. */
  rdLeadPipelineId: string | null
}
const ctxCache = new Map<string, { at: number; value: Ctx }>()

function toIntegration(row: typeof crmIntegrations.$inferSelect): RdIntegration {
  return {
    id: row.id,
    accountId: row.accountId,
    token: decrypt(row.tokenEncrypted),
    webhookSecret: row.webhookSecret,
    config: (row.config ?? {}) as RdIntegration['config'],
  }
}

export async function loadRdIntegration(accountId: string): Promise<RdIntegration | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(crmIntegrations)
      .where(
        and(
          eq(crmIntegrations.accountId, accountId),
          eq(crmIntegrations.provider, RD_CRM_PROVIDER),
          eq(crmIntegrations.enabled, true),
        ),
      )
      .limit(1),
  )
  return row ? toIntegration(row) : null
}

export async function loadRdIntegrationBySecret(secret: string): Promise<RdIntegration | null> {
  if (!/^[a-f0-9]{32,128}$/.test(secret)) return null
  const row = firstOrNull(
    await db
      .select()
      .from(crmIntegrations)
      .where(
        and(
          eq(crmIntegrations.webhookSecret, secret),
          eq(crmIntegrations.provider, RD_CRM_PROVIDER),
          eq(crmIntegrations.enabled, true),
        ),
      )
      .limit(1),
  )
  return row ? toIntegration(row) : null
}

async function loadCtx(integ: RdIntegration, api: RdCrmClient): Promise<Ctx> {
  const hit = ctxCache.get(integ.accountId)
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.value
  const [rdPipelines, lostReasons, rdUsers] = await Promise.all([
    api.listPipelines(),
    api.listLostReasons(),
    api.listUsers().catch(() => []),
  ])
  const rdEntryStageIds = new Set<string>()
  for (const p of rdPipelines) {
    const first = [...(p.deal_stages ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]
    const id = rid(first)
    if (id) rdEntryStageIds.add(id)
  }
  const rows = await db
    .select({
      pipelineId: pipelines.id,
      pipelineName: pipelines.name,
      stageId: pipelineStages.id,
      stageName: pipelineStages.name,
    })
    .from(pipelines)
    .innerJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
    .where(eq(pipelines.accountId, integ.accountId))
    .orderBy(asc(pipelines.name), asc(pipelineStages.position))
  const byFunnel = new Map<string, LocalFunnel>()
  for (const r of rows) {
    const f = byFunnel.get(r.pipelineId) ?? { id: r.pipelineId, name: r.pipelineName, stages: [] }
    f.stages.push({ id: r.stageId, name: r.stageName })
    byFunnel.set(r.pipelineId, f)
  }
  const source = firstOrNull(
    await db
      .select({ pipelineId: leadAdSources.pipelineId })
      .from(leadAdSources)
      .where(and(eq(leadAdSources.accountId, integ.accountId), eq(leadAdSources.provider, 'rdstation')))
      .limit(1),
  )
  const rdUserIdByEmail = new Map<string, string>()
  for (const u of rdUsers) {
    const id = rid(u)
    if (id && u.email && u.active !== false) rdUserIdByEmail.set(u.email.trim().toLowerCase(), id)
  }
  const value: Ctx = {
    rdIndex: indexRdStages(rdPipelines),
    rdEntryStageIds,
    lostReasons,
    rdUserIdByEmail,
    funnels: [...byFunnel.values()],
    rdLeadPipelineId: source?.pipelineId ?? null,
  }
  ctxCache.set(integ.accountId, { at: Date.now(), value })
  return value
}

type LocalDeal = {
  id: string
  title: string
  status: string
  lostReason: string | null
  stageId: string
  pipelineId: string
  assignedTo: string | null
  contactId: string | null
  origin: string | null
  createdAt: string | null
  pipelineName: string
  stageName: string
}

async function loadLocalDeal(accountId: string, dealId: string): Promise<LocalDeal | null> {
  return firstOrNull(
    await db
      .select({
        id: deals.id,
        title: deals.title,
        status: deals.status,
        lostReason: deals.lostReason,
        stageId: deals.stageId,
        pipelineId: deals.pipelineId,
        assignedTo: deals.assignedTo,
        contactId: deals.contactId,
        origin: deals.origin,
        createdAt: deals.createdAt,
        pipelineName: pipelines.name,
        stageName: pipelineStages.name,
      })
      .from(deals)
      .innerJoin(pipelines, eq(pipelines.id, deals.pipelineId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  ) as LocalDeal | null
}

/** Contato do RD do lead (e-mail primeiro, depois as variações de telefone). */
async function findRdContact(
  api: RdCrmClient,
  c: { email: string | null; phone: string | null },
): Promise<RdContact | null> {
  if (c.email) {
    const byEmail = await api.findContacts({ email: c.email.trim().toLowerCase() })
    if (byEmail.length) return byEmail[0]
  }
  for (const phone of phoneVariants(c.phone)) {
    const byPhone = await api.findContacts({ phone })
    if (byPhone.length) return byPhone[0]
  }
  return null
}

type FindResult =
  | { kind: 'found'; deal: RdDeal; contact: RdContact }
  | { kind: 'none'; contact: RdContact | null }
  | { kind: 'wait' }
  | { kind: 'busy'; why: string }

/**
 * O negócio do RD que é ESTE card: aberto, do mesmo contato, ainda não ligado
 * a outro card daqui; no mesmo funil, ou na etapa de ENTRADA de outro funil e
 * nascido perto do card (o que o RD Marketing criou). Negócio aberto que já
 * andou no RD é do time — não puxa de volta (`busy`).
 */
async function findRdDealFor(
  api: RdCrmClient,
  ctx: Ctx,
  integ: RdIntegration,
  deal: LocalDeal,
  target: RdStageRef,
): Promise<FindResult> {
  const c = deal.contactId
    ? firstOrNull(
        await db
          .select({ email: contacts.email, phone: contacts.phone })
          .from(contacts)
          .where(eq(contacts.id, deal.contactId))
          .limit(1),
      )
    : null
  const contact = c ? await findRdContact(api, c) : null
  const openIds = [
    ...new Set(
      (contact?.deals ?? [])
        .filter((d) => d.win == null && !d.closed_at)
        .map((d) => rid(d))
        .filter((id): id is string => !!id),
    ),
  ]
  const linked = openIds.length
    ? new Set(
        (
          await db
            .select({ externalId: crmDealLinks.externalId })
            .from(crmDealLinks)
            .where(
              and(
                eq(crmDealLinks.provider, RD_CRM_PROVIDER),
                eq(crmDealLinks.accountId, integ.accountId),
                inArray(crmDealLinks.externalId, openIds),
              ),
            )
        ).map((r) => r.externalId),
      )
    : new Set<string>()
  const free = openIds.filter((id) => !linked.has(id))
  const candidates = (await Promise.all(free.map((id) => api.getDeal(id).catch(() => null)))).filter(
    (d): d is RdDeal => !!d,
  )
  const createdMs = deal.createdAt ? Date.parse(deal.createdAt) : Date.now()
  const pipelineOf = (d: RdDeal) =>
    d.deal_pipeline ? rid(d.deal_pipeline) : ctx.rdIndex.byStageId.get(rid(d.deal_stage) ?? '')?.pipelineId ?? null
  const sameFunnel = candidates.find((d) => pipelineOf(d) === target.pipelineId)
  if (sameFunnel && contact) return { kind: 'found', deal: sameFunnel, contact }
  const entry = candidates.find((d) => {
    const stageId = rid(d.deal_stage)
    const born = d.created_at ? Date.parse(d.created_at) : 0
    return !!stageId && ctx.rdEntryStageIds.has(stageId) && Math.abs(born - createdMs) <= LINK_WINDOW_MS
  })
  if (entry && contact) return { kind: 'found', deal: entry, contact }
  if (candidates.length) {
    const d = candidates[0]
    const where = ctx.rdIndex.byStageId.get(rid(d.deal_stage) ?? '')
    return {
      kind: 'busy',
      why: `lead já tem negócio aberto no RD${where ? ` em "${where.pipelineName} › ${where.stageName}"` : ''} — não mexo`,
    }
  }
  // Nada aberto. Lead que veio do RD Marketing, no funil de entrada e recém-
  // chegado: o RD ainda vai criar o negócio dele — espera.
  const young = Date.now() - createdMs < WAIT_FOR_RD_DEAL_MS
  if (young && deal.origin === 'RD Station' && ctx.rdLeadPipelineId === deal.pipelineId) return { kind: 'wait' }
  return { kind: 'none', contact }
}

async function rdOwnerFor(integ: RdIntegration, ctx: Ctx, assignedTo: string | null): Promise<string | null> {
  if (assignedTo) {
    const u = firstOrNull(await db.select({ email: user.email }).from(user).where(eq(user.id, assignedTo)).limit(1))
    const id = u?.email ? ctx.rdUserIdByEmail.get(u.email.trim().toLowerCase()) : undefined
    if (id) return id
  }
  return integ.config.defaultOwnerExternalId ?? null
}

async function createRdDeal(
  api: RdCrmClient,
  integ: RdIntegration,
  ctx: Ctx,
  deal: LocalDeal,
  target: RdStageRef,
  rdContact: RdContact | null,
): Promise<RdDeal> {
  const c = deal.contactId
    ? firstOrNull(
        await db
          .select({ name: contacts.name, email: contacts.email, phone: contacts.phone })
          .from(contacts)
          .where(eq(contacts.id, deal.contactId))
          .limit(1),
      )
    : null
  const name = (c?.name || deal.title.replace(/^Lead\s+—\s+/i, '') || 'Lead').trim().slice(0, 200)
  const owner = await rdOwnerFor(integ, ctx, deal.assignedTo)
  const body: Record<string, unknown> = {
    deal: { name: name.length >= 2 ? name : `Lead ${name}`, deal_stage_id: target.stageId, ...(owner ? { user_id: owner } : {}) },
  }
  // Contato: o que JÁ existe no RD entra pelo PUT (não duplica); sem contato
  // lá, cria junto com o negócio.
  if (!rdContact && c && (c.email || c.phone)) {
    body.contacts = [
      {
        name: name.length >= 2 ? name : `Lead ${name}`,
        ...(c.email ? { emails: [{ email: c.email }] } : {}),
        ...(c.phone ? { phones: [{ phone: `+${c.phone.replace(/\D/g, '')}`, type: 'cellphone' }] } : {}),
      },
    ]
  }
  const created = await api.createDeal(body)
  const createdId = rid(created)
  if (!createdId) throw new Error('RD não devolveu o id do negócio criado')
  const contactId = rid(rdContact)
  if (contactId) {
    const full = await api.getContact(contactId).catch(() => null)
    const ids = [...new Set([...(full?.deal_ids ?? []), createdId])]
    await api.setContactDeals(contactId, ids)
  }
  return created
}

async function saveLink(
  accountId: string,
  dealId: string,
  externalId: string,
  state: { stageId: string | null; status: string; error?: string | null },
): Promise<void> {
  await db
    .insert(crmDealLinks)
    .values({
      accountId,
      provider: RD_CRM_PROVIDER,
      dealId,
      externalId,
      externalStageId: state.stageId,
      externalStatus: state.status,
      syncedAt: new Date().toISOString(),
      lastError: state.error ?? null,
    })
    .onConflictDoUpdate({
      target: [crmDealLinks.provider, crmDealLinks.dealId],
      set: {
        externalId,
        externalStageId: state.stageId,
        externalStatus: state.status,
        syncedAt: sql`now()`,
        lastError: state.error ?? null,
        updatedAt: sql`now()`,
      },
    })
}

/** Texto da anotação de ganho no RD: a reunião futura do lead, se houver. */
async function wonNoteFor(accountId: string, deal: LocalDeal): Promise<string> {
  if (deal.contactId) {
    const ev = firstOrNull(
      await db
        .select({ startsAt: calendarEvents.startsAt })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.accountId, accountId),
            eq(calendarEvents.contactId, deal.contactId),
            eq(calendarEvents.status, 'confirmed'),
            gt(calendarEvents.startsAt, new Date().toISOString()),
          ),
        )
        .orderBy(asc(calendarEvents.startsAt))
        .limit(1),
    )
    if (ev) {
      const tz = (await getAccountSettings(accountId)).businessTimezone || 'America/Sao_Paulo'
      return `Ganho via FluxiaCRM — IA marcou a reunião para ${formatMeetingWhen(ev.startsAt, tz)}.`
    }
  }
  return 'Ganho via FluxiaCRM.'
}

export type SyncOutcome =
  | { kind: 'ok'; note?: string }
  | { kind: 'skip'; why: string }
  | { kind: 'wait' }

/** IDA: deixa o negócio do RD igual a este card. */
export async function syncDealToRd(accountId: string, dealId: string): Promise<SyncOutcome> {
  const integ = await loadRdIntegration(accountId)
  if (!integ) return { kind: 'skip', why: 'sem integração ligada' }
  const api = rdCrm(integ.token)
  const ctx = await loadCtx(integ, api)
  const deal = await loadLocalDeal(accountId, dealId)
  if (!deal) return { kind: 'skip', why: 'card não existe mais' }
  const target = rdStageFor(ctx.rdIndex, deal.pipelineName, deal.stageName)
  if (!target) return { kind: 'skip', why: `"${deal.pipelineName} › ${deal.stageName}" não tem par no RD` }
  const status = localStatusOf(deal.status)

  const link = firstOrNull(
    await db
      .select()
      .from(crmDealLinks)
      .where(and(eq(crmDealLinks.provider, RD_CRM_PROVIDER), eq(crmDealLinks.dealId, dealId)))
      .limit(1),
  )
  let rdDeal: RdDeal | null = link ? await api.getDeal(link.externalId) : null
  let note: string | undefined
  if (!rdDeal) {
    const found = await findRdDealFor(api, ctx, integ, deal, target)
    if (found.kind === 'wait') return { kind: 'wait' }
    if (found.kind === 'busy') return { kind: 'skip', why: found.why }
    if (found.kind === 'found') {
      rdDeal = found.deal
      note = 'ligado ao negócio que já existia no RD'
    } else {
      rdDeal = await createRdDeal(api, integ, ctx, deal, target, found.contact)
      note = 'negócio criado no RD'
    }
  }
  const externalId = rid(rdDeal)
  if (!externalId) throw new Error('negócio do RD sem id')
  const have = { stageId: rid(rdDeal.deal_stage), status: rdStatusOf(rdDeal) }
  const lostReasonId = status === 'lost' ? lostReasonIdFor(ctx.lostReasons, deal.lostReason) : null
  const plan = planRdUpdate({ want: { stageId: target.stageId, status, lostReasonId }, have })
  if (plan.blocked) {
    await saveLink(accountId, dealId, externalId, { stageId: have.stageId, status: have.status, error: plan.blocked })
    return { kind: 'ok', note: plan.blocked }
  }
  let stageNow = have.stageId
  if (plan.moveTo) {
    const moved = await api.updateDeal(externalId, { deal_stage_id: plan.moveTo })
    stageNow = rid(moved.deal_stage) ?? plan.moveTo
  }
  let statusNow = have.status
  if (plan.close === 'won') {
    await api.updateDeal(externalId, { deal: { win: true } })
    statusNow = 'won'
    // "Motivo do ganho" (Jordan/Zelo): o RD não tem campo pra isso — vai como
    // anotação no negócio, com a reunião que a IA marcou quando houver.
    try {
      const author = rid(rdDeal.user) ?? integ.config.defaultOwnerExternalId ?? null
      if (author) await api.createActivity(externalId, author, await wonNoteFor(accountId, deal))
    } catch (err) {
      console.error('[rd-crm] anotação do ganho falhou:', err instanceof Error ? err.message : err)
    }
  } else if (plan.close === 'lost') {
    const reasonText = (deal.lostReason ?? '').trim()
    const exact = lostReasonIdFor(ctx.lostReasons, reasonText)
    const exactMatches = ctx.lostReasons.some((r) => canonName(r.name) === canonName(reasonText))
    await api.updateDeal(externalId, {
      deal: {
        win: false,
        ...(exact ? { deal_lost_reason_id: exact } : {}),
        // Motivo que o RD não tem (caiu em "Outros") vai por escrito na nota.
        deal_lost_note: exactMatches || !reasonText ? 'Via FluxiaCRM' : `Via FluxiaCRM — ${reasonText.slice(0, 200)}`,
      },
    })
    statusNow = 'lost'
  }
  await saveLink(accountId, dealId, externalId, { stageId: stageNow, status: statusNow })
  return { kind: 'ok', note }
}

/**
 * Processa a fila (worker, a cada 20 s). Um card por vez, na ordem da 1ª
 * mudança — o card que a IA fechou sincroniza ANTES do card novo que ela abriu,
 * senão o novo poderia pegar pra si o negócio que é do fechado.
 */
export async function processCrmSyncOutbox(limit = 40): Promise<{ ok: number; failed: number; waiting: number }> {
  const rows = await db
    .select()
    .from(crmSyncOutbox)
    .where(isNull(crmSyncOutbox.processedAt))
    .orderBy(asc(crmSyncOutbox.createdAt))
    .limit(500)
  const order: string[] = []
  const byDeal = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!byDeal.has(r.dealId)) {
      byDeal.set(r.dealId, [])
      order.push(r.dealId)
    }
    byDeal.get(r.dealId)!.push(r)
  }
  let ok = 0
  let failed = 0
  let waiting = 0
  for (const dealId of order.slice(0, limit)) {
    const group = byDeal.get(dealId)!
    const newest = Math.max(...group.map((g) => Date.parse(g.createdAt)))
    if (Date.now() - newest < DEBOUNCE_MS) {
      waiting += 1
      continue
    }
    const ids = group.map((g) => g.id)
    try {
      const out = await syncDealToRd(group[0].accountId, dealId)
      if (out.kind === 'wait') {
        waiting += 1
        continue
      }
      await db
        .update(crmSyncOutbox)
        .set({ processedAt: sql`now()`, lastError: out.kind === 'skip' ? out.why : (out.note ?? null) })
        .where(inArray(crmSyncOutbox.id, ids))
      if (out.kind === 'ok' && out.note) console.log(`[rd-crm] card ${dealId}: ${out.note}`)
      ok += 1
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      const attempts = Math.max(...group.map((g) => g.attempts)) + 1
      console.error(`[rd-crm] card ${dealId} (tentativa ${attempts}):`, msg)
      await db
        .update(crmSyncOutbox)
        .set({
          attempts,
          lastError: msg.slice(0, 500),
          ...(attempts >= MAX_ATTEMPTS ? { processedAt: sql`now()` } : {}),
        })
        .where(inArray(crmSyncOutbox.id, ids))
    }
  }
  return { ok, failed, waiting }
}

/**
 * VOLTA: evento do RD (webhook) → card daqui. Só negócio já ligado a um card.
 * O que o time arrasta no RD (No-show, Envio da COF…) move o card aqui —
 * é o gatilho das cadências por etapa.
 */
export async function applyRdWebhook(integ: RdIntegration, payload: unknown): Promise<string> {
  const p = (payload ?? {}) as {
    event_name?: string
    document?: {
      id?: string
      status?: string
      deal_stage?: { id?: string; name?: string }
      deal_pipeline?: { id?: string; name?: string }
      deal_lost_reason?: { id?: string; name?: string } | null
    }
  }
  const doc = p.document
  if (!doc?.id || (p.event_name && p.event_name !== 'crm_deal_updated')) return 'ignorado'
  const link = firstOrNull(
    await db
      .select()
      .from(crmDealLinks)
      .where(
        and(
          eq(crmDealLinks.provider, RD_CRM_PROVIDER),
          eq(crmDealLinks.accountId, integ.accountId),
          eq(crmDealLinks.externalId, doc.id),
        ),
      )
      .limit(1),
  )
  if (!link) return 'sem vínculo'
  const deal = await loadLocalDeal(integ.accountId, link.dealId)
  if (!deal) return 'card não existe mais'
  const ctx = await loadCtx(integ, rdCrm(integ.token))
  const stageRef = doc.deal_stage?.id ? ctx.rdIndex.byStageId.get(doc.deal_stage.id) : undefined
  const pipelineName = doc.deal_pipeline?.name ?? stageRef?.pipelineName ?? ''
  const stageName = doc.deal_stage?.name ?? stageRef?.stageName ?? ''
  const local = localStageFor(ctx.funnels, pipelineName, stageName)
  const rdStatus = rdStatusOf({ status: doc.status })
  const ourStatus = localStatusOf(deal.status)
  const changes: string[] = []

  if (local && local.stageId !== deal.stageId) {
    await db
      .update(deals)
      .set({ pipelineId: local.pipelineId, stageId: local.stageId, stageChangedAt: sql`now()` })
      .where(and(eq(deals.id, deal.id), eq(deals.accountId, integ.accountId)))
    await db.insert(dealEvents).values({
      accountId: integ.accountId,
      dealId: deal.id,
      actorUserId: null,
      type: 'stage_changed',
      data: {
        from: `${deal.pipelineName} › ${deal.stageName}`,
        to: `${local.pipelineName} › ${local.stageName}`,
        fromId: deal.stageId,
        toId: local.stageId,
        by: 'rd',
      },
    })
    if (rdStatus === 'open') {
      try {
        const { autoCreateStageTasks } = await import('@/lib/pipelines/stage-tasks')
        await autoCreateStageTasks({ accountId: integ.accountId, userId: null }, deal.id, local.stageId)
      } catch (err) {
        console.error('[rd-crm] tarefas da etapa (volta):', err)
      }
    }
    changes.push(`etapa → ${local.pipelineName} › ${local.stageName}`)
  }
  if (rdStatus !== ourStatus) {
    const reason = rdStatus === 'lost' ? (doc.deal_lost_reason?.name ?? null) : null
    await db
      .update(deals)
      .set({ status: rdStatus, lostReason: reason })
      .where(and(eq(deals.id, deal.id), eq(deals.accountId, integ.accountId)))
    await db.insert(dealEvents).values({
      accountId: integ.accountId,
      dealId: deal.id,
      actorUserId: null,
      type: 'status_changed',
      data: {
        from: ourStatus,
        to: rdStatus,
        ...(reason ? { reason } : {}),
        ...(rdStatus === 'lost' ? { stageId: local?.stageId ?? deal.stageId } : {}),
        by: 'rd',
      },
    })
    changes.push(`status → ${rdStatus}`)
  }
  await saveLink(integ.accountId, deal.id, doc.id, { stageId: doc.deal_stage?.id ?? null, status: rdStatus })
  return changes.length ? changes.join('; ') : 'já estava igual'
}

/** Liga a integração numa conta (script de instalação): grava o token cifrado. */
export async function upsertRdIntegration(input: {
  accountId: string
  token: string
  config: RdIntegration['config']
}): Promise<{ id: string; webhookSecret: string }> {
  const secret = randomBytes(24).toString('hex')
  const [row] = await db
    .insert(crmIntegrations)
    .values({
      accountId: input.accountId,
      provider: RD_CRM_PROVIDER,
      tokenEncrypted: encrypt(input.token),
      webhookSecret: secret,
      config: input.config,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [crmIntegrations.accountId, crmIntegrations.provider],
      set: { tokenEncrypted: encrypt(input.token), config: input.config, enabled: true, updatedAt: sql`now()` },
    })
    .returning({ id: crmIntegrations.id, webhookSecret: crmIntegrations.webhookSecret })
  return row
}

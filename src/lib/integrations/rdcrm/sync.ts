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
// E em 01/10 (Zelo):
//   • card COPIADO entre funis espera o card de origem se ligar, e o negócio
//     novo herda campanha, fonte e campos personalizados do negócio de origem;
//   • 1ª ligação com negócio que já estava ADIANTE no RD traz o card daqui pra
//     frente, em vez de puxar o RD de volta;
//   • comentário da perda vai na nota da perda;
//   • tarefas concluídas (toques de cadência) vão pela fila `crm_task_outbox`.
// Sem 'server-only' — roda no worker.
// ============================================================

import { randomBytes } from 'crypto'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'

import {
  calendarEvents,
  contacts,
  crmDealLinks,
  crmIntegrations,
  crmSyncOutbox,
  customFields,
  db,
  dealCustomValues,
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
import { claimOnce, kvDel } from '@/lib/ai/reply-marker'
import { factForFieldName, isGenericOrigin } from '@/lib/leads/lead-facts'
import { isRdRejection, RdCrmError, rdCrm, rid, type RdContact, type RdCrmClient, type RdDeal } from './client'
import {
  buildRdDealBody,
  canonName,
  indexRdStages,
  inheritFromRdDeal,
  localStageFor,
  localStatusOf,
  lostReasonIdFor,
  phoneVariants,
  planRdUpdate,
  rdLostNote,
  rdOriginNote,
  rdStageFor,
  rdStatusOf,
  type LocalFunnel,
  type RdInherited,
  type RdStageRef,
} from './mapping'
import { pushTaskToRd, rdTaskDateHour } from './task-outbox'

export const RD_CRM_PROVIDER = 'rdstation_crm'
const CONTEXT_TTL_MS = 5 * 60_000
/** Lead que veio do RD Marketing: espera o negócio que o RD cria sozinho. */
const WAIT_FOR_RD_DEAL_MS = 10 * 60_000
/** Card COPIADO de outro espera o de origem se ligar no máximo isto (ver
 *  originStillLinking) — 3× a espera do RD Marketing, folga pras tentativas. */
const ORIGIN_WAIT_CAP_MS = 3 * WAIT_FOR_RD_DEAL_MS
/** Negócio de entrada do RD "é deste lead" se nasceu até 3 dias do card daqui. */
const LINK_WINDOW_MS = 3 * 86_400_000
/** Junta mudanças seguidas do mesmo card (IA move + abre card novo). */
const DEBOUNCE_MS = 20_000
const MAX_ATTEMPTS = 10
/** Trava da rodada da fila — ver processCrmSyncOutbox. */
const TICK_LOCK_KEY = 'crm-sync:tick-lock'
const TICK_LOCK_TTL_S = 240
/** Rodada para de pegar card novo depois disso (bem antes da trava vencer). */
const TICK_BUDGET_MS = 60_000
/** Fila de tarefas (drainTaskOutbox): por rodada, no máximo isto… */
const TASK_BATCH = 5
/** …e pelo menos esta fatia de tempo, mesmo que a fila de cards tenha gasto
 *  o orçamento todo (senão tarefa nunca sairia num dia de muito card). */
const TASK_MIN_SLICE_MS = 15_000
const TASK_MAX_ATTEMPTS = 10
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  /** "Fonte" do card (texto livre) — vai na anotação de origem do negócio novo. */
  source: string | null
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
        source: deals.source,
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

// ------------------------------------------------------------
// Card nascido de OUTRO card (cópia entre funis: a IA ganha o pré-vendas e
// abre o card do comercial — cross-funnel.ts grava `created` com fromDealId).
// ------------------------------------------------------------

/** Id do card de ORIGEM, quando este card é cópia de outro; senão null. */
async function originDealIdOf(accountId: string, dealId: string): Promise<string | null> {
  const ev = firstOrNull(
    await db
      .select({ fromDealId: sql<string | null>`${dealEvents.data}->>'fromDealId'` })
      .from(dealEvents)
      .where(
        and(
          eq(dealEvents.accountId, accountId),
          eq(dealEvents.dealId, dealId),
          eq(dealEvents.type, 'created'),
          sql`(${dealEvents.data}->>'fromDealId') IS NOT NULL`,
        ),
      )
      .orderBy(desc(dealEvents.createdAt))
      .limit(1),
  )
  const id = ev?.fromDealId ?? null
  return id && UUID_RE.test(id) && id !== dealId ? id : null
}

/**
 * O card de ORIGEM ainda não terminou a própria ida pro RD (sem vínculo e com
 * mudança na fila)? Então ESTE card espera — o de origem tem que se ligar
 * primeiro.
 *
 * Zelo 01/10: lead do RD Marketing chega no pré-vendas e o espelho espera até
 * 10 min (WAIT_FOR_RD_DEAL_MS) pelo negócio que o próprio RD cria. Se a IA
 * qualifica rápido e abre o card do comercial nesse meio-tempo, o card NOVO
 * sincronizava antes: achava o negócio do RD Marketing (etapa de entrada,
 * nascido agora) e o levava pro comercial; o card de origem, sem negócio livre,
 * criava OUTRO no pré-vendas — pré-vendas duplicado no RD.
 *
 * "Ainda na fila" cobre a espera do RD Marketing (enquanto espera, as linhas do
 * card de origem ficam pendentes) e também o debounce e as novas tentativas
 * depois de erro; acaba sozinho, porque a fila do card de origem sempre termina
 * (liga, pula ou desiste em MAX_ATTEMPTS). Card de origem que já foi processado
 * sem se ligar (funil sem par no RD, negócio "do time") não segura ninguém.
 */
async function originStillLinking(accountId: string, originDealId: string): Promise<boolean> {
  const linked = firstOrNull(
    await db
      .select({ id: crmDealLinks.id })
      .from(crmDealLinks)
      .where(and(eq(crmDealLinks.provider, RD_CRM_PROVIDER), eq(crmDealLinks.dealId, originDealId)))
      .limit(1),
  )
  if (linked) return false
  const pending = firstOrNull(
    await db
      .select({ id: crmSyncOutbox.id })
      .from(crmSyncOutbox)
      .where(
        and(
          eq(crmSyncOutbox.accountId, accountId),
          eq(crmSyncOutbox.dealId, originDealId),
          isNull(crmSyncOutbox.processedAt),
        ),
      )
      .limit(1),
  )
  return !!pending
}

/**
 * Campanha, fonte e campos personalizados do negócio RD do card de ORIGEM.
 * Sem vínculo, ou o negócio de lá sumiu (404) / RD fora do ar: nada a herdar —
 * o negócio novo nasce como sempre nasceu, nunca deixa de nascer por isso.
 */
async function inheritFromOrigin(api: RdCrmClient, originDealId: string): Promise<RdInherited | null> {
  const link = firstOrNull(
    await db
      .select({ externalId: crmDealLinks.externalId })
      .from(crmDealLinks)
      .where(and(eq(crmDealLinks.provider, RD_CRM_PROVIDER), eq(crmDealLinks.dealId, originDealId)))
      .limit(1),
  )
  if (!link) return null
  const rd = await api.getDeal(link.externalId).catch((err) => {
    console.warn(
      `[rd-crm] negócio de origem ${link.externalId} não lido — card novo nasce sem herdar campanha/fonte:`,
      err instanceof Error ? err.message : err,
    )
    return null
  })
  const inherit = inheritFromRdDeal(rd)
  return inherit.campaignId || inherit.dealSourceId || inherit.customFields.length ? inherit : null
}

/** Valor ÚTIL do campo personalizado "Campanha" do card (genérico = nada). */
async function campaignFieldOf(dealId: string): Promise<string | null> {
  const rows = await db
    .select({ fieldName: customFields.fieldName, value: dealCustomValues.value })
    .from(dealCustomValues)
    .innerJoin(customFields, eq(customFields.id, dealCustomValues.customFieldId))
    .where(eq(dealCustomValues.dealId, dealId))
  for (const r of rows) {
    const v = (r.value ?? '').trim()
    if (v && factForFieldName(r.fieldName) === 'campanha' && !isGenericOrigin(v)) return v
  }
  return null
}

async function createRdDeal(
  api: RdCrmClient,
  integ: RdIntegration,
  ctx: Ctx,
  deal: LocalDeal,
  target: RdStageRef,
  rdContact: RdContact | null,
  originDealId: string | null,
): Promise<{ deal: RdDeal; note: string }> {
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
  const inherit = originDealId ? await inheritFromOrigin(api, originDealId) : null
  const base = {
    name,
    stageId: target.stageId,
    ownerId: owner,
    // Contato: o que JÁ existe no RD entra pelo PUT (não duplica); sem contato
    // lá, cria junto com o negócio.
    newContact: !rdContact && c ? { email: c.email, phone: c.phone } : null,
    inherit,
  }
  // Tentativas, da mais completa pra mais simples. 4xx = o RD RECUSOU e nada
  // foi criado, então tentar de novo não duplica; erro de rede/tempo/5xx NÃO
  // tenta aqui (o negócio pode ter sido criado) — sobe e a fila conta a
  // tentativa, como sempre. Campo personalizado é o suspeito nº 1 (obrigatório
  // em outro funil, opção que não existe mais); campanha/fonte apagadas, o 2º.
  const tries: { withCustomFields: boolean; withCampaign: boolean; dropped: string | null }[] = [
    { withCustomFields: true, withCampaign: true, dropped: null },
  ]
  if (inherit?.customFields.length) {
    tries.push({ withCustomFields: false, withCampaign: true, dropped: 'campos personalizados' })
  }
  if (inherit && (inherit.campaignId || inherit.dealSourceId)) {
    tries.push({
      withCustomFields: false,
      withCampaign: false,
      dropped: inherit.customFields.length ? 'campos personalizados, campanha e fonte' : 'campanha e fonte',
    })
  }
  let created: RdDeal | null = null
  let dropped: string | null = null
  let refusal = ''
  for (const [i, t] of tries.entries()) {
    try {
      created = await api.createDeal(buildRdDealBody({ ...base, ...t }))
      dropped = t.dropped
      break
    } catch (err) {
      if (i === tries.length - 1 || !isRdRejection(err)) throw err
      refusal = err instanceof Error ? err.message.slice(0, 200) : String(err)
      console.warn(`[rd-crm] card ${deal.id}: RD recusou o negócio com o que veio da origem — tento sem. ${refusal}`)
    }
  }
  if (!created) throw new Error('RD não criou o negócio')
  const createdId = rid(created)
  if (!createdId) throw new Error('RD não devolveu o id do negócio criado')
  const contactId = rid(rdContact)
  if (contactId) {
    const full = await api.getContact(contactId).catch(() => null)
    const ids = [...new Set([...(full?.deal_ids ?? []), createdId])]
    await api.setContactDeals(contactId, ids)
  }
  const notes = ['negócio criado no RD']
  if (inherit && !dropped) notes.push('com campanha/fonte/campos do negócio de origem')
  if (dropped) notes.push(`SEM ${dropped} do negócio de origem (RD recusou: ${refusal})`)
  // De onde o lead veio, UMA vez, na criação: o RD não tem campo que o time
  // veja no negócio do comercial, e a campanha do card daqui (RD Marketing /
  // anúncio) se perderia na passagem. Best-effort — mas o motivo da falha fica
  // na fila (last_error), não só no log.
  try {
    const text = rdOriginNote(await campaignFieldOf(deal.id), deal.source)
    const author = owner ?? rid(created.user) ?? integ.config.defaultOwnerExternalId ?? null
    if (text && author) await api.createActivity(createdId, author, text)
    else if (text) notes.push('anotação da origem não gravada: negócio sem dono no RD')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[rd-crm] anotação da origem falhou:', msg)
    notes.push(`anotação da origem falhou: ${msg.slice(0, 120)}`)
  }
  return { deal: created, note: notes.join('; ') }
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

/**
 * Comentário da ÚLTIMA perda do card ([[PERDER:motivo | comentário]] da IA, ou
 * o que a pessoa escreveu ao perder) — `markDealLostInPlace` grava em
 * `deal_events.data.note`. Falha na leitura = sem comentário: a perda vai pro
 * RD do mesmo jeito.
 */
async function lostCommentOf(accountId: string, dealId: string): Promise<string | null> {
  try {
    const ev = firstOrNull(
      await db
        .select({ note: sql<string | null>`${dealEvents.data}->>'note'` })
        .from(dealEvents)
        .where(
          and(
            eq(dealEvents.accountId, accountId),
            eq(dealEvents.dealId, dealId),
            eq(dealEvents.type, 'status_changed'),
            sql`${dealEvents.data}->>'to' = 'lost'`,
          ),
        )
        .orderBy(desc(dealEvents.createdAt))
        .limit(1),
    )
    return ev?.note?.trim() || null
  } catch (err) {
    console.error('[rd-crm] comentário da perda não lido:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Card daqui → etapa que veio do RD, registrado como mudança DO RD (evento
 * `stage_changed` com by:'rd' + tarefas da etapa). Um caminho só pros dois
 * casos: o webhook (o time arrastou lá) e a 1ª ligação com um negócio que já
 * estava ADIANTE no RD. Devolve false quando outro caminho mudou a etapa do
 * card entre a leitura e a escrita (nada é gravado).
 */
async function moveLocalStageFromRd(
  accountId: string,
  deal: LocalDeal,
  local: { pipelineId: string; stageId: string; pipelineName: string; stageName: string },
  createStageTasks: boolean,
): Promise<boolean> {
  // ⚠️ 29/09: o UPDATE exige que a etapa AINDA seja a que acabamos de ler.
  //
  // O RD dispara mais de uma notificação para a mesma mudança, com
  // `transaction_uuid` diferente — então o dedupe do webhook não pega. As três
  // chegaram em 0,3 s no card da Aline, leram a etapa antiga antes de qualquer
  // uma escrever, e as três acharam que precisavam mover: 3 eventos
  // `stage_changed` idênticos no histórico e `autoCreateStageTasks` rodando
  // três vezes. Ler-comparar-escrever sem trava sempre acaba assim quando o
  // mesmo fato chega duas vezes junto.
  //
  // Com a etapa lida no WHERE, quem chega depois não atualiza nada, não grava
  // evento e não cria tarefa — o banco arbitra, que é o único árbitro que
  // enxerga as três ao mesmo tempo.
  const moved = await db
    .update(deals)
    .set({ pipelineId: local.pipelineId, stageId: local.stageId, stageChangedAt: sql`now()` })
    .where(
      and(
        eq(deals.id, deal.id),
        eq(deals.accountId, accountId),
        deal.stageId ? eq(deals.stageId, deal.stageId) : isNull(deals.stageId),
      ),
    )
    .returning({ id: deals.id })
  if (!moved.length) return false
  await db.insert(dealEvents).values({
    accountId,
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
  if (createStageTasks) {
    try {
      const { autoCreateStageTasks } = await import('@/lib/pipelines/stage-tasks')
      await autoCreateStageTasks({ accountId, userId: null }, deal.id, local.stageId)
    } catch (err) {
      console.error('[rd-crm] tarefas da etapa (volta):', err)
    }
  }
  return true
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
  // Cópia de outro card: o de origem se liga primeiro (ver originStillLinking).
  // Antes de qualquer chamada ao RD — esperar não gasta requisição. Teto de
  // ORIGIN_WAIT_CAP_MS desde que ESTE card nasceu: a fila do de origem sempre
  // termina bem antes; se não terminou, algo saiu do previsto e esperar mais
  // só deixaria o card fora do RD sem ninguém saber.
  const originDealId = link ? null : await originDealIdOf(accountId, dealId)
  const bornMs = deal.createdAt ? Date.parse(deal.createdAt) : Date.now()
  if (
    originDealId &&
    Date.now() - bornMs < ORIGIN_WAIT_CAP_MS &&
    (await originStillLinking(accountId, originDealId))
  ) {
    return { kind: 'wait' }
  }

  let rdDeal: RdDeal | null = link ? await api.getDeal(link.externalId) : null
  let note: string | undefined
  let firstLink = false
  if (!rdDeal) {
    const found = await findRdDealFor(api, ctx, integ, deal, target)
    if (found.kind === 'wait') return { kind: 'wait' }
    if (found.kind === 'busy') return { kind: 'skip', why: found.why }
    if (found.kind === 'found') {
      rdDeal = found.deal
      note = 'ligado ao negócio que já existia no RD'
      firstLink = true
    } else {
      const made = await createRdDeal(api, integ, ctx, deal, target, found.contact, originDealId)
      rdDeal = made.deal
      note = made.note
    }
  }
  const externalId = rid(rdDeal)
  if (!externalId) throw new Error('negócio do RD sem id')
  const have = { stageId: rid(rdDeal.deal_stage), status: rdStatusOf(rdDeal) }
  let wantStage = target
  // 1ª ligação com negócio que JÁ estava ADIANTE no RD, no mesmo funil: o time
  // andou com ele lá (ou o RD criou já na frente). Puxar o RD de volta pra
  // etapa do card desfaz trabalho do time e redispara a automação daquela
  // etapa no RD — então o card daqui é que vai pra etapa de lá, registrado
  // como mudança do RD (o mesmo caminho do webhook). RD atrás: move o RD,
  // como sempre.
  //
  // Não é só na 1ª ligação (revisão de 01/10): com o vínculo já existente,
  // qualquer mudança daqui (até o rodízio trocando o responsável) passava a
  // puxar o RD de volta. Regras, com o RD ADIANTE no mesmo funil:
  //   • etapa do RD SEM par aqui → o RD nunca volta (não há como representá-la);
  //   • 1ª ligação, ou o RD mudou desde a última sincronização (o time andou lá
  //     e o webhook ainda não chegou / se perdeu) → o card daqui vai pra etapa
  //     de lá;
  //   • o RD está onde o deixamos e o card daqui é que está atrás → foi uma
  //     pessoa voltando o card aqui: move o RD, como sempre.
  if (have.stageId) {
    const rdRef = ctx.rdIndex.byStageId.get(have.stageId)
    if (rdRef && rdRef.pipelineId === target.pipelineId && rdRef.position > target.position) {
      const local = localStageFor(ctx.funnels, rdRef.pipelineName, rdRef.stageName)
      const rdChangedSinceSync = !!link?.externalStageId && link.externalStageId !== have.stageId
      if (!local) {
        wantStage = rdRef
        if (firstLink || rdChangedSinceSync) {
          note = `${note ? `${note}; ` : ''}RD já em "${rdRef.stageName}", sem etapa igual aqui — RD não volta`
        }
      } else if (firstLink || rdChangedSinceSync) {
        wantStage = rdRef
        if (local.stageId !== deal.stageId) {
          const moved = await moveLocalStageFromRd(accountId, deal, local, status === 'open')
          const prefix = note ? `${note}; ` : ''
          note = moved
            ? `${prefix}card trazido para "${local.stageName}" (o RD já estava adiante)`
            : `${prefix}card mudou ao mesmo tempo — RD fica em "${rdRef.stageName}" até a próxima rodada`
        }
      }
    }
  }
  const lostReasonId = status === 'lost' ? lostReasonIdFor(ctx.lostReasons, deal.lostReason) : null
  const plan = planRdUpdate({ want: { stageId: wantStage.stageId, status, lostReasonId }, have })
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
        // Motivo que o RD não tem (caiu em "Outros") vai por escrito na nota,
        // junto do comentário de quem perdeu (01/10: o "porquê" da IA —
        // "disse que só volta a pensar em março" — ficava só aqui dentro).
        deal_lost_note: rdLostNote({
          reason: reasonText,
          reasonMatchedExactly: exactMatches,
          note: await lostCommentOf(accountId, dealId),
        }),
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
 *
 * Uma rodada por vez (trava no Redis): no deploy o worker velho e o novo rodam
 * juntos por alguns segundos e os dois pegaram o mesmo card (18/09). Redis
 * fora do ar segue sem trava, como antes.
 *
 * Depois dos cards, na MESMA trava, as tarefas concluídas (`drainTaskOutbox`):
 * card primeiro porque a tarefa precisa do vínculo que a ida do card cria.
 */
export async function processCrmSyncOutbox(limit = 40): Promise<{
  ok: number
  failed: number
  waiting: number
  tasksSent: number
  tasksFailed: number
}> {
  if ((await claimOnce(TICK_LOCK_KEY, TICK_LOCK_TTL_S)) === false) {
    return { ok: 0, failed: 0, waiting: 0, tasksSent: 0, tasksFailed: 0 }
  }
  try {
    const started = Date.now()
    const cards = await drainOutbox(limit, started)
    let tasks = { sent: 0, failed: 0 }
    try {
      tasks = await drainTaskOutbox(Math.max(started + TICK_BUDGET_MS, Date.now() + TASK_MIN_SLICE_MS))
    } catch (err) {
      // Fila de tarefas fora (ex.: migração 0202 ainda não aplicada) não pode
      // derrubar a ida dos cards — mas aparece no log a cada rodada.
      console.error('[rd-crm] fila de tarefas falhou:', err instanceof Error ? err.message : err)
      tasks = { sent: 0, failed: 1 }
    }
    return { ...cards, tasksSent: tasks.sent, tasksFailed: tasks.failed }
  } finally {
    await kvDel(TICK_LOCK_KEY)
  }
}

async function drainOutbox(
  limit: number,
  started = Date.now(),
): Promise<{ ok: number; failed: number; waiting: number }> {
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
    // Rodada curta: o resto fica pra próxima (e a trava nunca vence no meio).
    if (Date.now() - started > TICK_BUDGET_MS) break
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

type TaskOutboxRow = {
  id: string
  account_id: string
  deal_id: string
  kind: string
  subject: string
  notes: string | null
  done_at: string | Date
  attempts: number
  rd_deal_id: string
}

/**
 * Leva pro RD as tarefas concluídas da fila `crm_task_outbox` (migração 0202;
 * quem enfileira é `enqueueRdTask`). Até TASK_BATCH por rodada, até `deadline`.
 *   • card sem negócio ligado no RD: espera (a ida do card cria o vínculo);
 *     24 h sem vínculo = desiste e diz por quê;
 *   • com vínculo: dono do negócio lá (ou o dono padrão da integração) vira o
 *     responsável da tarefa; data/hora no fuso da conta; `pushTaskToRd` confere
 *     se a tarefa já existe antes de criar (POST que estourou o tempo).
 *   • erro: conta a tentativa; desiste em TASK_MAX_ATTEMPTS (ou na hora, se o
 *     negócio do RD não existe mais — 404 não melhora tentando).
 */
async function drainTaskOutbox(deadline: number): Promise<{ sent: number; failed: number }> {
  await db.execute(sql`
    UPDATE crm_task_outbox o
    SET processed_at = now(),
        last_error = 'card sem negócio ligado no RD em 24 h — tarefa não enviada'
    WHERE o.processed_at IS NULL
      AND o.created_at < now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM crm_deal_links l
        WHERE l.deal_id = o.deal_id AND l.provider = 'rdstation_crm'
      )
  `)
  const res = await db.execute(sql`
    SELECT o.id, o.account_id, o.deal_id, o.kind, o.subject, o.notes, o.done_at, o.attempts,
           l.external_id AS rd_deal_id
    FROM crm_task_outbox o
    INNER JOIN crm_deal_links l ON l.deal_id = o.deal_id AND l.provider = 'rdstation_crm'
    WHERE o.processed_at IS NULL
    -- Menos tentativas primeiro: a que falha não monopoliza o lote.
    ORDER BY o.attempts, o.created_at
    LIMIT ${TASK_BATCH}::int
  `)
  const rows = res.rows as TaskOutboxRow[]
  const finish = (id: string, out: { externalId?: string; error?: string }) =>
    db.execute(sql`
      UPDATE crm_task_outbox
      SET processed_at = now(),
          external_id = ${out.externalId ?? null}::text,
          last_error = ${out.error ?? null}::text
      WHERE id = ${id}::uuid
    `)
  const accounts = new Map<string, { integ: RdIntegration | null; tz: string }>()
  // Dono do negócio no RD, uma consulta por negócio por rodada (o limite é
  // 120 req/min e a fila de cards divide a mesma cota).
  const owners = new Map<string, string | null>()
  let sent = 0
  let failed = 0
  for (const r of rows) {
    if (Date.now() > deadline) break
    try {
      let acc = accounts.get(r.account_id)
      if (!acc) {
        const integ = await loadRdIntegration(r.account_id)
        const tz = integ ? (await getAccountSettings(r.account_id)).businessTimezone || 'America/Sao_Paulo' : ''
        acc = { integ, tz }
        accounts.set(r.account_id, acc)
      }
      if (!acc.integ) {
        await finish(r.id, { error: 'integração com o RD desligada — tarefa não enviada' })
        continue
      }
      const api = rdCrm(acc.integ.token)
      if (!owners.has(r.rd_deal_id)) owners.set(r.rd_deal_id, rid((await api.getDeal(r.rd_deal_id)).user) ?? null)
      const userId = owners.get(r.rd_deal_id) ?? acc.integ.config.defaultOwnerExternalId ?? null
      if (!userId) {
        await finish(r.id, { error: 'negócio do RD sem dono e integração sem dono padrão — tarefa não enviada' })
        continue
      }
      const { date, hour } = rdTaskDateHour(new Date(r.done_at), acc.tz)
      const out = await pushTaskToRd(api, {
        rdDealId: r.rd_deal_id,
        userId,
        kind: r.kind === 'email' ? 'email' : 'whatsapp',
        subject: r.subject,
        notes: r.notes,
        date,
        hour,
      })
      await finish(r.id, { externalId: out.id, error: out.reused ? 'já estava no RD (tentativa anterior)' : undefined })
      sent += 1
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      const attempts = (Number(r.attempts) || 0) + 1
      // 429 = cota do minuto: não é culpa da tarefa — não conta tentativa e
      // para o lote (insistir tiraria cota da fila de cards). 4xx definitivo
      // (corpo recusado, 404) desiste na hora: repetir não melhora e gastaria
      // ~4 requisições por tentativa (revisão de 01/10).
      //   401/403 (token do RD revogado/vencido) também param o lote sem contar
      //   tentativa: a culpa é da integração, não da tarefa — descartar na 1ª
      //   perderia a fila inteira até alguém trocar o token. Desiste na hora só
      //   em recusa do CORPO/negócio (400/404/409/422); 408 é tentativa comum.
      const status = err instanceof RdCrmError ? err.status : 0
      const rateLimited = status === 429 || status === 401 || status === 403
      const giveUp = !rateLimited && (attempts >= TASK_MAX_ATTEMPTS || [400, 404, 409, 422].includes(status))
      console.error(`[rd-crm] tarefa ${r.id} do card ${r.deal_id} (tentativa ${attempts}):`, msg)
      await db.execute(sql`
        UPDATE crm_task_outbox
        SET attempts = ${rateLimited ? attempts - 1 : attempts}::int,
            last_error = ${msg.slice(0, 500)}::text,
            processed_at = ${giveUp ? sql`now()` : sql`NULL`}
        WHERE id = ${r.id}::uuid
      `)
      if (rateLimited) break
    }
  }
  return { sent, failed }
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
  /** false = outro webhook simultâneo já aplicou a etapa (ver a trava abaixo). */
  let movedStage = true

  if (local && local.stageId !== deal.stageId) {
    // Compare-and-swap da etapa (29/09, notificação tripla do RD) — ver
    // moveLocalStageFromRd.
    movedStage = await moveLocalStageFromRd(integ.accountId, deal, local, rdStatus === 'open')
    // Perdeu a corrida: outro webhook já moveu. Não grava evento nem cria
    // tarefa — mas SEGUE, porque a mesma carga pode trazer um status novo que
    // ninguém aplicou ainda. Sair aqui perderia um "ganho" chegando junto.
    if (!movedStage) {
      console.log(
        `[rd-crm] etapa já aplicada por outra notificação simultânea (card ${deal.id}) — sem evento duplicado`,
      )
    } else {
      changes.push(`etapa → ${local.pipelineName} › ${local.stageName}`)
    }
  }
  if (rdStatus !== ourStatus) {
    const reason = rdStatus === 'lost' ? (doc.deal_lost_reason?.name ?? null) : null
    // Mesma trava do bloco de etapa: ganho/perda repetido gravaria dois eventos
    // e dispararia duas vezes o que escuta "negócio ganho" (pós-venda, comissão).
    const changed = await db
      .update(deals)
      .set({ status: rdStatus, lostReason: reason })
      .where(
        and(
          eq(deals.id, deal.id),
          eq(deals.accountId, integ.accountId),
          eq(deals.status, deal.status),
        ),
      )
      .returning({ id: deals.id })
    if (changed.length) {
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
  }
  await saveLink(integ.accountId, deal.id, doc.id, { stageId: doc.deal_stage?.id ?? null, status: rdStatus })
  if (changes.length) return changes.join('; ')
  return movedStage ? 'já estava igual' : 'aplicado por outra notificação'
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

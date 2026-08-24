'use server'

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import {
  db,
  cadences,
  cadenceSteps,
  cadenceEnrollments,
  cadenceEvents,
  scheduledMessages,
  conversations,
  deals,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import {
  enrollContactInCadence,
  cancelEnrollment,
  type StepChannel,
} from '@/lib/cadences/cadence'

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------
export interface CadenceStepInput {
  delayValue: number
  delayUnit: 'minutes' | 'hours' | 'days'
  channel: StepChannel
  subject?: string | null
  body: string
}

export interface CadenceInput {
  name: string
  description?: string | null
  active?: boolean
  pauseOnReply?: boolean
  steps: CadenceStepInput[]
}

export interface CadenceRow {
  id: string
  name: string
  description: string | null
  active: boolean
  pause_on_reply: boolean
  step_count: number
  active_enrollments: number
}

export interface CadenceStepRow {
  id: string
  position: number
  delay_value: number
  delay_unit: string
  channel: string
  subject: string | null
  body: string
}

export interface CadenceDetail {
  id: string
  name: string
  description: string | null
  active: boolean
  pause_on_reply: boolean
  steps: CadenceStepRow[]
}

const UNITS = new Set(['minutes', 'hours', 'days'])
const CHANNELS = new Set(['whatsapp', 'email', 'instagram'])

function sanitizeSteps(steps: CadenceStepInput[]): {
  position: number
  delayValue: number
  delayUnit: string
  channel: string
  subject: string | null
  body: string
}[] {
  return (steps ?? [])
    .map((s, i) => ({
      position: i,
      delayValue: Number.isFinite(s.delayValue) ? Math.max(0, Math.trunc(s.delayValue)) : 0,
      delayUnit: UNITS.has(s.delayUnit) ? s.delayUnit : 'days',
      channel: CHANNELS.has(s.channel) ? s.channel : 'whatsapp',
      subject: (s.subject ?? '').trim() || null,
      body: (s.body ?? '').trim(),
    }))
    .filter((s) => s.body.length > 0)
}

// ------------------------------------------------------------
// CRUD das cadências
// ------------------------------------------------------------
export async function listCadences(): Promise<CadenceRow[]> {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        id: cadences.id,
        name: cadences.name,
        description: cadences.description,
        active: cadences.active,
        pause_on_reply: cadences.pauseOnReply,
        step_count: sql<number>`(SELECT count(*)::int FROM cadence_steps s WHERE s.cadence_id = "cadences"."id")`,
        active_enrollments: sql<number>`(SELECT count(*)::int FROM cadence_enrollments e WHERE e.cadence_id = "cadences"."id" AND e.status = 'active')`,
      })
      .from(cadences)
      .where(eq(cadences.accountId, ctx.accountId))
      .orderBy(desc(cadences.createdAt))
    return rows
  } catch (err) {
    console.error('[listCadences]', err)
    return []
  }
}

export async function getCadence(id: string): Promise<CadenceDetail | null> {
  try {
    const ctx = await getCurrentAccount()
    const cad = firstOrNull(
      await db
        .select({
          id: cadences.id,
          name: cadences.name,
          description: cadences.description,
          active: cadences.active,
          pause_on_reply: cadences.pauseOnReply,
        })
        .from(cadences)
        .where(and(eq(cadences.id, id), eq(cadences.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!cad) return null
    const steps = await db
      .select({
        id: cadenceSteps.id,
        position: cadenceSteps.position,
        delay_value: cadenceSteps.delayValue,
        delay_unit: cadenceSteps.delayUnit,
        channel: cadenceSteps.channel,
        subject: cadenceSteps.subject,
        body: cadenceSteps.body,
      })
      .from(cadenceSteps)
      .where(and(eq(cadenceSteps.cadenceId, id), eq(cadenceSteps.accountId, ctx.accountId)))
      .orderBy(asc(cadenceSteps.position))
    return { ...cad, steps }
  } catch (err) {
    console.error('[getCadence]', err)
    return null
  }
}

async function replaceSteps(accountId: string, cadenceId: string, steps: CadenceStepInput[]) {
  const clean = sanitizeSteps(steps)
  await db.delete(cadenceSteps).where(eq(cadenceSteps.cadenceId, cadenceId))
  if (clean.length > 0) {
    await db.insert(cadenceSteps).values(
      clean.map((s) => ({
        accountId,
        cadenceId,
        position: s.position,
        delayValue: s.delayValue,
        delayUnit: s.delayUnit,
        channel: s.channel,
        subject: s.subject,
        body: s.body,
        updatedAt: sql`now()`,
      })),
    )
  }
}

export async function createCadence(
  input: CadenceInput,
): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = (input.name ?? '').trim()
    if (!name) return { id: null, error: 'Dê um nome à cadência.' }
    const row = firstOrThrow(
      await db
        .insert(cadences)
        .values({
          accountId: ctx.accountId,
          name,
          description: (input.description ?? '').trim() || null,
          active: input.active ?? true,
          pauseOnReply: input.pauseOnReply ?? true,
          createdBy: ctx.userId,
          updatedAt: sql`now()`,
        })
        .returning({ id: cadences.id }),
    )
    await replaceSteps(ctx.accountId, row.id, input.steps)
    return { id: row.id, error: null }
  } catch (err) {
    console.error('[createCadence]', err)
    return { id: null, error: 'Falha ao criar a cadência.' }
  }
}

export async function updateCadence(
  id: string,
  input: CadenceInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = (input.name ?? '').trim()
    if (!name) return { error: 'Dê um nome à cadência.' }
    const owned = firstOrNull(
      await db
        .select({ id: cadences.id })
        .from(cadences)
        .where(and(eq(cadences.id, id), eq(cadences.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Cadência não encontrada.' }
    await db
      .update(cadences)
      .set({
        name,
        description: (input.description ?? '').trim() || null,
        active: input.active ?? true,
        pauseOnReply: input.pauseOnReply ?? true,
        updatedAt: sql`now()`,
      })
      .where(and(eq(cadences.id, id), eq(cadences.accountId, ctx.accountId)))
    await replaceSteps(ctx.accountId, id, input.steps)
    return { error: null }
  } catch (err) {
    console.error('[updateCadence]', err)
    return { error: 'Falha ao salvar a cadência.' }
  }
}

export async function deleteCadence(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.delete(cadences).where(and(eq(cadences.id, id), eq(cadences.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[deleteCadence]', err)
    return { error: 'Falha ao excluir a cadência.' }
  }
}

/** Opções pra os seletores de "colocar em cadência" (só ativas + com degrau).
 *  Retorna NULL em erro — o cliente diferencia "vazio de verdade" de "falhou"
 *  (senão um erro vira o enganoso "Nenhuma cadência criada", como no chamado
 *  do Rafael 24/08 com bundle velho). */
export async function listCadenceOptions(): Promise<
  { id: string; name: string }[] | null
> {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        id: cadences.id,
        name: cadences.name,
        steps: sql<number>`(SELECT count(*)::int FROM cadence_steps s WHERE s.cadence_id = "cadences"."id")`,
      })
      .from(cadences)
      .where(and(eq(cadences.accountId, ctx.accountId), eq(cadences.active, true)))
      .orderBy(asc(cadences.name))
    const out = rows
      .filter((r) => r.steps > 0)
      .map((r) => ({ id: r.id, name: r.name }))
    // Sentinela (bug do Rafael 24/08): cadência existir mas o count de degraus
    // vir 0 é sinal de regressão na subquery — loga pra investigar.
    if (rows.length > 0 && out.length === 0) {
      console.warn(
        `[listCadenceOptions] anomalia: conta=${ctx.accountId} total=${rows.length} com_degrau=0`,
      )
    }
    return out
  } catch (err) {
    console.error('[listCadenceOptions]', err)
    return null
  }
}

// ------------------------------------------------------------
// Enrollment (colocar/tirar lead da cadência)
// ------------------------------------------------------------
export async function enrollLeadInCadence(input: {
  cadenceId: string
  contactId?: string | null
  conversationId?: string | null
  dealId?: string | null
}): Promise<{ ok: boolean; scheduled?: number; skipped?: number; error?: string }> {
  try {
    const ctx = await getCurrentAccount()
    let contactId = input.contactId ?? null
    let conversationId = input.conversationId ?? null
    let dealId = input.dealId ?? null

    // Resolve o contato a partir da conversa ou do negócio, se preciso.
    if (!contactId && conversationId) {
      const c = firstOrNull(
        await db
          .select({ contactId: conversations.contactId })
          .from(conversations)
          .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, ctx.accountId)))
          .limit(1),
      )
      contactId = c?.contactId ?? null
    }
    if (!contactId && dealId) {
      const d = firstOrNull(
        await db
          .select({ contactId: deals.contactId })
          .from(deals)
          .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
          .limit(1),
      )
      contactId = d?.contactId ?? null
    }
    if (!contactId) return { ok: false, error: 'Lead sem contato vinculado.' }

    const res = await enrollContactInCadence(
      { accountId: ctx.accountId, userId: ctx.userId },
      { cadenceId: input.cadenceId, contactId, conversationId, dealId },
    )
    return res.ok
      ? { ok: true, scheduled: res.scheduled, skipped: res.skipped }
      : { ok: false, error: res.error }
  } catch (err) {
    console.error('[enrollLeadInCadence]', err)
    return { ok: false, error: 'Falha ao iniciar a cadência.' }
  }
}

export async function stopLeadCadence(enrollmentId: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const ok = await cancelEnrollment(ctx.accountId, enrollmentId)
    return { error: ok ? null : 'Inscrição não encontrada.' }
  } catch (err) {
    console.error('[stopLeadCadence]', err)
    return { error: 'Falha ao encerrar a cadência.' }
  }
}

// ------------------------------------------------------------
// Leitura pro painel da conversa / card do funil
// ------------------------------------------------------------
export interface CadenceStateEvent {
  type: string
  step_position: number | null
  channel: string | null
  created_at: string
  data: Record<string, unknown>
}

export interface CadenceState {
  enrollment_id: string
  cadence_id: string
  cadence_name: string
  status: string
  enrolled_at: string
  total: number
  sent: number
  pending: number
  next_at: string | null
  events: CadenceStateEvent[]
}

async function buildStateForEnrollment(
  accountId: string,
  enr: {
    id: string
    cadenceId: string
    status: string
    enrolledAt: string
    name: string
  },
): Promise<CadenceState> {
  const counts = firstOrNull(
    await db
      .select({
        total: sql<number>`count(*)::int`,
        sent: sql<number>`count(*) FILTER (WHERE status = 'sent')::int`,
        pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
        next_at: sql<string | null>`min(scheduled_at) FILTER (WHERE status = 'pending')`,
      })
      .from(scheduledMessages)
      .where(eq(scheduledMessages.cadenceEnrollmentId, enr.id)),
  )
  const events = await db
    .select({
      type: cadenceEvents.type,
      step_position: cadenceEvents.stepPosition,
      channel: cadenceEvents.channel,
      created_at: cadenceEvents.createdAt,
      data: cadenceEvents.data,
    })
    .from(cadenceEvents)
    .where(eq(cadenceEvents.enrollmentId, enr.id))
    .orderBy(desc(cadenceEvents.createdAt))
    .limit(20)
  return {
    enrollment_id: enr.id,
    cadence_id: enr.cadenceId,
    cadence_name: enr.name,
    status: enr.status,
    enrolled_at: enr.enrolledAt,
    total: counts?.total ?? 0,
    sent: counts?.sent ?? 0,
    pending: counts?.pending ?? 0,
    next_at: counts?.next_at ?? null,
    events: events as CadenceStateEvent[],
  }
}

/** Indicador leve (2 lookups indexados) — só diz se há cadência ATIVA + nome.
 *  Pro dot/rótulo do botão no compositor sem puxar o histórico inteiro. */
export async function getCadenceBadge(input: {
  conversationId?: string | null
  dealId?: string | null
}): Promise<{ active: boolean; name: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    let contactId: string | null = null
    if (input.conversationId) {
      const c = firstOrNull(
        await db
          .select({ contactId: conversations.contactId })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      )
      contactId = c?.contactId ?? null
    } else if (input.dealId) {
      const d = firstOrNull(
        await db
          .select({ contactId: deals.contactId })
          .from(deals)
          .where(and(eq(deals.id, input.dealId), eq(deals.accountId, ctx.accountId)))
          .limit(1),
      )
      contactId = d?.contactId ?? null
    }
    if (!contactId) return { active: false, name: null }
    const enr = firstOrNull(
      await db
        .select({ name: cadences.name })
        .from(cadenceEnrollments)
        .innerJoin(cadences, eq(cadences.id, cadenceEnrollments.cadenceId))
        .where(
          and(
            eq(cadenceEnrollments.accountId, ctx.accountId),
            eq(cadenceEnrollments.contactId, contactId),
            eq(cadenceEnrollments.status, 'active'),
          ),
        )
        .limit(1),
    )
    return { active: !!enr, name: enr?.name ?? null }
  } catch {
    return { active: false, name: null }
  }
}

/** Cadência mais recente (ativa ou não) de um contato — pro painel da conversa. */
export async function getContactCadenceState(input: {
  contactId?: string | null
  conversationId?: string | null
}): Promise<CadenceState | null> {
  try {
    const ctx = await getCurrentAccount()
    let contactId = input.contactId ?? null
    if (!contactId && input.conversationId) {
      const c = firstOrNull(
        await db
          .select({ contactId: conversations.contactId })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.conversationId),
              eq(conversations.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      )
      contactId = c?.contactId ?? null
    }
    if (!contactId) return null
    const enr = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          status: cadenceEnrollments.status,
          enrolledAt: cadenceEnrollments.enrolledAt,
          name: cadences.name,
        })
        .from(cadenceEnrollments)
        .innerJoin(cadences, eq(cadences.id, cadenceEnrollments.cadenceId))
        .where(
          and(
            eq(cadenceEnrollments.accountId, ctx.accountId),
            eq(cadenceEnrollments.contactId, contactId),
          ),
        )
        .orderBy(desc(cadenceEnrollments.enrolledAt))
        .limit(1),
    )
    if (!enr) return null
    return buildStateForEnrollment(ctx.accountId, enr)
  } catch (err) {
    console.error('[getContactCadenceState]', err)
    return null
  }
}

/** Cadência de um negócio (pro card/detalhe do funil). */
export async function getDealCadenceState(dealId: string): Promise<CadenceState | null> {
  try {
    const ctx = await getCurrentAccount()
    const d = firstOrNull(
      await db
        .select({ contactId: deals.contactId })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!d?.contactId) return null
    return getContactCadenceState({ contactId: d.contactId })
  } catch {
    return null
  }
}

/** Ids de negócios que estão numa cadência ATIVA (pro selo no board). */
export async function listDealsInCadence(dealIds: string[]): Promise<string[]> {
  try {
    if (dealIds.length === 0) return []
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({ dealId: cadenceEnrollments.dealId })
      .from(cadenceEnrollments)
      .where(
        and(
          eq(cadenceEnrollments.accountId, ctx.accountId),
          eq(cadenceEnrollments.status, 'active'),
          inArray(cadenceEnrollments.dealId, dealIds),
        ),
      )
    return rows.map((r) => r.dealId).filter((id): id is string => !!id)
  } catch {
    return []
  }
}

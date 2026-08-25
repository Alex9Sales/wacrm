// ============================================================
// Agendamento público (tipo Calendly) — núcleo de slots + reserva.
// O lead escolhe um horário dentro das janelas semanais do dono (no fuso da
// conta); ao reservar: evento na agenda (espelhado no Google se conectado) +
// lead no funil (ingestLead, atribuído ao dono) + confirmação no WhatsApp
// (opcional) + notificação pro dono. Sem 'use server' e sem 'server-only'
// (rotas públicas). Corrida de reserva coberta por advisory lock + re-checagem.
// ============================================================

import { and, asc, eq, lt, gt, ne, sql } from 'drizzle-orm'

import {
  db,
  schedulers,
  calendars,
  calendarEvents,
  notifications,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ingestLead } from '@/lib/leads/ingest'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { pushEventToGoogle } from '@/lib/google/sync'

export interface SchedulerWindow {
  open: string | null
  close: string | null
}

export interface PublicScheduler {
  id: string
  accountId: string
  slug: string
  name: string
  headline: string | null
  description: string | null
  userId: string
  durationMinutes: number
  availability: SchedulerWindow[]
  minNoticeHours: number
  horizonDays: number
  location: string | null
  pipelineId: string | null
  stageId: string | null
  origin: string
  confirmWhatsapp: boolean
  confirmChannelId: string | null
  createdBy: string | null
}

export interface DaySlots {
  /** 'YYYY-MM-DD' no fuso da conta. */
  date: string
  /** Ex.: "seg, 25/08". */
  label: string
  slots: { iso: string; label: string }[]
}

// ------------------------------------------------------------
// Fuso: janelas "HH:MM" são relógio-de-parede no fuso da conta.
// ------------------------------------------------------------

function tzOffsetMs(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0)
  const asUtc = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour') % 24,
    g('minute'),
    g('second'),
  )
  return asUtc - date.getTime()
}

/** 'YYYY-MM-DD' local + 'HH:MM' local → instante UTC (ms). */
function wallToUtcMs(ymd: string, hm: string, tz: string): number {
  const [y, mo, d] = ymd.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  const guess = Date.UTC(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0)
  return guess - tzOffsetMs(new Date(guess), tz)
}

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}
function weekdayInTz(d: Date, tz: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(d)
  return WEEKDAY_INDEX[w] ?? 0
}

function hmInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

function dayLabelInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(d)
}

const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function normalizeAvailability(input: unknown): SchedulerWindow[] {
  const arr = Array.isArray(input) ? (input as Partial<SchedulerWindow>[]) : []
  const out: SchedulerWindow[] = []
  for (let i = 0; i < 7; i++) {
    const w = arr[i]
    const open = typeof w?.open === 'string' && HM_RE.test(w.open) ? w.open : null
    const close =
      typeof w?.close === 'string' && HM_RE.test(w.close) ? w.close : null
    out.push(open && close ? { open, close } : { open: null, close: null })
  }
  return out
}

// ------------------------------------------------------------
// Loader público + slots.
// ------------------------------------------------------------

export async function getPublicScheduler(
  slug: string,
): Promise<PublicScheduler | null> {
  if (!slug || typeof slug !== 'string' || slug.length > 80) return null
  const row = firstOrNull(
    await db
      .select()
      .from(schedulers)
      .where(and(eq(schedulers.slug, slug), eq(schedulers.active, true)))
      .limit(1),
  )
  if (!row) return null
  return {
    id: row.id,
    accountId: row.accountId,
    slug: row.slug,
    name: row.name,
    headline: row.headline,
    description: row.description,
    userId: row.userId,
    durationMinutes: Math.max(10, row.durationMinutes || 30),
    availability: normalizeAvailability(row.availability),
    minNoticeHours: Math.max(0, row.minNoticeHours ?? 12),
    horizonDays: Math.min(60, Math.max(1, row.horizonDays || 14)),
    location: row.location,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    origin: row.origin,
    confirmWhatsapp: row.confirmWhatsapp,
    confirmChannelId: row.confirmChannelId,
    createdBy: row.createdBy,
  }
}

/** Eventos confirmados do dono no horizonte (agenda local + Google importado). */
async function busyRanges(
  scheduler: PublicScheduler,
  horizonEndMs: number,
): Promise<{ start: number; end: number }[]> {
  const nowIso = new Date().toISOString()
  const endIso = new Date(horizonEndMs).toISOString()
  const rows = await db
    .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.accountId, scheduler.accountId),
        eq(calendarEvents.ownerUserId, scheduler.userId),
        ne(calendarEvents.status, 'cancelled'),
        lt(calendarEvents.startsAt, endIso),
        gt(calendarEvents.endsAt, nowIso),
      ),
    )
  return rows.map((r) => ({
    start: new Date(r.startsAt).getTime(),
    end: new Date(r.endsAt).getTime(),
  }))
}

/** Dias + horários livres do scheduler (no fuso da conta). */
export async function computeSlots(
  scheduler: PublicScheduler,
): Promise<DaySlots[]> {
  const settings = await getAccountSettings(scheduler.accountId)
  const tz = settings.businessTimezone || 'America/Sao_Paulo'
  const now = Date.now()
  const minStart = now + scheduler.minNoticeHours * 3_600_000
  const durMs = scheduler.durationMinutes * 60_000
  const horizonEnd = now + scheduler.horizonDays * 86_400_000
  const busy = await busyRanges(scheduler, horizonEnd + durMs)

  const days: DaySlots[] = []
  for (let i = 0; i < scheduler.horizonDays; i++) {
    const base = new Date(now + i * 86_400_000)
    const ymd = ymdInTz(base, tz)
    const win = scheduler.availability[weekdayInTz(base, tz)]
    if (!win?.open || !win.close) continue
    const openMs = wallToUtcMs(ymd, win.open, tz)
    const closeMs = wallToUtcMs(ymd, win.close, tz)
    const slots: { iso: string; label: string }[] = []
    for (let t = openMs; t + durMs <= closeMs; t += durMs) {
      if (t < minStart) continue
      const tEnd = t + durMs
      const conflict = busy.some((b) => b.start < tEnd && b.end > t)
      if (conflict) continue
      const d = new Date(t)
      slots.push({ iso: d.toISOString(), label: hmInTz(d, tz) })
    }
    if (slots.length > 0) {
      days.push({ date: ymd, label: dayLabelInTz(base, tz), slots })
    }
  }
  return days
}

// ------------------------------------------------------------
// Reserva.
// ------------------------------------------------------------

export interface BookInput {
  startIso: string
  nome: string
  phone: string
  email: string | null
  obs: string | null
}

export interface BookResult {
  ok: boolean
  /** true = o horário acabou de ser tomado (mostrar refresh). */
  slotTaken?: boolean
  error?: string
  whenLabel?: string
}

async function ensureCalendarId(scheduler: PublicScheduler): Promise<string> {
  const existing = firstOrNull(
    await db
      .select({ id: calendars.id })
      .from(calendars)
      .where(eq(calendars.accountId, scheduler.accountId))
      .orderBy(asc(calendars.createdAt))
      .limit(1),
  )
  if (existing) return existing.id
  const created = firstOrThrow(
    await db
      .insert(calendars)
      .values({
        accountId: scheduler.accountId,
        ownerUserId: scheduler.userId,
        createdBy: scheduler.userId,
        name: 'Minha agenda',
        color: '#6366f1',
      })
      .returning({ id: calendars.id }),
  )
  return created.id
}

class SlotTakenError extends Error {}

export async function bookSlot(
  scheduler: PublicScheduler,
  input: BookInput,
): Promise<BookResult> {
  const settings = await getAccountSettings(scheduler.accountId)
  const tz = settings.businessTimezone || 'America/Sao_Paulo'
  const startMs = new Date(input.startIso).getTime()
  if (!Number.isFinite(startMs)) return { ok: false, error: 'Horário inválido.' }
  const durMs = scheduler.durationMinutes * 60_000
  const endIso = new Date(startMs + durMs).toISOString()
  const startIso = new Date(startMs).toISOString()

  // O horário pedido tem que ser um slot VÁLIDO de hoje (janela + antecedência
  // + sem conflito) — recomputa e confere por igualdade de instante.
  const days = await computeSlots(scheduler)
  const valid = days.some((d) => d.slots.some((s) => s.iso === startIso))
  if (!valid) return { ok: false, slotTaken: true, error: 'Este horário acabou de ficar indisponível. Escolha outro.' }

  const whenLabel = `${dayLabelInTz(new Date(startMs), tz)} às ${hmInTz(new Date(startMs), tz)}`
  const nome = input.nome.trim()
  const calendarId = await ensureCalendarId(scheduler)

  // Reserva atômica: advisory lock por (dono + instante) + re-checagem do
  // conflito dentro da transação (duas pessoas no mesmo slot → uma ganha).
  let eventId: string
  try {
    eventId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scheduler.userId + '|' + startIso}))`,
      )
      const conflict = firstOrNull(
        await tx
          .select({ id: calendarEvents.id })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.accountId, scheduler.accountId),
              eq(calendarEvents.ownerUserId, scheduler.userId),
              ne(calendarEvents.status, 'cancelled'),
              lt(calendarEvents.startsAt, endIso),
              gt(calendarEvents.endsAt, startIso),
            ),
          )
          .limit(1),
      )
      if (conflict) throw new SlotTakenError()
      const created = firstOrThrow(
        await tx
          .insert(calendarEvents)
          .values({
            accountId: scheduler.accountId,
            calendarId,
            ownerUserId: scheduler.userId,
            createdBy: scheduler.createdBy ?? scheduler.userId,
            title: `Reunião — ${nome}`,
            description: [
              `Agendado pela página pública "${scheduler.name}".`,
              `WhatsApp: ${input.phone}`,
              input.email ? `E-mail: ${input.email}` : '',
              input.obs ? `Observação: ${input.obs}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            location: scheduler.location,
            startsAt: startIso,
            endsAt: endIso,
          })
          .returning({ id: calendarEvents.id }),
      )
      return created.id
    })
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return { ok: false, slotTaken: true, error: 'Este horário acabou de ser reservado. Escolha outro.' }
    }
    throw err
  }

  // Lead no funil (contato deduplicado + card + tarefa), atribuído ao dono.
  let contactId: string | null = null
  let dealId: string | null = null
  try {
    const audit = scheduler.createdBy ?? scheduler.userId
    const lead = await ingestLead(scheduler.accountId, audit, {
      rawPhone: input.phone,
      name: nome,
      email: input.email,
      notes: [
        `📅 Reunião agendada: ${whenLabel} (${scheduler.name}).`,
        input.obs ? `Observação do lead: ${input.obs}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      pipelineId: scheduler.pipelineId,
      stageId: scheduler.stageId,
      origin: scheduler.origin || 'Agendamento',
      source: `Agendamento: ${scheduler.name}`,
      assignedTo: scheduler.userId,
      taskSuffix: 'reunião agendada',
    })
    contactId = lead.contactId
    dealId = lead.dealId
    await db
      .update(calendarEvents)
      .set({ contactId, dealId })
      .where(eq(calendarEvents.id, eventId))
  } catch (err) {
    console.error('[agendar] ingestLead falhou (evento mantido):', err)
  }

  // Contador + notificação pro dono + espelho no Google + confirmação no zap
  // — tudo best-effort, a reserva já está garantida.
  try {
    await db
      .update(schedulers)
      .set({ bookings: sql`bookings + 1` })
      .where(eq(schedulers.id, scheduler.id))
  } catch {}
  try {
    await db.insert(notifications).values({
      accountId: scheduler.accountId,
      userId: scheduler.userId,
      type: 'deal_transferred',
      dealId,
      title: 'Novo agendamento 📅',
      body: `${nome} — ${whenLabel}`,
    })
  } catch (err) {
    console.error('[agendar] notificação falhou:', err)
  }
  try {
    await pushEventToGoogle(scheduler.accountId, eventId, 'create')
  } catch (err) {
    console.error('[agendar] espelho google falhou:', err)
  }
  if (scheduler.confirmWhatsapp) {
    try {
      const resolved = await resolveConversationByPhone(
        scheduler.accountId,
        input.phone,
        nome,
        scheduler.confirmChannelId,
      )
      const local = scheduler.location ? ` ${scheduler.location}.` : ''
      await sendMessageToConversation(scheduler.accountId, {
        conversationId: resolved.conversationId,
        messageType: 'text',
        contentText: `✅ Agendado! ${whenLabel} — ${scheduler.name}.${local} Se precisar remarcar, é só chamar por aqui. 👋`,
      })
    } catch (err) {
      console.error('[agendar] confirmação whatsapp falhou:', err)
    }
  }

  // 📣 Aviso no WhatsApp do responsável (se configurado na conta): cliente
  // marcou sozinho pela página pública. Best-effort.
  try {
    const { sendOwnerAlert } = await import('@/lib/alerts/owner-alerts')
    await sendOwnerAlert(
      scheduler.accountId,
      'booking',
      `📅 *NOVO AGENDAMENTO*\n\n` +
        `👤 ${nome}${input.phone ? ` · ${input.phone}` : ''}\n` +
        `🗓️ ${whenLabel} — ${scheduler.name}` +
        (scheduler.location ? `\n📍 ${scheduler.location}` : '') +
        `\n\nMarcado pela página pública de agendamento.`,
    )
  } catch (err) {
    console.error('[agendar] aviso ao responsável falhou:', err)
  }

  return { ok: true, whenLabel }
}

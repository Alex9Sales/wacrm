// ============================================================
// 📅 Horários já ocupados na Agenda — pra IA não marcar duas reuniões no mesmo
// horário. 17/09 (Limpeza com Zelo): até aqui a IA oferecia horário sem enxergar
// nada da agenda. Lê a agenda do CRM, que é para onde o sync do Google importa
// os compromissos — então cobre as duas. Sem 'server-only': o worker da IA usa.
// ============================================================

import { and, asc, eq, gte, lt } from 'drizzle-orm'

import { db, calendarEvents } from '@/db'

/** Quantos dias à frente a IA enxerga. */
export const BUSY_SLOTS_DAYS = 14
const MAX_SLOTS = 40

/** "qua 23/09 14:00–14:45" no fuso da conta (puro). Dia inteiro: "qua 23/09 (dia todo)". */
export function formatBusySlot(ev: { startsAt: string; endsAt: string; allDay?: boolean | null }, tz: string): string {
  const start = new Date(ev.startsAt)
  const end = new Date(ev.endsAt)
  const zone = (() => {
    try {
      new Intl.DateTimeFormat('pt-BR', { timeZone: tz })
      return tz
    } catch {
      return 'America/Sao_Paulo'
    }
  })()
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone: zone, weekday: 'short', day: '2-digit', month: '2-digit' })
    .format(start)
    .replace('.', '')
    .replace(',', '')
  if (ev.allDay) return `${day} (dia todo)`
  const hm = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${day} ${hm(start)}–${hm(end)}`
}

/** Compromissos confirmados dos próximos dias, já formatados. Nunca lança (erro → []). */
export async function loadBusySlots(accountId: string, tz: string, now = new Date()): Promise<string[]> {
  try {
    const until = new Date(now.getTime() + BUSY_SLOTS_DAYS * 86_400_000)
    const rows = await db
      .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, allDay: calendarEvents.allDay })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.status, 'confirmed'),
          gte(calendarEvents.endsAt, now.toISOString()),
          lt(calendarEvents.startsAt, until.toISOString()),
        ),
      )
      .orderBy(asc(calendarEvents.startsAt))
      .limit(MAX_SLOTS)
    return rows.map((r) => formatBusySlot(r, tz))
  } catch (err) {
    console.error('[ai busy-slots] agenda indisponível (segue sem):', err instanceof Error ? err.message : err)
    return []
  }
}

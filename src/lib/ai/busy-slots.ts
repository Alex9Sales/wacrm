// ============================================================
// 📅 Horários já ocupados na Agenda — pra IA não marcar duas reuniões no mesmo
// horário. 17/09 (Limpeza com Zelo): até aqui a IA oferecia horário sem enxergar
// nada da agenda. Lê a agenda do CRM, que é para onde o sync do Google importa
// os compromissos — então cobre as duas. Sem 'server-only': o worker da IA usa.
// ============================================================

import { and, asc, eq, gt, gte, isNull, lt, ne, or } from 'drizzle-orm'

import { db, calendarEvents } from '@/db'

/** Quantos dias à frente a IA enxerga. */
export const BUSY_SLOTS_DAYS = 14
const MAX_SLOTS = 40

/**
 * "qua 23/09 14:00–14:45" no fuso da conta.
 *
 * Dia inteiro vira "qua 23/09 (dia todo)" — e, quando atravessa vários dias,
 * "seg 15/09 a qui 18/09 (dia todo)". A versão anterior mostrava só o dia de
 * início: a feira de 4 dias do Renato (Equipotel, 15 a 18/09) chegava pra IA
 * como um dia só, e ela ofereceria reunião nos outros três.
 */
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
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat('pt-BR', { timeZone: zone, weekday: 'short', day: '2-digit', month: '2-digit' })
      .format(d)
      .replace('.', '')
      .replace(',', '')
  const day = dayOf(start)
  if (ev.allDay) {
    const lastDay = dayOf(end)
    return lastDay === day ? `${day} (dia todo)` : `${day} a ${lastDay} (dia todo)`
  }
  const hm = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${day} ${hm(start)}–${hm(end)}`
}

/**
 * Compromissos confirmados dos próximos dias, já formatados. Nunca lança (erro → []).
 * `excludeContactId`: a reunião DESTE lead não entra como ocupada — Zelo 18/09:
 * a IA marcou às 10h, na resposta seguinte viu "10h ocupado" (era a própria
 * reunião) e disse ao lead que precisava "ajustar o horário".
 */
export async function loadBusySlots(
  accountId: string,
  tz: string,
  now = new Date(),
  opts: { excludeContactId?: string | null } = {},
): Promise<string[]> {
  try {
    const until = new Date(now.getTime() + BUSY_SLOTS_DAYS * 86_400_000)
    const rows = await db
      .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, allDay: calendarEvents.allDay })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.status, 'confirmed'),
          opts.excludeContactId
            ? or(isNull(calendarEvents.contactId), ne(calendarEvents.contactId, opts.excludeContactId))
            : undefined,
          // "Mostrar como: Disponível" no Google não bloqueia (Zelo 18/09: um
          // evento de dia inteiro marcado como livre fechou a terça inteira).
          eq(calendarEvents.busy, true),
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

/**
 * A próxima reunião JÁ marcada com este lead ("seg 21/09 09:00–10:00"), ou null.
 * Vai pro prompt: a IA não remarca nem oferece outro horário à toa.
 */
export async function loadBookedForContact(
  accountId: string,
  contactId: string,
  tz: string,
  now = new Date(),
): Promise<string | null> {
  try {
    const row = (
      await db
        .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, allDay: calendarEvents.allDay })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.accountId, accountId),
            eq(calendarEvents.contactId, contactId),
            eq(calendarEvents.status, 'confirmed'),
            gt(calendarEvents.startsAt, now.toISOString()),
          ),
        )
        .orderBy(asc(calendarEvents.startsAt))
        .limit(1)
    )[0]
    return row ? formatBusySlot(row, tz) : null
  } catch {
    return null
  }
}

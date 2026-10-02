// ============================================================
// 📅 Horários já ocupados na Agenda — pra IA não marcar duas reuniões no mesmo
// horário. 17/09 (Limpeza com Zelo): até aqui a IA oferecia horário sem enxergar
// nada da agenda. Lê a agenda do CRM, que é para onde o sync do Google importa
// os compromissos — então cobre as duas. Sem 'server-only': o worker da IA usa.
// ============================================================

import { and, asc, eq, gt, gte, isNull, lt, ne, or } from 'drizzle-orm'

import { db, calendarEvents, calendars } from '@/db'

import { neutralizeUntrusted } from './untrusted'

/** Quantos dias à frente a IA enxerga. */
export const BUSY_SLOTS_DAYS = 14
const MAX_SLOTS = 40
/** Teto da lista por profissional (várias agendas dividem o mesmo bolo). */
const TETO_AGENDAS_DA_EQUIPE = 600

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
 * Os horários ocupados SEPARADOS POR AGENDA, para clínicas com vários
 * profissionais.
 *
 * 30/09: a clínica da Dra. Joyce tem 10 dentistas, cada um com sua agenda. A
 * lista única de `loadBusySlots` não diz de quem é cada horário, então um
 * compromisso da Dra. Bruna às 10h tirava as 10h de todos os outros nove — a IA
 * lia "10h ocupado" e não oferecia. Com o mapa por agenda ela pode responder
 * "com a Dra. Bruna não tenho, mas com o Dr. Lucas tenho 10h".
 *
 * Devolve só agendas que o Google sincroniza ou que a conta usa de fato; a
 * ordem das agendas é a de criação, que é a que a pessoa vê na tela.
 */
export async function loadBusyByCalendar(
  accountId: string,
  tz: string,
  now = new Date(),
  opts: { excludeContactId?: string | null } = {},
): Promise<{
  agendas: { id: string; name: string }[]
  ocupados: Map<string, string[]>
}> {
  const vazio = { agendas: [] as { id: string; name: string }[], ocupados: new Map<string, string[]>() }
  try {
    const until = new Date(now.getTime() + BUSY_SLOTS_DAYS * 86_400_000)
    const agendas = await db
      .select({ id: calendars.id, name: calendars.name })
      .from(calendars)
      .where(and(eq(calendars.accountId, accountId), eq(calendars.isVisible, true)))
      .orderBy(asc(calendars.createdAt))
    if (agendas.length === 0) return vazio

    const rows = await db
      .select({
        calendarId: calendarEvents.calendarId,
        startsAt: calendarEvents.startsAt,
        endsAt: calendarEvents.endsAt,
        allDay: calendarEvents.allDay,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.status, 'confirmed'),
          opts.excludeContactId
            ? or(isNull(calendarEvents.contactId), ne(calendarEvents.contactId, opts.excludeContactId))
            : undefined,
          eq(calendarEvents.busy, true),
          gte(calendarEvents.endsAt, now.toISOString()),
          lt(calendarEvents.startsAt, until.toISOString()),
        ),
      )
      .orderBy(asc(calendarEvents.startsAt))
      // Teto maior que o da lista única: são várias agendas dividindo o mesmo
      // bolo, e cortar cedo demais faria a IA achar que um dentista está livre
      // num horário que já tem paciente.
      // 01/10: era MAX_SLOTS * 6 (240). Clínica com 12 agendas tinha 128 em 14
      // dias, mas o corte é por DATA e em silêncio: passou do teto, os últimos
      // dias chegam vazios para todos os profissionais e a IA lê "livre".
      .limit(TETO_AGENDAS_DA_EQUIPE)

    if (rows.length >= TETO_AGENDAS_DA_EQUIPE) {
      console.warn(
        `[ai busy-slots] ${accountId}: ${rows.length} compromissos em ${BUSY_SLOTS_DAYS} dias — a lista foi cortada no teto`,
      )
    }

    const ocupados = new Map<string, string[]>()
    for (const r of rows) {
      const lista = ocupados.get(r.calendarId) ?? []
      lista.push(formatBusySlot(r, tz))
      ocupados.set(r.calendarId, lista)
    }
    return { agendas, ocupados }
  } catch (err) {
    console.error('[ai busy-slots] agendas indisponíveis (segue sem):', err instanceof Error ? err.message : err)
    return vazio
  }
}

/** Quantas consultas futuras do próprio contato a IA enxerga. */
export const MAX_COMPROMISSOS_DO_CONTATO = 5

/** Uma consulta/reunião futura JÁ marcada com o contato da conversa. */
export interface CompromissoDoContato {
  /** Início e fim em ISO (UTC), como vêm do banco. */
  startsAt: string
  endsAt: string
  allDay: boolean
  /** Título curto, já desarmado (pode ter vindo do Google ou da página pública). */
  titulo: string
  /** Nome da agenda (o profissional, numa clínica), ou null. */
  agenda: string | null
  /** "qua 21/10 09:30–10:00" no fuso da conta. */
  quando: string
  /**
   * Hora de PAREDE do início ("2026-10-21T09:30", fuso da conta). É a
   * referência que a IA copia no `remarca` do [[AGENDAR]] — e a mesma conta
   * que o scheduleEventFromAi faz para achar a consulta.
   */
  inicioLocal: string
}

/** O fuso, se o Intl conhece; senão o de São Paulo (mesmo cuidado de formatBusySlot). */
function fusoValido(tz: string): string {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: tz })
    return tz
  } catch {
    return 'America/Sao_Paulo'
  }
}

/**
 * "YYYY-MM-DDTHH:MM" — a hora de PAREDE do instante no fuso `tz`. Inverso do
 * zonedWallToUtc (schedule-actions.ts). `hourCycle: 'h23'` porque `hour12:
 * false` devolve "24" à meia-noite em algumas versões do Node.
 */
export function horaDeParede(instante: string | Date, tz: string): string {
  const d = instante instanceof Date ? instante : new Date(instante)
  const p: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: fusoValido(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d)) {
    p[part.type] = part.value
  }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/**
 * As consultas/reuniões futuras JÁ marcadas com este contato — até 5, em ordem
 * cronológica, com a agenda (profissional) e o título de cada uma. Vai pro
 * prompt: a IA não remarca nem oferece outro horário à toa.
 *
 * 02/10/2026: antes devolvia só a PRIMEIRA, já formatada e sem dizer com quem.
 * Numa clínica em que a família toda usa o mesmo telefone, a IA não sabia que
 * havia uma segunda consulta, nem de quem era cada uma — e não tinha como
 * perguntar "quer remarcar a de quinta com o Dr. Fulano ou marcar outra?".
 * Nunca lança (erro → []).
 */
export async function loadBookedForContact(
  accountId: string,
  contactId: string,
  tz: string,
  now = new Date(),
): Promise<CompromissoDoContato[]> {
  try {
    const rows = await db
      .select({
        startsAt: calendarEvents.startsAt,
        endsAt: calendarEvents.endsAt,
        allDay: calendarEvents.allDay,
        title: calendarEvents.title,
        agenda: calendars.name,
      })
      .from(calendarEvents)
      .leftJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.contactId, contactId),
          eq(calendarEvents.status, 'confirmed'),
          gt(calendarEvents.startsAt, now.toISOString()),
        ),
      )
      .orderBy(asc(calendarEvents.startsAt))
      .limit(MAX_COMPROMISSOS_DO_CONTATO)
    return rows.map((r) => ({
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      allDay: !!r.allDay,
      // O título pode ter vindo de fora (Google, página pública de agendamento,
      // o nome que o próprio cliente digitou): desarmado e curto, numa linha.
      titulo: neutralizeUntrusted(r.title ?? '', { maxChars: 80 }).replace(/\s+/g, ' ').trim(),
      agenda: (r.agenda ?? '').replace(/\s+/g, ' ').trim() || null,
      quando: formatBusySlot(r, tz),
      inicioLocal: horaDeParede(r.startsAt, tz),
    }))
  } catch (err) {
    console.error('[ai busy-slots] consultas do contato indisponíveis (segue sem):', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * A lista que vai pro prompt, uma consulta por linha:
 *   - qua 21/10 09:30–10:00 · "Avaliação · Léo" · agenda: Dra. Marta Teixeira · ref: 2026-10-21T09:30
 * null quando não há nenhuma (o prompt fica como sempre foi).
 *
 * `comAgenda`: só quando a conta tem MAIS DE UMA agenda. Com uma só, o nome da
 * agenda ("Minha agenda", o e-mail do Google do dono) não diz nada e ainda
 * convida a IA a pôr esse nome no 3º campo do marcador.
 */
export function formatBookedForPrompt(
  itens: CompromissoDoContato[],
  opts: { comAgenda?: boolean } = {},
): string | null {
  if (itens.length === 0) return null
  return itens
    .map((c) => {
      const partes = [c.quando]
      if (c.titulo) partes.push(`"${c.titulo}"`)
      if (opts.comAgenda && c.agenda) partes.push(`agenda: ${c.agenda}`)
      partes.push(`ref: ${c.inicioLocal}`)
      return `- ${partes.join(' · ')}`
    })
    .join('\n')
}

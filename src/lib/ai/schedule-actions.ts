// ============================================================
// IA agenda de verdade — cria evento na Agenda quando a IA combina um horário.
// Server/worker-safe (recebe accountId/userId). Espelha no Google se a agenda
// for do Google (pushEventToGoogle, best-effort). Nunca lança.
// ============================================================

import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents, contacts, deals, scheduledMessages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pushEventToGoogle } from '@/lib/google/sync'
import { escolherAgenda } from './agenda-do-profissional'
import type { ModoAgendamento } from './defaults'
import type { ConfirmacaoConhecida, DesfechoDaConfirmacao } from '@/lib/agenda/confirmacao-agendamento'
import { enqueueScheduledMessage } from '@/lib/queue/queues'
import { getAccountSettings } from '@/lib/settings/account-settings'

/** DD/MM às HH:mm no fuso da conta. */
function fmtLocal(date: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  try {
    return new Intl.DateTimeFormat('pt-BR', { ...opts, timeZone: tz })
      .format(date)
      .replace(', ', ' às ')
  } catch {
    return new Intl.DateTimeFormat('pt-BR', opts).format(date)
  }
}

/**
 * Programa uma mensagem (lembrete) via scheduled_messages + enfileira o job.
 * Best-effort. Ignora se o horário já passou / está muito perto (<1min).
 * ⚠️ Fora da janela de 24h no canal OFICIAL da Meta, a entrega exige template
 * (não tratado aqui) — em canais WAHA e dentro da janela, entrega normal.
 */
async function scheduleReminderMessage(input: {
  accountId: string
  userId: string | null
  conversationId: string
  contactId: string | null
  whenUtc: Date
  text: string
}): Promise<void> {
  const delayMs = input.whenUtc.getTime() - Date.now()
  if (delayMs < 60_000) return
  try {
    const [row] = await db
      .insert(scheduledMessages)
      .values({
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: input.contactId || null,
        messageType: 'text',
        contentText: input.text,
        scheduledAt: input.whenUtc.toISOString(),
        status: 'pending',
        createdBy: input.userId,
        assignedTo: input.userId,
        assignedBy: input.userId,
      })
      .returning({ id: scheduledMessages.id })
    try {
      await enqueueScheduledMessage(row.id, { delayMs })
    } catch (err) {
      console.error('[ai schedule] enfileirar lembrete falhou:', err)
      await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id))
    }
  } catch (err) {
    console.error('[ai schedule] agendar lembrete falhou:', err)
  }
}

/** Offset (min) do fuso `tz` no instante `date`. Positivo = tz à frente do UTC. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  const asUTC = Date.UTC(
    +m.year,
    +m.month - 1,
    +m.day,
    +m.hour,
    +m.minute,
    +m.second,
  )
  return (asUTC - date.getTime()) / 60000
}

/** "YYYY-MM-DDTHH:mm" (hora de PAREDE no fuso `tz`) → instante UTC (Date|null). */
export function zonedWallToUtc(local: string, tz: string): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  const h = +m[4]
  const mi = +m[5]
  const guessUTC = Date.UTC(y, mo - 1, d, h, mi)
  const off = tzOffsetMinutes(new Date(guessUTC), tz)
  const inst = new Date(guessUTC - off * 60000)
  return Number.isNaN(inst.getTime()) ? null : inst
}

/**
 * Agenda onde a IA marca. Ordem: a escolhida na conta (`aiCalendarId`) → a
 * PRINCIPAL de um Google conectado (o id da agenda principal no Google é o
 * próprio e-mail da conta) → a primeira da conta (cria "Minha agenda").
 *
 * Zelo 18/09: pegava sempre a MAIS ANTIGA — a "Minha agenda" interna, criada
 * antes de o Google ser conectado. A reunião marcada pela IA nunca chegava no
 * Google do dono (o espelho só roda em agenda do Google).
 */
/**
 * A agenda do profissional que a IA nomeou no 3º campo do `[[AGENDAR]]`.
 *
 * Devolve null quando não há nome, quando não reconhece, ou quando ficou
 * AMBÍGUO (duas Simones na clínica) — e aí quem chama usa a agenda padrão, que
 * é onde a recepção já olha todo dia. Errar a agenda manda o paciente para a
 * cadeira do dentista errado e só se descobre na hora da consulta; cair na
 * padrão, no pior caso, dá um pouco de trabalho para a recepção mover.
 */
async function agendaDoProfissional(
  accountId: string,
  nomeDito: string | null | undefined,
): Promise<string | null> {
  if (!nomeDito) return null
  try {
    const disponiveis = await db
      .select({ id: calendars.id, name: calendars.name })
      .from(calendars)
      .where(and(eq(calendars.accountId, accountId), eq(calendars.isVisible, true)))
    const achada = escolherAgenda(nomeDito, disponiveis)
    if (achada === 'ambiguo') {
      console.warn(`[ai schedule] "${nomeDito}" casou com mais de uma agenda — usando a padrão`)
      return null
    }
    if (!achada) {
      console.warn(`[ai schedule] agenda "${nomeDito}" não encontrada — usando a padrão`)
      return null
    }
    return achada.id
  } catch (err) {
    console.error('[ai schedule] falha ao escolher a agenda do profissional:', err)
    return null
  }
}

async function ensureAiCalendar(
  accountId: string,
  userId: string | null,
): Promise<string> {
  try {
    const chosen = (await getAccountSettings(accountId)).aiCalendarId
    if (chosen) {
      const ok = firstOrNull(
        await db
          .select({ id: calendars.id })
          .from(calendars)
          .where(and(eq(calendars.id, chosen), eq(calendars.accountId, accountId)))
          .limit(1),
      )
      if (ok) return ok.id
    }
    const primary = firstOrNull(
      await db
        .select({ id: calendars.id })
        .from(calendars)
        .innerJoin(calendarConnections, eq(calendarConnections.id, calendars.connectionId))
        .where(
          and(
            eq(calendars.accountId, accountId),
            eq(calendars.googleCalendarId, calendarConnections.googleEmail),
          ),
        )
        .orderBy(asc(calendars.createdAt))
        .limit(1),
    )
    if (primary) return primary.id
  } catch (err) {
    console.error('[ai schedule] escolha da agenda (segue na primeira):', err)
  }
  const existing = firstOrNull(
    await db
      .select({ id: calendars.id })
      .from(calendars)
      .where(eq(calendars.accountId, accountId))
      .orderBy(asc(calendars.createdAt))
      .limit(1),
  )
  if (existing) return existing.id
  const [created] = await db
    .insert(calendars)
    .values({
      accountId,
      ownerUserId: userId,
      createdBy: userId,
      name: 'Minha agenda',
      color: '#6366f1',
    })
    .returning({ id: calendars.id })
  return created.id
}

export interface ScheduleResult {
  eventId: string
  startsAt: string
  title: string
  /** Link do Google Meet quando a reunião saiu online (aiMeetingOnline). */
  meetLink?: string | null
  /** A reunião JÁ existia e mudou de horário (remarcação). */
  rescheduled?: boolean
  /** O convite do Google foi pro e-mail do lead. */
  invitedLead?: boolean
  /**
   * O que aconteceu de fato (02/10/2026) — a nota interna conta isto, e não
   * mais "agendou" para tudo:
   *   - criou   → compromisso novo;
   *   - moveu   → um que existia trocou de horário (`movidoDe` = o antigo);
   *   - manteve → já existia um deste contato nesse mesmo início (o marcador
   *               repetido em turnos seguidos): nada foi criado nem movido.
   */
  acao: 'criou' | 'moveu' | 'manteve'
  /** Moveu: início ANTIGO (ISO) da consulta que mudou de horário. */
  movidoDe?: string
  /** Criou com o contato tendo OUTRAS consultas futuras: os inícios (ISO) delas. */
  mantidas?: string[]
  /**
   * Moveu, mas o profissional que a IA nomeou é de OUTRA agenda: a consulta
   * ficou na agenda original (mover entre agendas do Google não é feito aqui)
   * e a nota pede para a recepção conferir.
   */
  agendaDiferente?: boolean
}

/**
 * "remarca X" e não há consulta deste contato em X (ou há mais de uma e não dá
 * para saber qual): NADA foi mexido. Quem chama registra uma nota interna — a
 * IA pode já ter dito ao cliente que remarcou.
 */
export interface ScheduleNotFound {
  naoAchou: true
  motivo: 'sem-compromisso' | 'ambiguo' | 'sem-data'
  /** A consulta que a IA disse remarcar (hora de parede), ou null se não disse. */
  deLocal: string | null
  /** O horário novo pedido (hora de parede). */
  startsLocal: string
}

/** Consulta futura confirmada do contato, como scheduleEventFromAi a lê. */
export interface CompromissoExistente {
  id: string
  startsAt: string
  endsAt: string
  allDay?: boolean | null
  calendarId: string
  /** O paciente da linha (vai para a base da confirmação ao mover — 02/10). */
  contactId?: string | null
  title?: string | null
  location?: string | null
}

export type DecisaoAgendamento =
  | { acao: 'criar' }
  | { acao: 'mover'; alvo: CompromissoExistente }
  | { acao: 'manter'; alvo: CompromissoExistente }
  | { acao: 'nao-achou'; motivo: ScheduleNotFound['motivo'] }

/** Mesmo minuto? (início de evento do Google pode vir com segundos.) */
function mesmoMinuto(a: string | Date, b: string | Date): boolean {
  const ta = (a instanceof Date ? a : new Date(a)).getTime()
  const tb = (b instanceof Date ? b : new Date(b)).getTime()
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < 60_000
}

/**
 * O que o [[AGENDAR]] faz com as consultas que o contato JÁ tem. Pura.
 *
 * 02/10/2026 — antes só havia um caminho: com consulta futura, mover a mais
 * próxima. Numa clínica em que a família usa o mesmo telefone, a mãe que
 * marcava para o segundo filho movia a consulta do primeiro.
 *
 * - sem modo (o de sempre): move a mais próxima. Se já existe uma NESTE mesmo
 *   início, é o marcador repetido: mexe nela (só título), nunca puxa a mais
 *   próxima para cima dela — isso apagaria uma consulta e deixaria duas iguais.
 * - `nova`: cria. Só não cria se já houver uma deste contato no mesmo início
 *   (na mesma agenda, quando o profissional foi reconhecido) — a IA repete o
 *   marcador em turnos seguidos, e cada repetição viraria outra consulta.
 * - `remarca X`: move EXATAMENTE a de X. Não achou X mas já existe uma no
 *   horário NOVO = remarcação que já foi feita, marcador repetido: mantém.
 *   Senão, não mexe em nada. Duas em X (dois filhos no mesmo horário com
 *   profissionais diferentes): desempata pela agenda do profissional; se não
 *   der, não mexe — mover a errada tira o lugar de quem não pediu nada.
 *
 * `existentes` = futuros confirmados do contato em ordem cronológica.
 * `agendaPedida` = agenda do profissional que a IA nomeou, se reconhecida.
 */
export function decidirAgendamento(input: {
  modo: ModoAgendamento | null | undefined
  existentes: CompromissoExistente[]
  inicio: Date
  /** remarca: o início (UTC) da consulta a mover; null se não veio/é inválido. */
  deUtc: Date | null
  agendaPedida: string | null
}): DecisaoAgendamento {
  const { modo, existentes, inicio, deUtc, agendaPedida } = input
  const naAgendaPedida = (e: CompromissoExistente) => !agendaPedida || e.calendarId === agendaPedida
  const jaNoInicioNovo = existentes.find((e) => mesmoMinuto(e.startsAt, inicio) && naAgendaPedida(e))

  if (!modo) {
    if (existentes.length === 0) return { acao: 'criar' }
    return { acao: 'mover', alvo: jaNoInicioNovo ?? existentes.find((e) => mesmoMinuto(e.startsAt, inicio)) ?? existentes[0] }
  }

  if (modo.tipo === 'nova') {
    return jaNoInicioNovo ? { acao: 'manter', alvo: jaNoInicioNovo } : { acao: 'criar' }
  }

  // remarca
  if (!deUtc) return { acao: 'nao-achou', motivo: 'sem-data' }
  let emX = existentes.filter((e) => mesmoMinuto(e.startsAt, deUtc))
  if (emX.length > 1 && agendaPedida) {
    const daAgenda = emX.filter((e) => e.calendarId === agendaPedida)
    if (daAgenda.length === 1) emX = daAgenda
  }
  if (emX.length === 1) return { acao: 'mover', alvo: emX[0] }
  if (emX.length > 1) return { acao: 'nao-achou', motivo: 'ambiguo' }
  if (jaNoInicioNovo) return { acao: 'manter', alvo: jaNoInicioNovo }
  return { acao: 'nao-achou', motivo: 'sem-compromisso' }
}

/** Quantas consultas futuras do contato entram na decisão. */
const LIMITE_EXISTENTES = 20

/**
 * As colunas da fila da confirmação ao agendar (migração 0204) quando a IA
 * MOVE uma consulta para outro horário (02/10, revisão). A IA já confirma o
 * horário novo na conversa; a confirmação da Agenda que estivesse na fila
 * sairia depois e o paciente receberia duas. Tira da fila, grava o horário
 * novo como o que o paciente já sabe e deixa o porquê no desfecho. Pura.
 */
export function confirmacaoDadaPelaIa(
  consulta: Pick<CompromissoExistente, 'calendarId' | 'contactId'>,
  inicio: Date,
  agora: Date = new Date(),
): {
  confirmationDueAt: null
  confirmationConversationId: null
  confirmationKnown: ConfirmacaoConhecida
  confirmationResult: DesfechoDaConfirmacao
} {
  return {
    confirmationDueAt: null,
    confirmationConversationId: null,
    confirmationKnown: {
      startsAt: inicio.toISOString(),
      calendarId: consulta.calendarId,
      contactId: consulta.contactId ?? null,
    },
    confirmationResult: {
      status: 'descartada',
      motivo: 'a IA remarcou e confirmou na conversa',
      at: agora.toISOString(),
    },
  }
}

/** "segunda-feira, 21/09, às 9h" (ou "às 9h30") no fuso da conta. */
export function formatMeetingWhen(iso: string, tz: string): string {
  const d = new Date(iso)
  const part = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('pt-BR', { ...o, timeZone: tz }).format(d)
    } catch {
      return new Intl.DateTimeFormat('pt-BR', { ...o, timeZone: 'America/Sao_Paulo' }).format(d)
    }
  }
  const weekday = part({ weekday: 'long' })
  const day = part({ day: '2-digit', month: '2-digit' })
  const [h, m] = part({ hour: '2-digit', minute: '2-digit', hour12: false }).split(':')
  const hour = `${Number(h)}h${m && m !== '00' ? m : ''}`
  return `${weekday}, ${day}, às ${hour}`
}

/** "qua 21/10, 09:30" no fuso da conta — o formato de sempre das notas "📅 IA …". */
export function quandoDaNota(iso: string, tz: string): string {
  const fmt = (zone: string) =>
    new Date(iso)
      .toLocaleString('pt-BR', { timeZone: zone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      .replace('.,', '')
  try {
    return fmt(tz)
  } catch {
    return fmt('America/Sao_Paulo')
  }
}

/** Hora de parede ("2026-10-21T09:30") → "qua 21/10, 09:30"; ilegível volta como veio. */
function quandoLocalDaNota(local: string, tz: string): string {
  try {
    const d = zonedWallToUtc(local, tz)
    return d ? quandoDaNota(d.toISOString(), tz) : local
  } catch {
    return local
  }
}

const NAO_MARCAR_SOZINHA =
  'e, pra ela não marcar sozinha, desligue a ferramenta "Agendar" no agente (Agentes IA).'

/**
 * A nota interna do [[AGENDAR]] que deu certo — diz o que aconteceu de fato.
 *
 * 02/10/2026: antes era sempre "📅 IA agendou …", inclusive quando a IA tinha
 * MOVIDO uma consulta que já existia. Com a consulta adicional (`nova`) e a
 * remarcação de uma específica, a recepção precisa ler na conversa se a IA
 * criou outra, mexeu numa que existia, ou não fez nada. O prefixo "📅 IA"
 * continua (ninguém lê o resto do texto; conferido no código).
 */
export function notaDoAgendamentoDaIa(
  ev: ScheduleResult,
  tz: string,
  opts: { profissional?: string | null } = {},
): string {
  const quando = quandoDaNota(ev.startsAt, tz)
  if (ev.acao === 'manteve') {
    return `📅 IA repetiu a marcação de "${ev.title}" para ${quando} — esse horário já estava marcado para este contato; nada foi criado nem movido.`
  }
  if (ev.acao === 'moveu') {
    const de = ev.movidoDe ? quandoDaNota(ev.movidoDe, tz) : 'antes'
    const agenda =
      ev.agendaDiferente && opts.profissional
        ? ` ⚠️ A consulta continuou na agenda em que estava, mas a IA falou em "${opts.profissional}" — confira o profissional.`
        : ''
    return `📅 IA remarcou a consulta de ${de} para ${quando} ("${ev.title}"). Se não era pra mexer, ajuste na Agenda — ${NAO_MARCAR_SOZINHA}${agenda}`
  }
  if (ev.mantidas && ev.mantidas.length > 0) {
    const outras = ev.mantidas.slice(0, 3).map((iso) => quandoDaNota(iso, tz))
    const mais = ev.mantidas.length > 3 ? ` e mais ${ev.mantidas.length - 3}` : ''
    const mantendo =
      outras.length === 1 && !mais
        ? `mantendo a de ${outras[0]}`
        : `mantendo as de ${outras.join('; ')}${mais}`
    return `📅 IA marcou consulta NOVA "${ev.title}" para ${quando} (${mantendo}). Se não era pra marcar, cancele na Agenda — ${NAO_MARCAR_SOZINHA}`
  }
  return `📅 IA agendou "${ev.title}" para ${quando}. Se não era pra marcar, cancele na Agenda — ${NAO_MARCAR_SOZINHA}`
}

/**
 * A nota interna do "remarca X" que não achou o que remarcar. Nada foi mexido,
 * mas a resposta da IA ao cliente (que sai ANTES do marcador rodar) pode ter
 * dito que remarcou — a recepção precisa ver isto na conversa.
 */
export function notaDaRemarcacaoSemAlvo(nf: ScheduleNotFound, tz: string): string {
  const para = quandoLocalDaNota(nf.startsLocal, tz)
  const confira = 'Nada foi mexido na Agenda. Confira com o cliente: a resposta da IA pode ter dito que remarcou.'
  if (nf.motivo === 'sem-data' || !nf.deLocal) {
    return `📅 A IA pediu para remarcar uma consulta para ${para}, mas não disse qual. ${confira}`
  }
  const de = quandoLocalDaNota(nf.deLocal, tz)
  if (nf.motivo === 'ambiguo') {
    return `📅 A IA tentou remarcar a consulta de ${de} para ${para}, mas este contato tem mais de uma consulta nesse horário e não deu para saber qual. ${confira}`
  }
  return `📅 A IA tentou remarcar a consulta de ${de} para ${para}, mas não achou essa consulta deste contato. ${confira}`
}

/**
 * Cria o evento na Agenda a partir do que a IA decidiu. `startsLocal` é a hora
 * de PAREDE no fuso da conta (ex.: "2026-08-16T15:00"). Best-effort.
 *
 * Devolve `ScheduleNotFound` (e não mexe em nada) quando o marcador pediu para
 * remarcar uma consulta que não existe — ver decidirAgendamento.
 */
export async function scheduleEventFromAi(input: {
  accountId: string
  userId: string | null
  conversationId: string
  contactId: string | null
  startsLocal: string
  title: string
  timezone: string
  durationMin?: number
  /**
   * De quem é a agenda, como a IA escreveu ("Dra. Bruna"). Clínica com vários
   * profissionais marca cada paciente na agenda certa. Vazio = agenda padrão.
   */
  profissional?: string | null
  /**
   * 4º campo do marcador (02/10/2026): `nova` cria uma consulta ADICIONAL,
   * `remarca X` move exatamente a de X. Ausente = o de sempre (move a mais
   * próxima). Ver decidirAgendamento.
   */
  modo?: ModoAgendamento | null
}): Promise<ScheduleResult | ScheduleNotFound | null> {
  const { accountId, userId, conversationId, contactId, startsLocal, timezone } =
    input
  const modo = input.modo ?? null
  try {
    const start = zonedWallToUtc(startsLocal, timezone)
    if (!start) return null
    // Duração pedida (o pedido aprovado em Precisa de você manda 60). Sem ela:
    // compromisso NOVO nasce com 60 min; o que é MOVIDO mantém a duração que
    // tinha (02/10: a consulta de 30 min da recepção virava 60 ao ser
    // remarcada pela IA e tomava o horário seguinte do profissional).
    const durPedidaMin = input.durationMin && input.durationMin > 0 ? input.durationMin : null
    // A agenda do profissional que a IA nomeou; se não reconhecer ou ficar
    // ambíguo, cai na padrão — marcar na agenda errada põe o paciente na cadeira
    // do dentista errado, e ninguém percebe até o dia da consulta.
    const agendaPedida = await agendaDoProfissional(accountId, input.profissional)
    const title = (input.title || 'Reunião').trim().slice(0, 200)

    // Vincula ao negócio ABERTO mais novo da conversa (depois de um [[GANHO]]
    // com cópia, o aberto é a cópia no funil comercial — é ela que vai pra
    // reunião).
    const deal = firstOrNull(
      await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.conversationId, conversationId),
          ),
        )
        .orderBy(sql`(${deals.status} = 'open') DESC`, desc(deals.createdAt))
        .limit(1),
    )

    // Dedup: a IA às vezes emite [[AGENDAR]] em turnos seguidos. Os eventos
    // confirmados FUTUROS do mesmo CONTATO (senão, do mesmo negócio) decidem se
    // este marcador cria, move ou não faz nada — 1 reunião = 1 evento. Pelo
    // contato primeiro: o negócio muda quando o ganho abre a cópia (Zelo 18/09).
    // 02/10/2026: lê TODOS (não só o mais próximo) e quem decide é o 4º campo
    // do marcador — ver decidirAgendamento.
    const dupMatch = contactId
      ? eq(calendarEvents.contactId, contactId)
      : deal?.id
        ? eq(calendarEvents.dealId, deal.id)
        : null
    const existentes: CompromissoExistente[] = dupMatch
      ? await db
          .select({
            id: calendarEvents.id,
            startsAt: calendarEvents.startsAt,
            endsAt: calendarEvents.endsAt,
            allDay: calendarEvents.allDay,
            calendarId: calendarEvents.calendarId,
            contactId: calendarEvents.contactId,
            title: calendarEvents.title,
            location: calendarEvents.location,
          })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.accountId, accountId),
              eq(calendarEvents.status, 'confirmed'),
              gt(calendarEvents.startsAt, sql`now()`),
              dupMatch,
            ),
          )
          .orderBy(asc(calendarEvents.startsAt))
          .limit(LIMITE_EXISTENTES)
      : []
    const deUtc =
      modo?.tipo === 'remarca' && modo.deLocal ? zonedWallToUtc(modo.deLocal, timezone) : null
    const decisao = decidirAgendamento({ modo, existentes, inicio: start, deUtc, agendaPedida })
    const linkDoMeet = (location: string | null | undefined) =>
      location && /meet\.google\.com/.test(location) ? location : null

    if (decisao.acao === 'nao-achou') {
      console.warn(
        `[ai schedule] remarca sem alvo (${decisao.motivo}): de ${modo?.tipo === 'remarca' ? modo.deLocal : '?'} para ${startsLocal} — nada foi mexido`,
      )
      return {
        naoAchou: true,
        motivo: decisao.motivo,
        deLocal: modo?.tipo === 'remarca' ? modo.deLocal : null,
        startsLocal,
      }
    }

    if (decisao.acao === 'manter') {
      // Já existe uma deste contato neste início: marcador repetido. Não cria,
      // não move, não mexe no título — e quem chama não avisa o cliente de novo.
      const alvo = decisao.alvo
      return {
        eventId: alvo.id,
        startsAt: new Date(alvo.startsAt).toISOString(),
        title: (alvo.title || title).trim(),
        rescheduled: false,
        acao: 'manteve',
        meetLink: linkDoMeet(alvo.location),
      }
    }

    if (decisao.acao === 'mover') {
      const existing = decisao.alvo
      const sameTime = mesmoMinuto(existing.startsAt, start)
      const durOriginalMs = new Date(existing.endsAt).getTime() - new Date(existing.startsAt).getTime()
      const durMs = durPedidaMin
        ? durPedidaMin * 60000
        : !existing.allDay && Number.isFinite(durOriginalMs) && durOriginalMs > 0
          ? durOriginalMs
          : 60 * 60000
      const end = new Date(start.getTime() + durMs)
      await db
        .update(calendarEvents)
        .set({
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          title,
          ...(deal?.id ? { dealId: deal.id } : {}),
          // Horário mudou = compromisso novo para quem vai ser avisado. Sem
          // zerar, `reminders_sent` (que só anda para frente) faz a data nova
          // nascer com os degraus queimados, e o lembrete da remarcação —
          // justamente o mais necessário — nunca sai.
          ...(sameTime ? {} : { remindersSent: 0, reminderBlock: null, reminderBlockAt: null }),
          // ⏳ A confirmação da Agenda que estava na fila (02/10, revisão): a
          // IA remarca E confirma o horário novo na própria conversa. Sem
          // isto, a fila mandava DEPOIS a dela ("remarcada para…") — duas
          // mensagens. Sai da fila, e o horário novo vira o que o paciente já
          // sabe (a próxima edição na Agenda compara com ele). O desfecho
          // diz por que não saiu (a tela não mostra 'descartada' como aviso).
          ...(sameTime ? {} : confirmacaoDadaPelaIa(existing, start)),
          // O import do Google só sobrescreve a linha que ninguém mexeu desde
          // a listagem dele (02/10, revisão) — e "mexeu" é o updated_at. Sem
          // isto, a remarcação da IA podia ser desfeita pela foto velha.
          updatedAt: sql`now()`,
        })
        .where(eq(calendarEvents.id, existing.id))
      if (!sameTime) {
        try {
          await pushEventToGoogle(accountId, existing.id, 'update')
        } catch (err) {
          console.error('[ai schedule] google update falhou:', err)
        }
      }
      return {
        eventId: existing.id,
        startsAt: start.toISOString(),
        title,
        // Remarcou (horário mudou): quem chama avisa o lead com o link de
        // sempre. Mesmo horário = marcador repetido, nada a avisar.
        rescheduled: !sameTime,
        acao: sameTime ? 'manteve' : 'moveu',
        ...(sameTime ? {} : { movidoDe: new Date(existing.startsAt).toISOString() }),
        // A consulta continua na agenda em que estava (como sempre foi). Se a
        // IA nomeou um profissional de OUTRA agenda, a nota avisa a recepção.
        ...(agendaPedida && agendaPedida !== existing.calendarId ? { agendaDiferente: true } : {}),
        meetLink: linkDoMeet(existing.location),
      }
    }

    // Criar. A agenda padrão só é resolvida aqui — ela pode CRIAR a "Minha
    // agenda" em conta sem nenhuma, e isso não pode acontecer num marcador que
    // só moveu ou repetiu.
    const calendarId = agendaPedida ?? (await ensureAiCalendar(accountId, userId))
    const end = new Date(start.getTime() + (durPedidaMin ?? 60) * 60000)
    const [created] = await db
      .insert(calendarEvents)
      .values({
        accountId,
        calendarId,
        ownerUserId: userId,
        createdBy: userId,
        title,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        contactId: contactId || null,
        dealId: deal?.id ?? null,
        source: 'local',
      })
      .returning({ id: calendarEvents.id })

    // Espelha no Google (best-effort, só se a agenda for do Google). Conta com
    // reunião ONLINE (aiMeetingOnline): sala do Meet + convite por e-mail pro
    // lead e pros convidados fixos — Renato/Zelo 18/09.
    let meetLink: string | null = null
    let invitedLead = false
    try {
      const settings = await getAccountSettings(accountId)
      let attendees: string[] = []
      if (settings.aiMeetingOnline) {
        const leadEmail = contactId
          ? firstOrNull(
              await db
                .select({ email: contacts.email })
                .from(contacts)
                .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
                .limit(1),
            )?.email ?? null
          : null
        attendees = [leadEmail, ...(settings.aiMeetingInvitees ?? [])].filter(
          (e): e is string => typeof e === 'string' && e.includes('@'),
        )
      }
      const pushed = await pushEventToGoogle(accountId, created.id, 'create', {
        meet: settings.aiMeetingOnline,
        attendees,
      })
      meetLink = (pushed && pushed.hangoutLink) || null
      invitedLead = settings.aiMeetingOnline && attendees.length > (settings.aiMeetingInvitees ?? []).length
    } catch (err) {
      console.error('[ai schedule] google push falhou:', err)
    }

    // Lembretes de reunião: agora são feitos pelo sweep configurável
    // (runMeetingReminderSweep, ancorado no horário do evento + canal-aware +
    // 1x via reminders_sent). O antigo pré/pós hardcoded foi removido — ele
    // duplicava (1 por evento, sem dedup) e causava spam quando havia eventos
    // repetidos.

    // `nova` com o contato tendo outras consultas: a nota diz quais ficaram.
    const mantidas = existentes.map((e) => new Date(e.startsAt).toISOString())
    return {
      eventId: created.id,
      startsAt: start.toISOString(),
      title,
      meetLink,
      invitedLead,
      acao: 'criou',
      ...(mantidas.length ? { mantidas } : {}),
    }
  } catch (err) {
    console.error('[ai schedule] criar evento falhou:', err)
    return null
  }
}

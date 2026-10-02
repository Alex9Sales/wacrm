// ============================================================
// IA agenda de verdade — cria evento na Agenda quando a IA combina um horário.
// Server/worker-safe (recebe accountId/userId). Espelha no Google se a agenda
// for do Google (pushEventToGoogle, best-effort). Nunca lança.
// ============================================================

import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents, contacts, deals, scheduledMessages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pushEventToGoogle } from '@/lib/google/sync'
import { recomecoDoLembrete } from './meeting-reminder-block'
import { escolherAgenda } from './agenda-do-profissional'
import { tituloNormalizado } from './busy-slots'
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

/**
 * A agenda padrão da IA SEM criar nada (02/10, revisão): é onde uma consulta
 * nova sem profissional nasceria, e é contra ela que "o mesmo horário já está
 * ocupado neste profissional?" é conferido. null = a conta não tem agenda.
 */
async function agendaPadraoDaIa(accountId: string): Promise<string | null> {
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
  return existing?.id ?? null
}

async function ensureAiCalendar(
  accountId: string,
  userId: string | null,
): Promise<string> {
  const existing = await agendaPadraoDaIa(accountId)
  if (existing) return existing
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
  /** Moveu: fim ANTIGO (ISO) — o "Desfazer" da aprovação devolve a consulta para lá (02/10, revisão). */
  movidoDeFim?: string
  /**
   * Moveu: o título da consulta movida, que FICA (02/10, revisão). É onde
   * está o nome de qual filho: antes a IA o trocava pelo título dela, e a
   * consulta do Davi movida virava "Avaliação Bianca". `title` também é ele.
   */
  tituloAntigo?: string
  /** Moveu: o título que a IA escreveu, quando diz outra coisa (a nota mostra os dois). */
  tituloDaIa?: string
  /**
   * Moveu, e no horário ANTIGO ficou outra consulta confirmada do mesmo
   * contato (02/10, revisão): a mesma lançada em duas agendas, ou a de outra
   * pessoa da família. Não é movida sozinha — a nota pede para a recepção ver.
   */
  ficouNoHorarioAntigo?: { startsAt: string; agenda: string | null; titulo: string }[]
  /** Criou com o contato tendo OUTRAS consultas futuras: os inícios (ISO) delas. */
  mantidas?: string[]
}

/**
 * O [[AGENDAR]] não fez NADA (02/10/2026; motivos novos na revisão de 02/10).
 * Quem chama registra uma nota interna e avisa o dono — a resposta da IA ao
 * cliente (que sai ANTES do marcador rodar) pode ter dito que marcou/remarcou.
 *   - sem-compromisso → "remarca X" e não há consulta deste contato em X;
 *   - ambiguo         → há mais de uma em X e não dá para saber qual;
 *   - sem-data        → "remarca" sem dizer qual;
 *   - sem-modo        → sem dizer se é nova ou remarcação, e o contato tem
 *                       consultas que não deixam adivinhar (mais de uma, ou a
 *                       única é de outro profissional/no mesmo horário);
 *   - ocupado         → "nova" no mesmo horário e na mesma agenda de outra
 *                       consulta deste contato (o profissional já está ocupado);
 *   - outra-agenda    → "remarca X" com profissional de OUTRA agenda: troca de
 *                       profissional fica com a recepção.
 */
export interface ScheduleNotFound {
  naoAchou: true
  motivo: 'sem-compromisso' | 'ambiguo' | 'sem-data' | 'sem-modo' | 'ocupado' | 'outra-agenda'
  /** A consulta que a IA disse remarcar (hora de parede), ou null se não disse. */
  deLocal: string | null
  /** O horário novo pedido (hora de parede). */
  startsLocal: string
  /** O título que a IA escreveu no marcador. */
  titulo?: string
  /** sem-modo: quantas consultas futuras o contato tem. */
  consultas?: number
  /** ocupado / outra-agenda: a consulta existente envolvida. */
  conflito?: { titulo: string; agenda: string | null; startsAt: string }
  /** outra-agenda: o profissional que a IA nomeou. */
  profissional?: string | null
}

/** Consulta futura confirmada do contato, como scheduleEventFromAi a lê. */
export interface CompromissoExistente {
  id: string
  startsAt: string
  endsAt: string
  allDay?: boolean | null
  calendarId: string
  /** Nome da agenda (o profissional) — para as notas (02/10, revisão). */
  calendarName?: string | null
  /** O paciente da linha (vai para a base da confirmação ao mover — 02/10). */
  contactId?: string | null
  title?: string | null
  location?: string | null
  /** Confirmação da Agenda na fila (02/10, revisão): só descartar quando havia uma. */
  confirmationDueAt?: string | null
  /**
   * O lembrete deste início e o guardado de um início anterior (migração
   * 0206): ao mover, decidem entre zerar e restaurar (recomecoDoLembrete).
   */
  remindersSent?: number | null
  remindersPrevStartsAt?: string | null
  remindersPrevSent?: number | null
}

export type DecisaoAgendamento =
  | { acao: 'criar' }
  | { acao: 'mover'; alvo: CompromissoExistente }
  | { acao: 'manter'; alvo: CompromissoExistente }
  | { acao: 'nao-achou'; motivo: ScheduleNotFound['motivo']; alvo?: CompromissoExistente }

/** Mesmo minuto? (início de evento do Google pode vir com segundos.) */
function mesmoMinuto(a: string | Date, b: string | Date): boolean {
  const ta = (a instanceof Date ? a : new Date(a)).getTime()
  const tb = (b instanceof Date ? b : new Date(b)).getTime()
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < 60_000
}

/**
 * O início novo cai DENTRO da consulta `e` (com hora)? Mesmo minuto também
 * conta. "Nova" às 9h15 com o mesmo profissional de uma consulta 9h–10h deste
 * contato é dupla marcação na mesma cadeira (02/10, revisão).
 */
function comecaDentro(e: CompromissoExistente, inicio: Date): boolean {
  if (mesmoMinuto(e.startsAt, inicio)) return true
  if (e.allDay) return false
  const s = new Date(e.startsAt).getTime()
  const f = new Date(e.endsAt).getTime()
  const t = inicio.getTime()
  return Number.isFinite(s) && Number.isFinite(f) && t > s && t < f
}

/**
 * O que o [[AGENDAR]] faz com as consultas que o contato JÁ tem. Pura.
 *
 * 02/10/2026 — antes só havia um caminho: com consulta futura, mover a mais
 * próxima. Numa clínica em que a família usa o mesmo telefone, a mãe que
 * marcava para o segundo filho movia a consulta do primeiro.
 *
 * Revisão de 02/10 (12 agendas, uma por profissional; famílias no mesmo
 * telefone). O PIOR erro é mexer na consulta de OUTRA pessoa da família, ou
 * marcar duas vezes o mesmo profissional no mesmo horário. Por isso, na dúvida,
 * NADA é mexido (nao-achou, com nota e aviso ao dono):
 *
 * - repetição = mesmo minuto, MESMA agenda (`agendaAlvo`) e mesmo título
 *   normalizado: o marcador repetido em turnos seguidos → mantém.
 * - sem modo: nenhuma consulta → cria; repetição → mantém; EXATAMENTE UMA
 *   consulta, em outro horário, e (sem profissional pedido ou na agenda dele)
 *   → move (o de sempre, para quem só tem uma reunião). Qualquer outro caso →
 *   'sem-modo'. Antes movia a mais próxima, que podia ser a do irmão.
 * - `nova`: repetição → mantém; a agenda-alvo já tem consulta deste contato
 *   nesse horário (título diferente) → 'ocupado' (nunca troca o título da que
 *   existe); em outra agenda → cria. Antes um "mesmo minuto" em QUALQUER
 *   agenda virava "mantém" quando o profissional não era reconhecido.
 * - `remarca X`: move EXATAMENTE a de X. Duas em X: desempata pela agenda do
 *   profissional; se não der → 'ambiguo'. A de X é de OUTRA agenda que a do
 *   profissional pedido → 'outra-agenda' (troca de profissional é com a
 *   recepção). Não achou X mas já existe uma no horário NOVO = remarcação já
 *   feita, marcador repetido → mantém. Senão → 'sem-compromisso'.
 *
 * `existentes` = futuros confirmados do contato em ordem cronológica.
 * `agendaPedida` = agenda do profissional que a IA nomeou, se reconhecida.
 * `agendaAlvo` = onde uma consulta nova nasceria (a pedida, ou a padrão).
 * `profissionalPedido` = a IA nomeou alguém (reconhecido ou não).
 */
export function decidirAgendamento(input: {
  modo: ModoAgendamento | null | undefined
  existentes: CompromissoExistente[]
  inicio: Date
  /** remarca: o início (UTC) da consulta a mover; null se não veio/é inválido. */
  deUtc: Date | null
  agendaPedida: string | null
  agendaAlvo: string | null
  profissionalPedido: boolean
  /** O título do marcador (para reconhecer a repetição). */
  titulo: string
}): DecisaoAgendamento {
  const { modo, existentes, inicio, deUtc, agendaPedida, agendaAlvo, profissionalPedido } = input
  const titulo = tituloNormalizado(input.titulo)
  const naAgendaAlvo = (e: CompromissoExistente) => agendaAlvo !== null && e.calendarId === agendaAlvo
  const repeticao = existentes.find(
    (e) => mesmoMinuto(e.startsAt, inicio) && naAgendaAlvo(e) && tituloNormalizado(e.title) === titulo,
  )

  if (!modo) {
    if (existentes.length === 0) return { acao: 'criar' }
    if (repeticao) return { acao: 'manter', alvo: repeticao }
    if (existentes.length === 1) {
      const unica = existentes[0]
      const compativel = !profissionalPedido || (agendaPedida !== null && unica.calendarId === agendaPedida)
      // No mesmo horário não é remarcação (não há para onde mover): é outra
      // consulta ou o marcador repetido com outro título — na dúvida, nada.
      if (compativel && !mesmoMinuto(unica.startsAt, inicio)) return { acao: 'mover', alvo: unica }
    }
    return { acao: 'nao-achou', motivo: 'sem-modo' }
  }

  if (modo.tipo === 'nova') {
    if (repeticao) return { acao: 'manter', alvo: repeticao }
    const ocupado = existentes.find((e) => naAgendaAlvo(e) && comecaDentro(e, inicio))
    if (ocupado) return { acao: 'nao-achou', motivo: 'ocupado', alvo: ocupado }
    return { acao: 'criar' }
  }

  // remarca
  if (!deUtc) return { acao: 'nao-achou', motivo: 'sem-data' }
  let emX = existentes.filter((e) => mesmoMinuto(e.startsAt, deUtc))
  if (emX.length > 1 && agendaPedida) {
    const daAgenda = emX.filter((e) => e.calendarId === agendaPedida)
    if (daAgenda.length === 1) emX = daAgenda
  }
  if (emX.length === 1) {
    const alvo = emX[0]
    if (agendaPedida && alvo.calendarId !== agendaPedida) return { acao: 'nao-achou', motivo: 'outra-agenda', alvo }
    // "remarca X para X": nada a mover.
    if (mesmoMinuto(alvo.startsAt, inicio)) return { acao: 'manter', alvo }
    return { acao: 'mover', alvo }
  }
  if (emX.length > 1) return { acao: 'nao-achou', motivo: 'ambiguo' }
  const jaNoInicioNovo = existentes.find(
    (e) => mesmoMinuto(e.startsAt, inicio) && (!agendaPedida || e.calendarId === agendaPedida),
  )
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
 *
 * O desfecho 'descartada' só quando HAVIA algo na fila (2ª revisão de 02/10):
 * sem pendente, ele apagava o último desfecho de verdade ("enviada em…", "não
 * enviada — …") que o modal mostra. Aí só o que o paciente sabe muda.
 */
export function confirmacaoDadaPelaIa(
  consulta: Pick<CompromissoExistente, 'calendarId' | 'contactId' | 'confirmationDueAt'>,
  inicio: Date,
  agora: Date = new Date(),
):
  | { confirmationKnown: ConfirmacaoConhecida }
  | {
      confirmationDueAt: null
      confirmationConversationId: null
      confirmationKnown: ConfirmacaoConhecida
      confirmationResult: DesfechoDaConfirmacao
    } {
  const confirmationKnown: ConfirmacaoConhecida = {
    startsAt: inicio.toISOString(),
    calendarId: consulta.calendarId,
    contactId: consulta.contactId ?? null,
  }
  if (!consulta.confirmationDueAt) return { confirmationKnown }
  return {
    confirmationDueAt: null,
    confirmationConversationId: null,
    confirmationKnown,
    confirmationResult: {
      status: 'descartada',
      motivo: 'a IA remarcou e confirmou na conversa',
      at: agora.toISOString(),
    },
  }
}

/**
 * Depois de mover a consulta `movida`: as OUTRAS consultas confirmadas do
 * mesmo contato que ficaram no horário antigo (02/10, revisão). Pura.
 */
export function ficouNoHorarioAntigo(
  existentes: CompromissoExistente[],
  movida: CompromissoExistente,
): NonNullable<ScheduleResult['ficouNoHorarioAntigo']> {
  return existentes
    .filter((e) => e.id !== movida.id && mesmoMinuto(e.startsAt, movida.startsAt))
    .map((e) => ({
      startsAt: new Date(e.startsAt).toISOString(),
      agenda: e.calendarName?.trim() || null,
      titulo: (e.title ?? '').trim(),
    }))
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
 *
 * Revisão de 02/10: na remarcação, a nota diz DE QUEM é a consulta movida (o
 * título dela, que agora fica) e, se a IA a chamou de outra coisa, os dois —
 * é ali que a recepção vê "a IA falou da Bianca e moveu a do Davi". E avisa se
 * ficou outra consulta do contato no horário antigo.
 */
export function notaDoAgendamentoDaIa(ev: ScheduleResult, tz: string): string {
  const quando = quandoDaNota(ev.startsAt, tz)
  if (ev.acao === 'manteve') {
    return `📅 IA repetiu a marcação de "${ev.title}" para ${quando} — esse horário já estava marcado para este contato; nada foi criado nem movido.`
  }
  if (ev.acao === 'moveu') {
    return `📅 IA ${resumoDaRemarcacao(ev, tz)}. Se não era pra mexer, ajuste na Agenda — ${NAO_MARCAR_SOZINHA}${avisoDoQueFicou(ev, tz)}`
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
 * "remarcou a consulta "Avaliação · Davi" de qua 21/10, 09:30 para sex 23/10,
 * 10:00 (o título foi mantido; a IA a chamou de "Avaliação · Bianca")" — o
 * miolo da nota, do aviso ao dono e da nota da aprovação (02/10, revisão).
 */
export function resumoDaRemarcacao(ev: ScheduleResult, tz: string): string {
  const quando = quandoDaNota(ev.startsAt, tz)
  const de = ev.movidoDe ? quandoDaNota(ev.movidoDe, tz) : 'antes'
  const titulo = (ev.tituloAntigo ?? ev.title).trim()
  const deQuem = titulo ? ` "${titulo}"` : ''
  const chamou = ev.tituloDaIa ? ` (o título foi mantido; a IA a chamou de "${ev.tituloDaIa}")` : ''
  return `remarcou a consulta${deQuem} de ${de} para ${quando}${chamou}`
}

/**
 * Ficou outra consulta do mesmo contato no horário ANTIGO (02/10, revisão):
 * pode ser a mesma lançada em duas agendas (aí falta mover a cópia) ou a de
 * outra pessoa da família (aí fica). Não dá para saber daqui, então nada é
 * movido sozinho — o aviso diz o que olhar. '' quando não ficou nenhuma.
 */
export function avisoDoQueFicou(ev: ScheduleResult, tz: string): string {
  const ficou = ev.ficouNoHorarioAntigo ?? []
  if (ficou.length === 0) return ''
  return ficou
    .map((f) => {
      const agenda = f.agenda ? ` na agenda ${f.agenda}` : ''
      return ` ⚠️ Ficou outra consulta deste contato em ${quandoDaNota(f.startsAt, tz)}${agenda}: se era a mesma lançada em duas agendas, mova ou cancele também; se é de outra pessoa da família, deixe.`
    })
    .join('')
}

/**
 * A nota interna do [[AGENDAR]] que não fez nada. Nada foi mexido, mas a
 * resposta da IA ao cliente (que sai ANTES do marcador rodar) pode ter dito
 * que marcou ou remarcou — a recepção precisa ver isto na conversa.
 */
export function notaDaRemarcacaoSemAlvo(nf: ScheduleNotFound, tz: string): string {
  return `📅 ${motivoSemAlvo(nf, tz)} Confira com o cliente: a resposta da IA pode ter dito que ${
    nf.motivo === 'sem-modo' ? 'marcou ou remarcou' : nf.motivo === 'ocupado' ? 'marcou' : 'remarcou'
  }.`
}

/** O título do aviso ao dono quando o [[AGENDAR]] não fez nada. */
export function tituloDoAvisoSemAlvo(nf: ScheduleNotFound): string {
  if (nf.motivo === 'sem-modo') return 'IA não marcou: faltou dizer se era consulta nova ou remarcação'
  if (nf.motivo === 'ocupado') return 'IA não marcou: o profissional já tem consulta deste contato no horário'
  if (nf.motivo === 'outra-agenda') return 'IA não remarcou: troca de profissional'
  return 'IA não conseguiu remarcar'
}

/**
 * O porquê, numa frase que termina dizendo que nada foi mexido — a nota da
 * conversa e o erro da aprovação em Precisa de você (02/10, revisão).
 */
export function motivoSemAlvo(nf: ScheduleNotFound, tz: string): string {
  const para = quandoLocalDaNota(nf.startsLocal, tz)
  const titulo = nf.titulo?.trim() ? ` "${nf.titulo.trim()}"` : ''
  if (nf.motivo === 'sem-modo') {
    const n = nf.consultas ?? 0
    const tem = n === 1 ? '1 consulta marcada' : `${n} consultas marcadas`
    return `A IA tentou marcar/remarcar${titulo} para ${para} sem dizer se era consulta nova ou remarcação; o contato tem ${tem} — nada foi alterado na Agenda.`
  }
  if (nf.motivo === 'ocupado') {
    const c = nf.conflito
    const agenda = c?.agenda ? `a agenda ${c.agenda}` : 'essa agenda'
    const existente = c?.titulo ? ` ("${c.titulo}")` : ''
    return `A IA tentou marcar consulta NOVA${titulo} para ${para}, mas ${agenda} já tem uma consulta deste contato nesse horário${existente} — nada foi criado nem alterado na Agenda.`
  }
  if (nf.motivo === 'sem-data' || !nf.deLocal) {
    return `A IA pediu para remarcar uma consulta para ${para}, mas não disse qual — nada foi mexido na Agenda.`
  }
  const de = quandoLocalDaNota(nf.deLocal, tz)
  if (nf.motivo === 'outra-agenda') {
    const c = nf.conflito
    const deX = c?.agenda ? ` (com ${c.agenda})` : ''
    const com = nf.profissional?.trim() ? ` com "${nf.profissional.trim()}"` : ' com outro profissional'
    return `A IA tentou remarcar a consulta de ${de}${deX} para ${para}${com}, mas troca de profissional fica com a recepção — nada foi mexido na Agenda.`
  }
  if (nf.motivo === 'ambiguo') {
    return `A IA tentou remarcar a consulta de ${de} para ${para}, mas este contato tem mais de uma consulta nesse horário e não deu para saber qual — nada foi mexido na Agenda.`
  }
  return `A IA tentou remarcar a consulta de ${de} para ${para}, mas não achou essa consulta deste contato — nada foi mexido na Agenda.`
}

/**
 * Cria o evento na Agenda a partir do que a IA decidiu. `startsLocal` é a hora
 * de PAREDE no fuso da conta (ex.: "2026-08-16T15:00"). Best-effort.
 *
 * Devolve `ScheduleNotFound` (e não mexe em nada) quando não dá para fazer com
 * segurança o que o marcador pediu — remarcar uma consulta que não existe, sem
 * dizer nova/remarcação com consultas que não deixam adivinhar, profissional
 * ocupado, troca de profissional. Ver decidirAgendamento.
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
   * `remarca X` move exatamente a de X. Ausente: cria se não há consulta e só
   * move quando há UMA, compatível (revisão de 02/10). Ver decidirAgendamento.
   */
  modo?: ModoAgendamento | null
}): Promise<ScheduleResult | ScheduleNotFound | null> {
  const { accountId, userId, conversationId, contactId, startsLocal, timezone } =
    input
  const modo = input.modo ?? null
  try {
    const start = zonedWallToUtc(startsLocal, timezone)
    if (!start) return null
    // Duração pedida (pedido antigo de Precisa de você ainda traz 60 — os
    // novos não trazem mais, revisão de 02/10). Sem ela: compromisso NOVO
    // nasce com 60 min; o que é MOVIDO mantém a duração que tinha (02/10: a
    // consulta de 30 min da recepção virava 60 ao ser remarcada pela IA e
    // tomava o horário seguinte do profissional).
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
            // O profissional, para as notas (02/10, revisão).
            calendarName: calendars.name,
            contactId: calendarEvents.contactId,
            title: calendarEvents.title,
            location: calendarEvents.location,
            // Só descarta a confirmação da Agenda se havia uma na fila (02/10, revisão).
            confirmationDueAt: calendarEvents.confirmationDueAt,
            // O recomeço do lembrete ao mover: zera, ou restaura se voltou (0206).
            remindersSent: calendarEvents.remindersSent,
            remindersPrevStartsAt: calendarEvents.remindersPrevStartsAt,
            remindersPrevSent: calendarEvents.remindersPrevSent,
          })
          .from(calendarEvents)
          .leftJoin(calendars, and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, accountId)))
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
    // Onde uma consulta NOVA nasceria (02/10, revisão): é com ela que "o mesmo
    // horário já está ocupado neste profissional?" e "é o marcador repetido?"
    // são conferidos — antes, sem profissional reconhecido, valia QUALQUER
    // agenda. Só lida (sem criar) e só quando há consulta para comparar.
    const agendaAlvo = agendaPedida ?? (existentes.length > 0 ? await agendaPadraoDaIa(accountId) : null)
    const decisao = decidirAgendamento({
      modo,
      existentes,
      inicio: start,
      deUtc,
      agendaPedida,
      agendaAlvo,
      profissionalPedido: Boolean(input.profissional?.trim()),
      titulo: title,
    })
    const linkDoMeet = (location: string | null | undefined) =>
      location && /meet\.google\.com/.test(location) ? location : null

    if (decisao.acao === 'nao-achou') {
      console.warn(
        `[ai schedule] nada foi mexido (${decisao.motivo}): de ${modo?.tipo === 'remarca' ? modo.deLocal : '?'} para ${startsLocal}, ${existentes.length} consulta(s) do contato`,
      )
      const c = decisao.alvo
      return {
        naoAchou: true,
        motivo: decisao.motivo,
        deLocal: modo?.tipo === 'remarca' ? modo.deLocal : null,
        startsLocal,
        titulo: title,
        ...(decisao.motivo === 'sem-modo' ? { consultas: existentes.length } : {}),
        ...(c
          ? {
              conflito: {
                titulo: (c.title ?? '').trim(),
                agenda: c.calendarName?.trim() || null,
                startsAt: new Date(c.startsAt).toISOString(),
              },
            }
          : {}),
        ...(decisao.motivo === 'outra-agenda' ? { profissional: input.profissional?.trim() || null } : {}),
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
      // O título da consulta movida FICA (02/10, revisão): é onde está o nome
      // de qual filho. Antes a IA o trocava pelo dela — a consulta do Davi
      // movida virava "Avaliação Bianca" e ninguém sabia mais de quem era.
      const tituloAntigo = (existing.title ?? '').trim()
      const tituloMantido = tituloAntigo || title
      const iaChamouDeOutroJeito = tituloAntigo !== '' && tituloNormalizado(title) !== tituloNormalizado(tituloAntigo)
      await db
        .update(calendarEvents)
        .set({
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          // Consulta sem título nenhum ganha o da IA (não há nome a perder).
          ...(tituloAntigo ? {} : { title }),
          ...(deal?.id ? { dealId: deal.id } : {}),
          // Horário mudou = compromisso novo para quem vai ser avisado. Sem
          // zerar, `reminders_sent` (que só anda para frente) faz a data nova
          // nascer com os degraus queimados, e o lembrete da remarcação —
          // justamente o mais necessário — nunca sai. 02/10/2026: a regra é a
          // do recomecoDoLembrete (a mesma da Agenda e do Google) — a IA que
          // move e depois devolve ao horário de antes restaura o contador
          // dele, e o lembrete que já tinha saído não sai de novo.
          ...(sameTime ? {} : recomecoDoLembrete(existing, start)),
          // ⏳ A confirmação da Agenda que estava na fila (02/10, revisão): a
          // IA remarca E confirma o horário novo na própria conversa. Sem
          // isto, a fila mandava DEPOIS a dela ("remarcada para…") — duas
          // mensagens. Sai da fila, e o horário novo vira o que o paciente já
          // sabe (a próxima edição na Agenda compara com ele). O desfecho
          // diz por que não saiu (a tela não mostra 'descartada' como aviso)
          // — só quando havia algo na fila (2ª revisão de 02/10).
          ...(sameTime ? {} : confirmacaoDadaPelaIa(existing, start)),
          // O import do Google só sobrescreve a linha que ninguém mexeu desde
          // a listagem dele (02/10, revisão) — e "mexeu" é o updated_at. Sem
          // isto, a remarcação da IA podia ser desfeita pela foto velha.
          updatedAt: sql`now()`,
        })
        .where(and(eq(calendarEvents.id, existing.id), eq(calendarEvents.accountId, accountId)))
      if (!sameTime) {
        try {
          await pushEventToGoogle(accountId, existing.id, 'update')
        } catch (err) {
          console.error('[ai schedule] google update falhou:', err)
        }
      }
      // Ficou outra do mesmo contato no horário antigo? (02/10, revisão) Pode
      // ser a mesma lançada em duas agendas, ou a de outra pessoa da família:
      // não dá para saber daqui, então NÃO é movida — a nota avisa.
      const ficou = sameTime ? [] : ficouNoHorarioAntigo(existentes, existing)
      return {
        eventId: existing.id,
        startsAt: start.toISOString(),
        title: tituloMantido,
        // Remarcou (horário mudou): quem chama avisa o lead com o link de
        // sempre. Mesmo horário = marcador repetido, nada a avisar.
        rescheduled: !sameTime,
        acao: sameTime ? 'manteve' : 'moveu',
        ...(sameTime
          ? {}
          : {
              movidoDe: new Date(existing.startsAt).toISOString(),
              movidoDeFim: new Date(existing.endsAt).toISOString(),
              tituloAntigo: tituloMantido,
              ...(iaChamouDeOutroJeito ? { tituloDaIa: title } : {}),
              ...(ficou.length ? { ficouNoHorarioAntigo: ficou } : {}),
            }),
        meetLink: linkDoMeet(existing.location),
      }
    }

    // Criar. A agenda padrão só é CRIADA aqui — ela pode criar a "Minha
    // agenda" em conta sem nenhuma, e isso não pode acontecer num marcador que
    // só moveu ou repetiu. Já lida acima (`agendaAlvo`), é a mesma: a conferência
    // de "ocupado" foi feita contra a agenda onde a consulta nasce.
    const calendarId = agendaAlvo ?? (await ensureAiCalendar(accountId, userId))
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

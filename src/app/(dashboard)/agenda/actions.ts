'use server'

// ============================================================
// Agenda — server actions (base interna; sync Google entra depois).
// Multi-calendário por conta; eventos com vínculo opcional a contato/negócio.
// v1: escopo por conta (time vê a agenda da conta); owner_user_id marca o dono.
// ============================================================

import { and, asc, eq, gt, gte, lte, ne, or, sql } from 'drizzle-orm'
import { db, calendars, calendarEvents, calendarConnections, contacts, deals, user } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { googleConfigured } from '@/lib/google/calendar'
import {
  isMeetingReminderBlock,
  type MeetingReminderBlock,
} from '@/lib/ai/meeting-reminder-block'
import { apagarEventoNoGoogle, importGoogleEvents, pushEventToGoogle } from '@/lib/google/sync'
import { planoDaEdicao } from '@/lib/google/event-move'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  FUSO_PADRAO,
  isConfirmacaoConhecida,
  isConfirmacaoEnviando,
  isDesfechoDaConfirmacao,
  type ConfirmacaoConhecida,
  type ConfirmacaoNaTela as ConfirmacaoNaTelaDaFila,
  type DesfechoDaConfirmacao,
} from '@/lib/agenda/confirmacao-agendamento'
import {
  agendarConfirmacao,
  conferirEdicaoSemCaixa,
  descartarConfirmacaoPendente,
} from '@/lib/agenda/confirmacao-fila'
import { aindaVaiAcontecer, ERRO_REMARCACAO_INDISPONIVEL, podeRemarcar } from '@/lib/agenda/remarcacao'

export type CalendarRow = {
  id: string
  name: string
  color: string
  ownerUserId: string | null
  ownerName: string | null
  source: 'local' | 'google'
  isVisible: boolean
}

export type EventRow = {
  id: string
  calendarId: string
  calendarName: string
  calendarColor: string
  title: string
  description: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  status: 'confirmed' | 'cancelled'
  source: 'local' | 'google'
  ownerUserId: string | null
  ownerName: string | null
  contactId: string | null
  contactName: string | null
  dealId: string | null
  dealTitle: string | null
  /**
   * Por que o lembrete deste compromisso não conseguiu sair (migração 0199).
   * null = sem impedimento. A tela mostra isso NO compromisso: antes, o aviso
   * da consulta sumia sem deixar rastro e quem marcou não ficava sabendo.
   */
  reminderBlock: MeetingReminderBlock | null
  /**
   * Confirmação ao paciente na fila (migração 0204, 02/10): quando sai (ISO).
   * null = nada pendente. O modal diz "na fila: sai às HH:MM".
   */
  confirmationDueAt: string | null
  /** O que o paciente já sabe — base da próxima confirmação (baseDaConfirmacao). */
  confirmationKnown: ConfirmacaoConhecida | null
  /** Último desfecho da fila: "não enviada" fica NO compromisso, não num toast. */
  confirmationResult: DesfechoDaConfirmacao | null
}

export type EventInput = {
  title: string
  startsAt: string
  endsAt: string
  allDay?: boolean
  calendarId?: string | null
  description?: string | null
  location?: string | null
  contactId?: string | null
  dealId?: string | null
  /**
   * A caixa "Enviar confirmação ao paciente pelo WhatsApp" do modal (01/10).
   * Só `true` pede; sem ela (qualquer outro caminho) nada sai. Desde 02/10 o
   * salvar só põe na FILA: sai uns minutos depois do último salvar, só a
   * versão final (lib/agenda/confirmacao-fila.ts). Na edição, só vale se mudou
   * dia/hora, o profissional (agenda de outra pessoa) ou o paciente, comparado
   * com o que o paciente já sabe — a fila confere.
   */
  notifyPatient?: boolean
  /**
   * A caixa estava NA TELA e foi desmarcada (02/10): tira da fila a confirmação
   * pendente. Salvar SEM a caixa na tela (só mudou o título) não mexe na fila:
   * o worker manda o estado final do mesmo jeito.
   */
  descartarConfirmacaoPendente?: boolean
  /** Conversa de onde a recepção clicou "Agendar": a confirmação sai por ela. */
  conversationId?: string | null
}

/**
 * Compromisso NOVO no modal (createEvent). 02/10: o paciente já tinha consulta
 * futura e a recepção respondeu "é remarcação da consulta X" — ver
 * lib/agenda/remarcacao.ts.
 */
export type NovoEventoInput = EventInput & {
  /**
   * A consulta que este salvar REMARCA. Presente: nada é criado — a consulta X
   * é editada (updateEvent) com o que está no formulário, depois de o servidor
   * conferir que ela é desta conta, do MESMO paciente, está de pé e é futura.
   */
  remarcaEventoId?: string | null
}

/**
 * Uma consulta futura do paciente, para a pergunta "remarcação ou consulta
 * nova?" do modal (02/10).
 *
 * Sem "marcada pela IA": scheduleEventFromAi (lib/ai/schedule-actions.ts) grava
 * created_by = dono da configuração da IA (um usuário de verdade) e source
 * 'local' — igualzinho a um compromisso criado pela recepção. Não há como
 * afirmar com segurança quem marcou, então a tela não afirma.
 */
export type ConsultaFutura = {
  id: string
  startsAt: string
  endsAt: string
  allDay: boolean
  calendarId: string
  calendarName: string
  title: string
  /** Confirmação dela na fila (ISO) — a caixa do modal diz "já está na fila". */
  confirmationDueAt: string | null
  /** O que o paciente já sabe dela: a prévia "remarcada" compara com isso (baseDaConfirmacao). */
  confirmationKnown: ConfirmacaoConhecida | null
}

/** Quantas consultas futuras a pergunta mostra (famílias têm 2-3 no mesmo contato). */
const MAX_CONSULTAS_FUTURAS = 5

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** O que vai para o modal depois de salvar. Ver lib/agenda/confirmacao-agendamento.ts. */
export type ConfirmacaoNaTela = ConfirmacaoNaTelaDaFila

/**
 * A confirmação deste salvar, sem NUNCA atrapalhar o salvamento: roda depois
 * de o compromisso estar gravado no CRM (antes do espelho no Google — ver
 * createEvent), e qualquer falha vira aviso, não erro do salvar.
 *
 * 02/10: não envia mais nada aqui. Caixa marcada → põe na fila (sai uns
 * minutos depois, só a versão final); caixa desmarcada na tela → tira da fila.
 *
 * Edição SEM a caixa na tela (02/10, revisão): o modal decide mostrar a caixa
 * com o que a grade diz que o paciente sabe, e a grade pode estar velha (sem
 * Google próprio ela não recarrega sozinha). O servidor relê o que o paciente
 * sabe de verdade e, se esta mudança pede aviso, faz o que a caixa marcada
 * faria — ver conferirEdicaoSemCaixa. Compromisso novo sem a caixa: nada.
 */
async function confirmacaoDoSalvar(args: {
  accountId: string
  eventId: string
  notifyPatient?: boolean
  descartar?: boolean
  /** Como estava antes deste salvar. null = compromisso novo. */
  antes: ConfirmacaoConhecida | null
  conversationId?: string | null
}): Promise<ConfirmacaoNaTela> {
  try {
    if (args.notifyPatient === true) {
      return await agendarConfirmacao({
        accountId: args.accountId,
        eventId: args.eventId,
        antes: args.antes,
        conversationId: args.conversationId ?? null,
      })
    }
    if (args.descartar === true) {
      return await descartarConfirmacaoPendente({ accountId: args.accountId, eventId: args.eventId })
    }
    if (args.antes) {
      return await conferirEdicaoSemCaixa({
        accountId: args.accountId,
        eventId: args.eventId,
        antes: args.antes,
        conversationId: args.conversationId ?? null,
      })
    }
    return null
  } catch (err) {
    console.error('[agenda] confirmação ao paciente:', err)
    return { naoEnviada: 'não foi possível agendar a confirmação agora' }
  }
}

/** Preferências da conta que o modal da Agenda precisa saber. */
export async function getAgendaPrefs(): Promise<{
  /** A conta ligou a confirmação ao agendar (bookingConfirmation). */
  confirmacaoAoAgendar: boolean
  /** Fuso da conta — a prévia da confirmação mostra o horário nele. */
  timezone: string
}> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  return {
    confirmacaoAoAgendar: s.bookingConfirmation === true,
    timezone: s.businessTimezone || FUSO_PADRAO,
  }
}

/** Garante (e devolve) uma agenda padrão do usuário; cria "Minha agenda" se faltar. */
async function ensureDefaultCalendar(
  accountId: string,
  userId: string,
): Promise<string> {
  const existing = firstOrNull(
    await db
      .select({ id: calendars.id })
      .from(calendars)
      .where(eq(calendars.accountId, accountId))
      .orderBy(asc(calendars.createdAt))
      .limit(1),
  )
  if (existing) return existing.id
  const created = firstOrThrow(
    await db
      .insert(calendars)
      .values({
        accountId,
        ownerUserId: userId,
        createdBy: userId,
        name: 'Minha agenda',
        color: '#6366f1',
      })
      .returning({ id: calendars.id }),
  )
  return created.id
}

// ---------- O que vem da tela tem que ser DESTA conta ----------
// 01/10: createEvent/updateEvent aceitavam qualquer calendarId/contactId/dealId.
// Com o UUID de uma agenda de outra conta, o push escrevia no Google DELA (e o
// evento agora leva o telefone do paciente, que o import de lá liga a um
// contato de lá). Com o de um contato/negócio de outra conta, a Agenda mostrava
// o nome dele aqui.

/**
 * A agenda é desta conta? Devolve se ela sincroniza com o Google; null = não é.
 * (O nome da agenda — "trocou o profissional?" — é lido pela fila da
 * confirmação na hora de decidir, 02/10.)
 */
async function agendaDaConta(
  accountId: string,
  calendarId: string,
): Promise<{ google: boolean } | null> {
  const c = firstOrNull(
    await db
      .select({
        googleCalendarId: calendars.googleCalendarId,
        connectionId: calendars.connectionId,
      })
      .from(calendars)
      .where(and(eq(calendars.id, calendarId), eq(calendars.accountId, accountId)))
      .limit(1),
  )
  return c ? { google: Boolean(c.googleCalendarId && c.connectionId) } : null
}

async function contatoDaConta(accountId: string, contactId: string): Promise<boolean> {
  const c = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  return Boolean(c)
}

async function negocioDaConta(accountId: string, dealId: string): Promise<boolean> {
  const d = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  )
  return Boolean(d)
}

/** Agendas da conta (cria a padrão na primeira visita). */
export async function listCalendars(): Promise<CalendarRow[]> {
  const ctx = await getCurrentAccount()
  await ensureDefaultCalendar(ctx.accountId, ctx.userId)
  const rows = await db
    .select({
      id: calendars.id,
      name: calendars.name,
      color: calendars.color,
      ownerUserId: calendars.ownerUserId,
      ownerName: user.name,
      source: calendars.source,
      isVisible: calendars.isVisible,
    })
    .from(calendars)
    .leftJoin(user, eq(calendars.ownerUserId, user.id))
    .where(eq(calendars.accountId, ctx.accountId))
    .orderBy(asc(calendars.createdAt))
  return rows as CalendarRow[]
}

/** Eventos num intervalo [from, to] (ISO). Junta cor/dono/contato/negócio. */
export async function listEvents(range: {
  from: string
  to: string
}): Promise<EventRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: calendarEvents.id,
      calendarId: calendarEvents.calendarId,
      calendarName: calendars.name,
      calendarColor: calendars.color,
      title: calendarEvents.title,
      description: calendarEvents.description,
      location: calendarEvents.location,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      allDay: calendarEvents.allDay,
      status: calendarEvents.status,
      source: calendarEvents.source,
      ownerUserId: calendarEvents.ownerUserId,
      ownerName: user.name,
      contactId: calendarEvents.contactId,
      contactName: contacts.name,
      dealId: calendarEvents.dealId,
      dealTitle: deals.title,
      reminderBlock: calendarEvents.reminderBlock,
      confirmationDueAt: calendarEvents.confirmationDueAt,
      confirmationKnown: calendarEvents.confirmationKnown,
      confirmationResult: calendarEvents.confirmationResult,
    })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendarEvents.calendarId, calendars.id))
    .leftJoin(user, eq(calendarEvents.ownerUserId, user.id))
    .leftJoin(contacts, eq(calendarEvents.contactId, contacts.id))
    .leftJoin(deals, eq(calendarEvents.dealId, deals.id))
    .where(
      and(
        eq(calendarEvents.accountId, ctx.accountId),
        // Sobreposição com a janela: começa antes do fim E termina depois do início.
        lte(calendarEvents.startsAt, range.to),
        gte(calendarEvents.endsAt, range.from),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt))
  // A coluna é texto livre: valida antes de entregar para a tela, senão um
  // valor antigo/desconhecido viraria um aviso sem rótulo. As da confirmação
  // (jsonb, 02/10) também — ver confirmacaoParaTela.
  return rows.map((r) => ({
    ...r,
    reminderBlock: isMeetingReminderBlock(r.reminderBlock) ? r.reminderBlock : null,
    ...confirmacaoParaTela(r),
  })) as EventRow[]
}

/** As colunas da confirmação como a tela lê (listEvents e estadoDaConfirmacao). */
export type EstadoDaConfirmacao = Pick<EventRow, 'confirmationDueAt' | 'confirmationKnown' | 'confirmationResult'>

/**
 * jsonb validado e vencimento em ISO — o texto cru do Postgres ("2026-10-02
 * 14:05:00+00") nem todo navegador lê.
 *
 * O marcador 'enviando' (02/10, revisão) não é desfecho e não vai como tal.
 * Enquanto o worker envia, o vencimento gravado é o lease (agora + 10 min),
 * que não é quando a confirmação sai: a tela recebe a hora do marcador, já
 * passada, e diz "saindo agora".
 */
function confirmacaoParaTela(r: {
  confirmationDueAt: string | null
  confirmationKnown: unknown
  confirmationResult: unknown
}): EstadoDaConfirmacao {
  const saindo = isConfirmacaoEnviando(r.confirmationResult) && r.confirmationDueAt ? r.confirmationResult.at : null
  const due = saindo ?? r.confirmationDueAt
  return {
    confirmationDueAt: due ? new Date(due).toISOString() : null,
    confirmationKnown: isConfirmacaoConhecida(r.confirmationKnown) ? r.confirmationKnown : null,
    confirmationResult: isDesfechoDaConfirmacao(r.confirmationResult) ? r.confirmationResult : null,
  }
}

/**
 * O estado da confirmação de UM compromisso, fresco do banco (02/10, revisão).
 * O modal pede ao abrir a edição: a grade só recarrega sozinha com o Google
 * conectado, e o que o worker gravou depois (a "remarcada" que saiu, o "não
 * enviada") não estava nela — o modal comparava com o que o paciente sabia
 * ANTES e escondia a caixa de uma mudança que precisava de aviso.
 * Escopo da conta; null = não achou. Erro lança (o modal fica com a grade).
 */
export async function estadoDaConfirmacao(eventId: string): Promise<EstadoDaConfirmacao | null> {
  const ctx = await getCurrentAccount()
  if (!eventId || !UUID.test(eventId)) return null
  const r = firstOrNull(
    await db
      .select({
        confirmationDueAt: calendarEvents.confirmationDueAt,
        confirmationKnown: calendarEvents.confirmationKnown,
        confirmationResult: calendarEvents.confirmationResult,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.accountId, ctx.accountId)))
      .limit(1),
  )
  return r ? confirmacaoParaTela(r) : null
}

/**
 * As consultas futuras do paciente (02/10), para o modal de compromisso NOVO
 * perguntar "remarcação ou consulta nova?". De pé ('confirmed'), que ainda vão
 * acontecer (com hora: começa no futuro; dia inteiro: termina no futuro — a
 * régua de aindaVaiAcontecer), da mais próxima para a mais distante, até
 * MAX_CONSULTAS_FUTURAS. Escopo da conta. Erro LANÇA: o modal diz "não deu
 * para conferir" em vez de tratar como "não tem nenhuma".
 */
export async function listarConsultasFuturasDoContato(contactId: string): Promise<ConsultaFutura[]> {
  const ctx = await getCurrentAccount()
  if (!contactId || !UUID.test(contactId)) return []
  const rows = await db
    .select({
      id: calendarEvents.id,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      allDay: calendarEvents.allDay,
      calendarId: calendarEvents.calendarId,
      calendarName: calendars.name,
      title: calendarEvents.title,
      confirmationDueAt: calendarEvents.confirmationDueAt,
      confirmationKnown: calendarEvents.confirmationKnown,
    })
    .from(calendarEvents)
    .innerJoin(calendars, and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, ctx.accountId)))
    .where(
      and(
        eq(calendarEvents.accountId, ctx.accountId),
        eq(calendarEvents.contactId, contactId),
        eq(calendarEvents.status, 'confirmed'),
        or(
          and(eq(calendarEvents.allDay, false), gt(calendarEvents.startsAt, sql`now()`)),
          and(eq(calendarEvents.allDay, true), gt(calendarEvents.endsAt, sql`now()`)),
        ),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt))
    .limit(MAX_CONSULTAS_FUTURAS)
  // Datas em ISO, como no listEvents: o texto cru do Postgres nem todo
  // navegador lê. O filtro de novo aqui é a mesma régua do servidor ao salvar.
  const agora = new Date()
  return rows
    .map((r) => ({
      ...r,
      startsAt: new Date(r.startsAt).toISOString(),
      endsAt: new Date(r.endsAt).toISOString(),
      confirmationDueAt: r.confirmationDueAt ? new Date(r.confirmationDueAt).toISOString() : null,
      confirmationKnown: isConfirmacaoConhecida(r.confirmationKnown) ? r.confirmationKnown : null,
    }))
    .filter((r) => aindaVaiAcontecer(r, agora))
}

export async function createEvent(
  input: NovoEventoInput,
): Promise<{ id: string | null; error: string | null; confirmacao?: ConfirmacaoNaTela }> {
  try {
    const ctx = await getCurrentAccount()
    const title = input.title?.trim()
    if (!title) return { id: null, error: 'Título é obrigatório' }
    if (!input.startsAt || !input.endsAt)
      return { id: null, error: 'Início e fim são obrigatórios' }

    // 🔁 Remarcação (02/10): a recepção respondeu no modal que esta consulta
    // é a consulta X remarcada. Nada é criado — X é EDITADA com o que está no
    // formulário, pelo MESMO caminho da edição (updateEvent): o histórico
    // fica, o Google move (inclusive trocando de agenda — planoDaEdicao), os
    // lembretes zeram com a data nova e a confirmação ao paciente sai como
    // "remarcada" (ou "agora é com", se só trocou o profissional) pela fila.
    // Antes, a consulta nova nascia ao lado e a antiga ficava de pé: lembrete
    // do horário errado e uma cadeira ocupada à toa.
    //
    // O servidor confere X ANTES de gravar qualquer coisa: desta conta, do
    // MESMO paciente do formulário, de pé e futura. Entre abrir o modal e
    // salvar, X pode ter sido cancelada (no Google, por outra pessoa).
    const { remarcaEventoId, ...doFormulario } = input
    if (remarcaEventoId) {
      const alvo =
        UUID.test(remarcaEventoId) && input.contactId
          ? firstOrNull(
              await db
                .select({
                  status: calendarEvents.status,
                  contactId: calendarEvents.contactId,
                  startsAt: calendarEvents.startsAt,
                  endsAt: calendarEvents.endsAt,
                  allDay: calendarEvents.allDay,
                })
                .from(calendarEvents)
                .where(and(eq(calendarEvents.id, remarcaEventoId), eq(calendarEvents.accountId, ctx.accountId)))
                .limit(1),
            )
          : null
      if (!podeRemarcar(alvo, input.contactId, new Date())) {
        return { id: null, error: ERRO_REMARCACAO_INDISPONIVEL }
      }
      const r = await updateEvent(remarcaEventoId, doFormulario)
      if (r.error) return { id: null, error: r.error }
      return { id: remarcaEventoId, error: null, confirmacao: r.confirmacao }
    }

    // Garante fim > início (senão o Google recusa com timeRangeEmpty).
    let endsAt = input.endsAt
    if (new Date(endsAt).getTime() <= new Date(input.startsAt).getTime()) {
      endsAt = new Date(new Date(input.startsAt).getTime() + 3_600_000).toISOString()
    }

    let calendarId: string
    if (input.calendarId) {
      if (!(await agendaDaConta(ctx.accountId, input.calendarId))) {
        return { id: null, error: 'Agenda não encontrada.' }
      }
      calendarId = input.calendarId
    } else {
      calendarId = await ensureDefaultCalendar(ctx.accountId, ctx.userId)
    }
    if (input.contactId && !(await contatoDaConta(ctx.accountId, input.contactId))) {
      return { id: null, error: 'Contato não encontrado.' }
    }
    if (input.dealId && !(await negocioDaConta(ctx.accountId, input.dealId))) {
      return { id: null, error: 'Negócio não encontrado.' }
    }

    const created = firstOrThrow(
      await db
        .insert(calendarEvents)
        .values({
          accountId: ctx.accountId,
          calendarId,
          ownerUserId: ctx.userId,
          createdBy: ctx.userId,
          title,
          description: input.description?.trim() || null,
          location: input.location?.trim() || null,
          startsAt: input.startsAt,
          endsAt,
          allDay: input.allDay ?? false,
          contactId: input.contactId || null,
          dealId: input.dealId || null,
        })
        .returning({ id: calendarEvents.id }),
    )
    // ✅ Confirmação ao paciente (01/10): só com a caixa do modal marcada e
    // paciente ligado. Desde 02/10 vai para a FILA (sai uns minutos depois,
    // só a versão final). ANTES do Google: o espelho leva 1-2 s, e a varredura
    // de lembretes pula o compromisso com confirmação pendente — o pendente tem
    // que estar gravado antes dela passar. O compromisso já está gravado no
    // CRM, que é a agenda oficial.
    const confirmacao = await confirmacaoDoSalvar({
      accountId: ctx.accountId,
      eventId: created.id,
      notifyPatient: input.notifyPatient === true && Boolean(input.contactId),
      descartar: input.descartarConfirmacaoPendente === true,
      antes: null,
      conversationId: input.conversationId ?? null,
    })
    // Espelha no Google se a agenda for do Google (best-effort).
    try {
      await pushEventToGoogle(ctx.accountId, created.id, 'create')
    } catch (err) {
      console.error('[agenda] push create → google:', err)
    }
    return { id: created.id, error: null, confirmacao }
  } catch (err) {
    return { id: null, error: err instanceof Error ? err.message : 'Falha ao criar evento' }
  }
}

export async function updateEvent(
  id: string,
  patch: Partial<EventInput> & { status?: 'confirmed' | 'cancelled' },
): Promise<{ error: string | null; confirmacao?: ConfirmacaoNaTela }> {
  try {
    const ctx = await getCurrentAccount()
    const set: Record<string, unknown> = { updatedAt: sql`now()` }
    if (patch.title !== undefined) set.title = patch.title.trim()
    if (patch.description !== undefined) set.description = patch.description?.trim() || null
    if (patch.location !== undefined) set.location = patch.location?.trim() || null
    if (patch.startsAt !== undefined) set.startsAt = patch.startsAt
    if (patch.endsAt !== undefined) set.endsAt = patch.endsAt
    if (patch.allDay !== undefined) set.allDay = patch.allDay
    // Garante fim > início (evita timeRangeEmpty no Google).
    if (
      patch.startsAt !== undefined &&
      patch.endsAt !== undefined &&
      new Date(patch.endsAt).getTime() <= new Date(patch.startsAt).getTime()
    ) {
      set.endsAt = new Date(new Date(patch.startsAt).getTime() + 3_600_000).toISOString()
    }
    // Como o compromisso está ANTES de gravar: a data (lembretes) e a agenda
    // (trocar de agenda no Google). A agenda vem junto só se for desta conta.
    const antes = firstOrNull(
      await db
        .select({
          startsAt: calendarEvents.startsAt,
          calendarId: calendarEvents.calendarId,
          // Para a confirmação: o que o paciente sabia antes deste salvar.
          contactId: calendarEvents.contactId,
          googleEventId: calendarEvents.googleEventId,
          calGoogleId: calendars.googleCalendarId,
          connectionId: calendars.connectionId,
        })
        .from(calendarEvents)
        .leftJoin(calendars, and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, ctx.accountId)))
        .where(and(eq(calendarEvents.id, id), eq(calendarEvents.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!antes) return { error: 'Compromisso não encontrado.' }

    // Agenda vazia/null não é troca (a coluna é NOT NULL): fica onde está.
    let novaAgenda: { calendarId: string; google: boolean } | null = null
    if (patch.calendarId) {
      const agenda = await agendaDaConta(ctx.accountId, patch.calendarId)
      if (!agenda) return { error: 'Agenda não encontrada.' }
      novaAgenda = { calendarId: patch.calendarId, google: agenda.google }
    }
    if (patch.contactId && !(await contatoDaConta(ctx.accountId, patch.contactId))) {
      return { error: 'Contato não encontrado.' }
    }
    if (patch.dealId && !(await negocioDaConta(ctx.accountId, patch.dealId))) {
      return { error: 'Negócio não encontrado.' }
    }

    // Remarcou a consulta → é um compromisso novo para quem vai ser avisado.
    // `reminders_sent` só anda para frente, então sem zerar aqui a data nova já
    // nasce com os degraus queimados e o paciente não recebe nada da remarcação
    // — que é exatamente quando ele MAIS precisa ser avisado. O bloqueio antigo
    // também vai embora: fala de uma tentativa que não existe mais.
    if (
      patch.startsAt !== undefined &&
      new Date(antes.startsAt).getTime() !== new Date(patch.startsAt).getTime()
    ) {
      set.remindersSent = 0
      set.reminderBlock = null
      set.reminderBlockAt = null
    }
    if (patch.contactId !== undefined) set.contactId = patch.contactId || null
    if (patch.dealId !== undefined) set.dealId = patch.dealId || null
    if (patch.status !== undefined) set.status = patch.status

    // 🔀 Trocou de agenda (ver lib/google/event-move.ts): grava a troca com o
    // vínculo do Google zerado, apaga o evento na agenda ANTIGA pelo id que
    // estava gravado e cria na nova. Sem isso o evento antigo ficava no Google e
    // voltava pelo import como um compromisso fantasma — com o telefone do
    // paciente. Grava ANTES de apagar: se o UPDATE falhar, nada saiu do Google
    // (apagar primeiro deixaria a linha apontando para um evento apagado, e o
    // import a daria por cancelada).
    const plano = planoDaEdicao(
      {
        calendarId: antes.calendarId,
        googleEventId: antes.googleEventId,
        google: Boolean(antes.calGoogleId && antes.connectionId),
      },
      novaAgenda,
    )
    if (plano.trocou && novaAgenda) {
      set.calendarId = novaAgenda.calendarId
      set.googleEventId = null
      // O vínculo com o Google é refeito pelo push 'create' (que volta a marcar 'google').
      set.source = 'local'
    }

    await db
      .update(calendarEvents)
      .set(set)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.accountId, ctx.accountId)))

    // ✅ Confirmação ao paciente (01/10) — logo depois de gravar e ANTES do
    // Google: a varredura de lembretes (de minuto em minuto) pula o
    // compromisso com confirmação pendente, então o pendente chega primeiro.
    // Desde 02/10 vai para a FILA: sai uns minutos depois do último salvar,
    // só a versão final. A fila confere se a edição mudou o que o paciente
    // precisa saber — dia/hora, o profissional (agenda de OUTRA pessoa, no
    // mesmo horário: tipo 'profissional') ou o próprio paciente — comparando
    // com o que ele já sabe. Corrigir o título não manda nada. Cancelado e
    // horário passado são barrados lá (decidirConfirmacao). Caixa desmarcada
    // na tela: tira da fila o que estiver pendente.
    const confirmacao = await confirmacaoDoSalvar({
      accountId: ctx.accountId,
      eventId: id,
      notifyPatient: patch.notifyPatient,
      descartar: patch.descartarConfirmacaoPendente,
      antes: { startsAt: antes.startsAt, calendarId: antes.calendarId, contactId: antes.contactId ?? null },
      conversationId: patch.conversationId ?? null,
    })

    if (plano.apagarNaAntiga && antes.googleEventId) {
      try {
        await apagarEventoNoGoogle(ctx.accountId, antes.calendarId, antes.googleEventId)
        // Corrida com o import: se ele leu a agenda antiga antes do UPDATE, o
        // evento voltou como compromisso NOVO (ligado ao paciente pelo telefone
        // do bloco) e mandaria lembrete do horário antigo. Já não existe no
        // Google: cancela a cópia.
        await db
          .update(calendarEvents)
          .set({ status: 'cancelled', updatedAt: sql`now()` })
          .where(
            and(
              eq(calendarEvents.accountId, ctx.accountId),
              eq(calendarEvents.calendarId, antes.calendarId),
              eq(calendarEvents.googleEventId, antes.googleEventId),
              ne(calendarEvents.id, id),
              eq(calendarEvents.status, 'confirmed'),
            ),
          )
      } catch (err) {
        // Best-effort, como todo push: a troca no CRM fica. O evento antigo
        // pode ficar no Google — o log é o rastro.
        console.error('[agenda] trocar de agenda: apagar na agenda antiga do Google falhou:', err)
      }
    }
    // Espelha a edição no Google (best-effort).
    if (plano.pushDepois) {
      try {
        await pushEventToGoogle(ctx.accountId, id, plano.pushDepois)
      } catch (err) {
        console.error(`[agenda] push ${plano.pushDepois} → google:`, err)
      }
    }

    return { error: null, confirmacao }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao atualizar evento' }
  }
}

export async function deleteEvent(id: string): Promise<{ error: string | null }> {
  try {
    // Confirmação na fila (02/10) vai junto com a linha: o worker só pega o
    // que existe, e o envio que já estava em voo diz "não encontrado" (sem
    // nota na conversa — foi a recepção que apagou).
    const ctx = await getCurrentAccount()
    // Apaga no Google ANTES de remover do banco (precisa ler o google_event_id).
    try {
      await pushEventToGoogle(ctx.accountId, id, 'delete')
    } catch (err) {
      console.error('[agenda] push delete → google:', err)
    }
    await db
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover evento' }
  }
}

export async function createCalendar(input: {
  name: string
  color?: string
}): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = input.name?.trim()
    if (!name) return { id: null, error: 'Nome é obrigatório' }
    const created = firstOrThrow(
      await db
        .insert(calendars)
        .values({
          accountId: ctx.accountId,
          ownerUserId: ctx.userId,
          createdBy: ctx.userId,
          name,
          color: input.color?.trim() || '#6366f1',
        })
        .returning({ id: calendars.id }),
    )
    return { id: created.id, error: null }
  } catch (err) {
    return { id: null, error: err instanceof Error ? err.message : 'Falha ao criar agenda' }
  }
}

export async function updateCalendar(
  id: string,
  patch: { name?: string; color?: string; isVisible?: boolean },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const set: Record<string, unknown> = { updatedAt: sql`now()` }
    if (patch.name !== undefined) set.name = patch.name.trim()
    if (patch.color !== undefined) set.color = patch.color.trim()
    if (patch.isVisible !== undefined) set.isVisible = patch.isVisible
    await db
      .update(calendars)
      .set(set)
      .where(and(eq(calendars.id, id), eq(calendars.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao atualizar agenda' }
  }
}

export async function deleteCalendar(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Não deixa apagar a última agenda da conta.
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(calendars)
      .where(eq(calendars.accountId, ctx.accountId))
    if ((count[0]?.n ?? 0) <= 1) {
      return { error: 'Você precisa de pelo menos uma agenda.' }
    }
    await db
      .delete(calendars)
      .where(and(eq(calendars.id, id), eq(calendars.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover agenda' }
  }
}

// ---------- Google Calendar ----------

export type GoogleStatus = {
  configured: boolean // env do servidor pronto (GOOGLE_CLIENT_ID/SECRET)
  connected: boolean
  email: string | null
}

/** Estado da conexão Google do usuário atual. */
export async function getGoogleStatus(): Promise<GoogleStatus> {
  const ctx = await getCurrentAccount()
  const conn = firstOrNull(
    await db
      .select({ email: calendarConnections.googleEmail })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
      .limit(1),
  )
  return { configured: googleConfigured(), connected: Boolean(conn), email: conn?.email ?? null }
}

/** Reimporta eventos das agendas Google do usuário (Google → CRM). */
export async function syncGoogleNow(): Promise<{ imported: number; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const conns = await db
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
    let imported = 0
    for (const c of conns) {
      const r = await importGoogleEvents(ctx.accountId, c.id)
      imported += r.imported
    }
    return { imported, error: null }
  } catch (err) {
    return { imported: 0, error: err instanceof Error ? err.message : 'Falha ao sincronizar' }
  }
}

/** Desconecta o Google (apaga a conexão; as agendas Google saem em cascata). */
/**
 * Desconecta o Google — e SÓ isso.
 *
 * ⚠️ 30/09/2026, clínica da Dra. Joyce: alguém clicou aqui (provavelmente
 * tentando fazer as subagendas aparecerem) e a conta perdeu **160 compromissos**
 * de uma vez. O banco tem `calendars.connection_id ON DELETE CASCADE` e
 * `calendar_events.calendar_id ON DELETE CASCADE`: apagar a conexão derrubava a
 * agenda, e a agenda derrubava todas as consultas — as 130 futuras inclusive.
 * A clínica ficou sem nenhum lembrete de consulta e ninguém foi avisado de nada.
 *
 * Desconectar é dizer "pare de sincronizar", nunca "apague minha agenda". Agora
 * as agendas são soltas da conexão ANTES (connection_id = null), então a cascata
 * não alcança nada: os compromissos ficam, visíveis e com os pacientes ligados.
 *
 * Reconectar depois não duplica: `descobrirAgendas` reata pelo `google_calendar_id`,
 * que continua gravado.
 */
export async function disconnectGoogle(): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // 1º solta as agendas da conexão — senão o CASCADE leva os eventos junto.
    await db
      .update(calendars)
      .set({ connectionId: null, updatedAt: sql`now()` })
      .where(eq(calendars.accountId, ctx.accountId))
    // 2º remove a conexão (é só o par de tokens).
    await db
      .delete(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao desconectar' }
  }
}

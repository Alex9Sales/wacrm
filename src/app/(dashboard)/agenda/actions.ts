'use server'

// ============================================================
// Agenda — server actions (base interna; sync Google entra depois).
// Multi-calendário por conta; eventos com vínculo opcional a contato/negócio.
// v1: escopo por conta (time vê a agenda da conta); owner_user_id marca o dono.
// ============================================================

import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm'
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
  tipoDaConfirmacaoNaEdicao,
  type ResultadoConfirmacao,
  type TipoConfirmacao,
} from '@/lib/agenda/confirmacao-agendamento'
import { enviarConfirmacaoDoAgendamento } from '@/lib/agenda/confirmacao-envio'

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
   * Só `true` manda; sem ela (qualquer outro caminho) nada sai. Na edição, só
   * vale se mudou dia/hora, agenda ou paciente — a action confere.
   */
  notifyPatient?: boolean
  /** Conversa de onde a recepção clicou "Agendar": a confirmação sai por ela. */
  conversationId?: string | null
}

/** O que vai para o modal depois de salvar. Ver lib/agenda/confirmacao-agendamento.ts. */
export type ConfirmacaoNaTela = ResultadoConfirmacao | null

/**
 * Manda a confirmação sem NUNCA atrapalhar o salvamento: roda depois de o
 * compromisso estar gravado (e espelhado no Google), e qualquer falha vira
 * aviso, não erro do salvar.
 */
async function confirmarAoPaciente(args: {
  accountId: string
  eventId: string
  tipo: TipoConfirmacao
  conversationId?: string | null
}): Promise<ConfirmacaoNaTela> {
  try {
    return await enviarConfirmacaoDoAgendamento(args)
  } catch (err) {
    console.error('[agenda] confirmação ao paciente:', err)
    return { naoEnviada: 'não foi possível enviar a confirmação agora' }
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

/** A agenda é desta conta? Devolve se ela sincroniza com o Google; null = não é. */
async function agendaDaConta(accountId: string, calendarId: string): Promise<{ google: boolean } | null> {
  const c = firstOrNull(
    await db
      .select({ googleCalendarId: calendars.googleCalendarId, connectionId: calendars.connectionId })
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
  // valor antigo/desconhecido viraria um aviso sem rótulo.
  return rows.map((r) => ({
    ...r,
    reminderBlock: isMeetingReminderBlock(r.reminderBlock) ? r.reminderBlock : null,
  })) as EventRow[]
}

export async function createEvent(
  input: EventInput,
): Promise<{ id: string | null; error: string | null; confirmacao?: ConfirmacaoNaTela }> {
  try {
    const ctx = await getCurrentAccount()
    const title = input.title?.trim()
    if (!title) return { id: null, error: 'Título é obrigatório' }
    if (!input.startsAt || !input.endsAt)
      return { id: null, error: 'Início e fim são obrigatórios' }

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
    // Espelha no Google se a agenda for do Google (best-effort).
    try {
      await pushEventToGoogle(ctx.accountId, created.id, 'create')
    } catch (err) {
      console.error('[agenda] push create → google:', err)
    }
    // ✅ Confirmação ao paciente (01/10): só com a caixa do modal marcada e
    // paciente ligado. Depois do Google, de propósito: o compromisso já está
    // salvo em todo lugar antes de qualquer mensagem sair.
    const confirmacao =
      input.notifyPatient === true && input.contactId
        ? await confirmarAoPaciente({
            accountId: ctx.accountId,
            eventId: created.id,
            tipo: 'marcacao',
            conversationId: input.conversationId ?? null,
          })
        : null
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
          // Para a confirmação: paciente ligado agora é consulta nova para ele.
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

    // ✅ Confirmação ao paciente (01/10): só com a caixa marcada E se a edição
    // mudou o que o paciente precisa saber — dia/hora, agenda (profissional)
    // ou o próprio paciente. Corrigir o título não manda nada. Cancelado e
    // horário passado são barrados lá dentro (decidirConfirmacao).
    let confirmacao: ConfirmacaoNaTela = null
    if (patch.notifyPatient === true) {
      const tipo = tipoDaConfirmacaoNaEdicao({
        antes: {
          startsAt: antes.startsAt,
          calendarId: antes.calendarId,
          contactId: antes.contactId ?? null,
        },
        depois: {
          startsAt: patch.startsAt ?? antes.startsAt,
          calendarId: plano.trocou && novaAgenda ? novaAgenda.calendarId : antes.calendarId,
          contactId: patch.contactId !== undefined ? patch.contactId || null : (antes.contactId ?? null),
        },
      })
      if (tipo) {
        confirmacao = await confirmarAoPaciente({
          accountId: ctx.accountId,
          eventId: id,
          tipo,
          conversationId: patch.conversationId ?? null,
        })
      }
    }
    return { error: null, confirmacao }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao atualizar evento' }
  }
}

export async function deleteEvent(id: string): Promise<{ error: string | null }> {
  try {
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

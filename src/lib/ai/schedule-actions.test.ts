import { beforeEach, describe, it, expect, vi } from 'vitest'

// 02/10/2026: [[AGENDAR]] com 4º campo (nova / remarca X). Banco, Google, fila
// e configurações da conta trocados por stubs: o SELECT dos compromissos do
// contato devolve `h.existentes` (já "futuros confirmados deste contato" — o
// WHERE é do banco), e cada UPDATE/INSERT fica guardado para conferir o que
// foi mexido.
const h = vi.hoisted(() => ({
  existentes: [] as {
    id: string
    startsAt: string
    endsAt: string
    allDay: boolean
    calendarId: string
    calendarName?: string | null
    contactId?: string | null
    title: string
    location: string | null
    confirmationDueAt?: string | null
  }[],
  agendas: [] as { id: string; name: string }[],
  updates: [] as { values: Record<string, unknown> }[],
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  googlePushes: [] as unknown[][],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const tableName = (t: unknown) =>
    t === actual.calendarEvents
      ? 'calendar_events'
      : t === actual.calendars
        ? 'calendars'
        : t === actual.deals
          ? 'deals'
          : '?'
  const rowsFor = (table: string) => {
    if (table === 'calendar_events') return h.existentes
    // agendaDoProfissional (id + nome) e ensureAiCalendar (a 1ª) leem daqui.
    if (table === 'calendars') return h.agendas
    return []
  }
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c
    c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, ko)
    return c
  }
  const db = {
    select: () => ({ from: (table: unknown) => chain(() => rowsFor(tableName(table))) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          h.updates.push({ values })
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ table: tableName(table), values })
        return { returning: async () => [{ id: 'ev-novo' }] }
      },
    }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/google/sync', () => ({
  pushEventToGoogle: async (...a: unknown[]) => {
    h.googlePushes.push(a)
  },
}))
vi.mock('@/lib/queue/queues', () => ({ enqueueScheduledMessage: async () => {} }))
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => ({ aiCalendarId: null, aiMeetingOnline: false, aiMeetingInvitees: [] }),
}))

import {
  confirmacaoDadaPelaIa,
  decidirAgendamento,
  motivoSemAlvo,
  notaDaRemarcacaoSemAlvo,
  notaDoAgendamentoDaIa,
  scheduleEventFromAi,
  tituloDoAvisoSemAlvo,
  zonedWallToUtc,
  type CompromissoExistente,
  type ScheduleNotFound,
  type ScheduleResult,
} from './schedule-actions'

const TZ = 'America/Sao_Paulo'

/** Consulta futura do contato (hora de parede em São Paulo, UTC-3). */
function consulta(id: string, local: string, calendarId: string, min = 30): CompromissoExistente & {
  allDay: boolean
  title: string
  location: string | null
} {
  const ini = zonedWallToUtc(local, TZ)!
  return {
    id,
    startsAt: ini.toISOString(),
    endsAt: new Date(ini.getTime() + min * 60000).toISOString(),
    allDay: false,
    calendarId,
    contactId: 'contato-1',
    title: `Consulta ${id}`,
    location: null,
  }
}

const base = {
  accountId: 'conta-1',
  userId: 'dono-1',
  conversationId: 'conv-1',
  contactId: 'contato-1',
  title: 'Limpeza · Nina',
  timezone: TZ,
}

beforeEach(() => {
  h.existentes = []
  h.agendas = [
    { id: 'cal-padrao', name: 'Clínica Exemplo' },
    { id: 'cal-marta', name: 'Dra. Marta Teixeira' },
    { id: 'cal-otavio', name: 'Dr. Otávio Prates' },
  ]
  h.updates = []
  h.inserts = []
  h.googlePushes = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('zonedWallToUtc', () => {
  it('converte hora de parede de São Paulo (UTC-3) pra UTC', () => {
    // 15:00 em America/Sao_Paulo = 18:00 UTC (sem horário de verão desde 2019).
    const d = zonedWallToUtc('2026-08-16T15:00', 'America/Sao_Paulo')
    expect(d?.toISOString()).toBe('2026-08-16T18:00:00.000Z')
  })

  it('aceita espaço no lugar do T', () => {
    const d = zonedWallToUtc('2026-08-16 09:30', 'America/Sao_Paulo')
    expect(d?.toISOString()).toBe('2026-08-16T12:30:00.000Z')
  })

  it('formato inválido = null', () => {
    expect(zonedWallToUtc('amanhã às 3', 'America/Sao_Paulo')).toBeNull()
  })
})

describe('decidirAgendamento (pura)', () => {
  const leo = consulta('leo', '2026-10-21T09:30', 'cal-marta')
  const nina = consulta('nina', '2026-10-28T14:00', 'cal-otavio')
  const em = (local: string) => zonedWallToUtc(local, TZ)!
  /** Sem profissional: a nova nasceria na padrão. */
  const semProf = { agendaPedida: null, agendaAlvo: 'cal-padrao', profissionalPedido: false, titulo: 'Limpeza · Nina' }
  const comMarta = { agendaPedida: 'cal-marta', agendaAlvo: 'cal-marta', profissionalPedido: true, titulo: 'Limpeza · Nina' }
  const comOtavio = { agendaPedida: 'cal-otavio', agendaAlvo: 'cal-otavio', profissionalPedido: true, titulo: 'Limpeza · Nina' }

  it('sem 4º campo e sem consulta: cria', () => {
    expect(decidirAgendamento({ modo: null, existentes: [], inicio: em('2026-10-23T10:00'), deUtc: null, ...semProf })).toEqual({
      acao: 'criar',
    })
  })

  // Revisão de 02/10: sem modo, mover "a mais próxima" mexia na consulta do
  // irmão. Só move quando há UMA e ela é compatível.
  it('sem 4º campo e DUAS consultas: não mexe em nada (sem-modo)', () => {
    const d = decidirAgendamento({ modo: null, existentes: [leo, nina], inicio: em('2026-10-23T10:00'), deUtc: null, ...semProf })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-modo' })
  })

  it('sem 4º campo e UMA consulta, sem profissional pedido: move (o de sempre)', () => {
    const d = decidirAgendamento({ modo: null, existentes: [leo], inicio: em('2026-10-23T10:00'), deUtc: null, ...semProf })
    expect(d).toEqual({ acao: 'mover', alvo: leo })
  })

  it('sem 4º campo e UMA consulta, com o profissional dela: move; de OUTRO profissional: não mexe', () => {
    expect(decidirAgendamento({ modo: null, existentes: [leo], inicio: em('2026-10-23T10:00'), deUtc: null, ...comMarta })).toEqual({
      acao: 'mover',
      alvo: leo,
    })
    expect(decidirAgendamento({ modo: null, existentes: [leo], inicio: em('2026-10-23T10:00'), deUtc: null, ...comOtavio })).toEqual({
      acao: 'nao-achou',
      motivo: 'sem-modo',
    })
  })

  it('sem 4º campo, profissional nomeado mas NÃO reconhecido: não chuta que é o mesmo', () => {
    const d = decidirAgendamento({
      modo: null,
      existentes: [leo],
      inicio: em('2026-10-23T10:00'),
      deUtc: null,
      agendaPedida: null,
      agendaAlvo: 'cal-padrao',
      profissionalPedido: true,
      titulo: 'Avaliação · Léo',
    })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-modo' })
  })

  it('sem 4º campo, repetição (mesmo minuto, mesma agenda, mesmo título): mantém', () => {
    const d = decidirAgendamento({
      modo: null,
      existentes: [leo, nina],
      inicio: em('2026-10-28T14:00'),
      deUtc: null,
      agendaPedida: 'cal-otavio',
      agendaAlvo: 'cal-otavio',
      profissionalPedido: true,
      titulo: 'consulta  NINA',
    })
    expect(d).toEqual({ acao: 'manter', alvo: nina })
  })

  it('sem 4º campo, UMA consulta no MESMO horário com outro título: não mexe (não há para onde mover)', () => {
    const d = decidirAgendamento({ modo: null, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, ...semProf })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-modo' })
  })

  it('nova: cria mesmo com outras consultas', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo, nina], inicio: em('2026-10-23T10:00'), deUtc: null, ...comMarta })
    expect(d).toEqual({ acao: 'criar' })
  })

  it('nova repetida (mesmo início, mesma agenda, mesmo título): não cria outra', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'nova' },
      existentes: [leo],
      inicio: em('2026-10-21T09:30'),
      deUtc: null,
      ...comMarta,
      titulo: 'Consulta leo',
    })
    expect(d).toEqual({ acao: 'manter', alvo: leo })
  })

  it('nova no mesmo horário e MESMA agenda com outro título: profissional ocupado — nada criado, título intacto', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, ...comMarta })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'ocupado', alvo: leo })
  })

  it('nova começando DENTRO de uma consulta do contato na mesma agenda: ocupado', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:45'), deUtc: null, ...comMarta })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'ocupado', alvo: leo })
    // Logo depois do fim (10h): livre.
    expect(decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T10:00'), deUtc: null, ...comMarta })).toEqual({
      acao: 'criar',
    })
  })

  it('nova no mesmo início com OUTRO profissional (dois filhos, duas cadeiras): cria', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, ...comOtavio })
    expect(d).toEqual({ acao: 'criar' })
  })

  it('nova sem profissional: compara com a agenda PADRÃO (não com qualquer agenda)', () => {
    // Antes, sem profissional reconhecido, o "mesmo minuto" em QUALQUER agenda
    // virava "mantém": a consulta da irmã com outra profissional não nascia.
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, ...semProf })
    expect(d).toEqual({ acao: 'criar' })
    const naPadrao = consulta('mae', '2026-10-21T09:30', 'cal-padrao')
    expect(
      decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [naPadrao], inicio: em('2026-10-21T09:30'), deUtc: null, ...semProf }),
    ).toEqual({ acao: 'nao-achou', motivo: 'ocupado', alvo: naPadrao })
  })

  it('remarca X: move exatamente a de X, não a mais próxima', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-28T14:00' },
      existentes: [leo, nina],
      inicio: em('2026-10-30T15:00'),
      deUtc: em('2026-10-28T14:00'),
      ...semProf,
    })
    expect(d).toEqual({ acao: 'mover', alvo: nina })
  })

  it('remarca X sem consulta em X: não acha (não mexe em nada)', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-22T09:30' },
      existentes: [leo, nina],
      inicio: em('2026-10-30T15:00'),
      deUtc: em('2026-10-22T09:30'),
      ...semProf,
    })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-compromisso' })
  })

  it('remarca já feita e reemitida (X sumiu, já existe no horário novo): mantém', () => {
    const movida = consulta('nina', '2026-10-30T15:00', 'cal-otavio')
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-28T14:00' },
      existentes: [leo, movida],
      inicio: em('2026-10-30T15:00'),
      deUtc: em('2026-10-28T14:00'),
      ...semProf,
    })
    expect(d).toEqual({ acao: 'manter', alvo: movida })
  })

  it('duas em X com profissionais diferentes: desempata pela agenda; sem profissional, não chuta', () => {
    const irmao = consulta('irmao', '2026-10-21T09:30', 'cal-otavio')
    const args = {
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' } as const,
      existentes: [leo, irmao],
      inicio: em('2026-10-23T10:00'),
      deUtc: em('2026-10-21T09:30'),
    }
    expect(decidirAgendamento({ ...args, ...comOtavio })).toEqual({ acao: 'mover', alvo: irmao })
    expect(decidirAgendamento({ ...args, ...semProf })).toEqual({ acao: 'nao-achou', motivo: 'ambiguo' })
  })

  it('remarca X com profissional de OUTRA agenda: troca de profissional fica com a recepção', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' },
      existentes: [leo],
      inicio: em('2026-10-23T10:00'),
      deUtc: em('2026-10-21T09:30'),
      ...comOtavio,
    })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'outra-agenda', alvo: leo })
  })

  it('remarca sem dizer qual: não acha', () => {
    const d = decidirAgendamento({ modo: { tipo: 'remarca', deLocal: null }, existentes: [leo], inicio: em('2026-10-23T10:00'), deUtc: null, ...semProf })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-data' })
  })
})

describe('scheduleEventFromAi com o 4º campo', () => {
  it('sem 4º campo e UMA consulta (o de sempre): move, mantém a agenda, a duração e o TÍTULO dela', async () => {
    h.existentes = [{ ...consulta('leo', '2026-10-21T09:30', 'cal-marta', 30), title: 'Avaliação · Léo' }]
    const ev = (await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })) as ScheduleResult
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].values).toMatchObject({
      startsAt: '2026-10-23T13:00:00.000Z',
      // 30 min continuam 30 min (antes virava 60).
      endsAt: '2026-10-23T13:30:00.000Z',
      remindersSent: 0,
    })
    expect(h.updates[0].values).not.toHaveProperty('calendarId')
    // Revisão de 02/10: o título (de QUAL filho) fica.
    expect(h.updates[0].values).not.toHaveProperty('title')
    expect(ev).toMatchObject({
      eventId: 'leo',
      acao: 'moveu',
      rescheduled: true,
      movidoDe: '2026-10-21T12:30:00.000Z',
      movidoDeFim: '2026-10-21T13:00:00.000Z',
      title: 'Avaliação · Léo',
      tituloAntigo: 'Avaliação · Léo',
      // A IA escreveu outra coisa: a nota mostra os dois.
      tituloDaIa: 'Limpeza · Nina',
    })
    expect(h.googlePushes).toEqual([['conta-1', 'leo', 'update']])
  })

  it('sem 4º campo e DUAS consultas: não mexe em nada e diz quantas o contato tem', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta', 30), consulta('nina', '2026-10-28T14:00', 'cal-otavio')]
    const ev = await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(h.googlePushes).toHaveLength(0)
    expect(ev).toEqual({
      naoAchou: true,
      motivo: 'sem-modo',
      deLocal: null,
      startsLocal: '2026-10-23T10:00',
      titulo: 'Limpeza · Nina',
      consultas: 2,
    })
  })

  it('sem 4º campo e sem consulta: cria na agenda padrão com 60 min', async () => {
    const ev = (await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })) as ScheduleResult
    expect(h.updates).toHaveLength(0)
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].values).toMatchObject({
      calendarId: 'cal-padrao',
      contactId: 'contato-1',
      startsAt: '2026-10-23T13:00:00.000Z',
      endsAt: '2026-10-23T14:00:00.000Z',
    })
    expect(ev).toMatchObject({ eventId: 'ev-novo', acao: 'criou' })
    expect(ev.mantidas).toBeUndefined()
  })

  it('nova: cria OUTRA na agenda do profissional e não toca na que existe', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta')]
    const ev = (await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'nova' },
    })) as ScheduleResult
    expect(h.updates).toHaveLength(0)
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].values).toMatchObject({ calendarId: 'cal-otavio', startsAt: '2026-10-23T13:00:00.000Z' })
    expect(ev).toMatchObject({ eventId: 'ev-novo', acao: 'criou', mantidas: ['2026-10-21T12:30:00.000Z'] })
  })

  it('nova repetida no turno seguinte: devolve a que existe, sem criar nem mover', async () => {
    h.existentes = [{ ...consulta('nova-1', '2026-10-23T10:00', 'cal-otavio'), title: 'Limpeza · Nina' }]
    const ev = (await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'nova' },
    })) as ScheduleResult
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(h.googlePushes).toHaveLength(0)
    expect(ev).toMatchObject({ eventId: 'nova-1', acao: 'manteve', rescheduled: false })
  })

  it('nova no horário em que o MESMO profissional já atende outra pessoa da família: nada criado, título intacto', async () => {
    h.existentes = [
      { ...consulta('davi', '2026-10-23T10:00', 'cal-otavio'), title: 'Avaliação · Davi', calendarName: 'Dr. Otávio Prates' },
    ]
    const ev = await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'nova' },
    })
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(ev).toMatchObject({
      naoAchou: true,
      motivo: 'ocupado',
      titulo: 'Limpeza · Nina',
      conflito: { titulo: 'Avaliação · Davi', agenda: 'Dr. Otávio Prates', startsAt: '2026-10-23T13:00:00.000Z' },
    })
  })

  it('nova sem profissional, no mesmo horário de uma consulta em OUTRA agenda: cria na padrão', async () => {
    h.existentes = [consulta('davi', '2026-10-23T10:00', 'cal-otavio')]
    const ev = (await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00', modo: { tipo: 'nova' } })) as ScheduleResult
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].values).toMatchObject({ calendarId: 'cal-padrao' })
    expect(ev.acao).toBe('criou')
  })

  it('remarca X (achou): move SÓ a de X, mesmo não sendo a mais próxima', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta'), consulta('nina', '2026-10-28T14:00', 'cal-otavio', 60)]
    const ev = (await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-30T15:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'remarca', deLocal: '2026-10-28T14:00' },
    })) as ScheduleResult
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].values).toMatchObject({ startsAt: '2026-10-30T18:00:00.000Z', endsAt: '2026-10-30T19:00:00.000Z' })
    expect(ev).toMatchObject({ eventId: 'nina', acao: 'moveu', movidoDe: '2026-10-28T17:00:00.000Z' })
    expect(ev.ficouNoHorarioAntigo).toBeUndefined()
    expect(h.googlePushes).toEqual([['conta-1', 'nina', 'update']])
  })

  it('remarca X (NÃO achou): não mexe em nada e devolve o erro para a nota', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta')]
    const ev = await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-30T15:00',
      modo: { tipo: 'remarca', deLocal: '2026-10-22T09:30' },
    })
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(h.googlePushes).toHaveLength(0)
    expect(ev).toEqual({
      naoAchou: true,
      motivo: 'sem-compromisso',
      deLocal: '2026-10-22T09:30',
      startsLocal: '2026-10-30T15:00',
      titulo: 'Limpeza · Nina',
    })
  })

  it('remarca com profissional de OUTRA agenda: NÃO move (troca de profissional é com a recepção)', async () => {
    h.existentes = [{ ...consulta('leo', '2026-10-21T09:30', 'cal-marta'), calendarName: 'Dra. Marta Teixeira' }]
    const ev = await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' },
    })
    expect(h.updates).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
    expect(ev).toMatchObject({
      naoAchou: true,
      motivo: 'outra-agenda',
      profissional: 'Dr. Otávio',
      conflito: { agenda: 'Dra. Marta Teixeira' },
    })
  })

  it('moveu e ficou OUTRA do mesmo contato no horário antigo (lançada em duas agendas, ou da família): avisa, não move', async () => {
    h.existentes = [
      { ...consulta('leo-a', '2026-10-21T09:30', 'cal-marta'), title: 'Avaliação · Léo', calendarName: 'Dra. Marta Teixeira' },
      { ...consulta('leo-b', '2026-10-21T09:30', 'cal-otavio'), title: 'Avaliação · Léo', calendarName: 'Dr. Otávio Prates' },
    ]
    const ev = (await scheduleEventFromAi({
      ...base,
      title: 'Avaliação · Léo',
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dra. Marta',
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' },
    })) as ScheduleResult
    expect(h.updates).toHaveLength(1)
    expect(ev).toMatchObject({ eventId: 'leo-a', acao: 'moveu' })
    expect(ev.ficouNoHorarioAntigo).toEqual([
      { startsAt: '2026-10-21T12:30:00.000Z', agenda: 'Dr. Otávio Prates', titulo: 'Avaliação · Léo' },
    ])
    expect(ev.tituloDaIa).toBeUndefined()
  })
})

describe('a IA move a consulta: a confirmação da Agenda que estava na fila sai dela (revisão de 02/10)', () => {
  it('horário mudou COM uma na fila: tira da fila, o horário novo vira o que o paciente sabe e o desfecho diz por quê', async () => {
    h.existentes = [{ ...consulta('leo', '2026-10-21T09:30', 'cal-marta', 30), confirmationDueAt: '2026-10-02 12:05:00+00' }]
    await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].values).toMatchObject({
      confirmationDueAt: null,
      confirmationConversationId: null,
      confirmationKnown: { startsAt: '2026-10-23T13:00:00.000Z', calendarId: 'cal-marta', contactId: 'contato-1' },
      confirmationResult: { status: 'descartada', motivo: 'a IA remarcou e confirmou na conversa' },
    })
    // Carimba updated_at: o import do Google não desfaz a remarcação com a foto velha.
    expect(h.updates[0].values).toHaveProperty('updatedAt')
  })

  it('horário mudou SEM nada na fila: só o que o paciente sabe muda — o último desfecho fica', async () => {
    // 2ª revisão de 02/10: gravar 'descartada' sem pendente apagava o
    // "enviada em…" / "não enviada — …" que o modal mostra.
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta', 30)]
    await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })

    expect(h.updates[0].values).toMatchObject({
      confirmationKnown: { startsAt: '2026-10-23T13:00:00.000Z', calendarId: 'cal-marta', contactId: 'contato-1' },
    })
    for (const campo of ['confirmationDueAt', 'confirmationConversationId', 'confirmationResult']) {
      expect(h.updates[0].values).not.toHaveProperty(campo)
    }
  })

  it('marcador repetido no MESMO horário: nada é gravado (nem a fila)', async () => {
    h.existentes = [{ ...consulta('leo', '2026-10-23T10:00', 'cal-padrao', 30), title: 'Limpeza · Nina' }]
    const ev = (await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })) as ScheduleResult

    expect(ev.acao).toBe('manteve')
    expect(h.updates).toHaveLength(0)
  })

  it('criar não mexe na fila (compromisso novo não tem confirmação pendente)', async () => {
    await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })

    expect(h.inserts[0].values).not.toHaveProperty('confirmationResult')
  })

  it('confirmacaoDadaPelaIa (pura): sem pendente, só o conhecido (paciente null quando não há)', () => {
    const agora = new Date('2026-10-02T12:00:00.000Z')
    expect(confirmacaoDadaPelaIa({ calendarId: 'cal-x' }, new Date('2026-10-23T13:00:00.000Z'), agora)).toEqual({
      confirmationKnown: { startsAt: '2026-10-23T13:00:00.000Z', calendarId: 'cal-x', contactId: null },
    })
  })

  it('confirmacaoDadaPelaIa (pura): com pendente, tira da fila e diz por quê', () => {
    const agora = new Date('2026-10-02T12:00:00.000Z')
    expect(
      confirmacaoDadaPelaIa(
        { calendarId: 'cal-x', contactId: 'c-1', confirmationDueAt: '2026-10-02T12:05:00.000Z' },
        new Date('2026-10-23T13:00:00.000Z'),
        agora,
      ),
    ).toEqual({
      confirmationDueAt: null,
      confirmationConversationId: null,
      confirmationKnown: { startsAt: '2026-10-23T13:00:00.000Z', calendarId: 'cal-x', contactId: 'c-1' },
      confirmationResult: {
        status: 'descartada',
        motivo: 'a IA remarcou e confirmou na conversa',
        at: '2026-10-02T12:00:00.000Z',
      },
    })
  })
})

describe('notas internas do [[AGENDAR]]', () => {
  const ev = (o: Partial<ScheduleResult>): ScheduleResult => ({
    eventId: 'x',
    startsAt: '2026-10-23T13:00:00.000Z',
    title: 'Limpeza · Nina',
    acao: 'criou',
    ...o,
  })

  it('criou sem outras: o texto de sempre', () => {
    expect(notaDoAgendamentoDaIa(ev({}), TZ)).toBe(
      '📅 IA agendou "Limpeza · Nina" para sex 23/10, 10:00. Se não era pra marcar, cancele na Agenda — e, pra ela não marcar sozinha, desligue a ferramenta "Agendar" no agente (Agentes IA).',
    )
  })

  it('consulta NOVA mantendo a outra', () => {
    const nota = notaDoAgendamentoDaIa(ev({ mantidas: ['2026-10-21T12:30:00.000Z'] }), TZ)
    expect(nota).toMatch(/^📅 IA marcou consulta NOVA "Limpeza · Nina" para sex 23\/10, 10:00 \(mantendo a de qua 21\/10, 09:30\)/)
  })

  it('remarcou: diz DE QUEM é a consulta movida (o título que ficou) e de/para', () => {
    const nota = notaDoAgendamentoDaIa(
      ev({ acao: 'moveu', title: 'Avaliação · Davi', tituloAntigo: 'Avaliação · Davi', movidoDe: '2026-10-21T12:30:00.000Z', rescheduled: true }),
      TZ,
    )
    expect(nota).toMatch(/^📅 IA remarcou a consulta "Avaliação · Davi" de qua 21\/10, 09:30 para sex 23\/10, 10:00\. Se não era pra mexer/)
    expect(nota).not.toContain('a IA a chamou')
  })

  it('remarcou com a IA chamando de outro nome: mostra os dois', () => {
    const nota = notaDoAgendamentoDaIa(
      ev({
        acao: 'moveu',
        title: 'Avaliação · Davi',
        tituloAntigo: 'Avaliação · Davi',
        tituloDaIa: 'Avaliação · Bianca',
        movidoDe: '2026-10-21T12:30:00.000Z',
      }),
      TZ,
    )
    expect(nota).toContain('(o título foi mantido; a IA a chamou de "Avaliação · Bianca")')
  })

  it('remarcou e ficou outra no horário antigo: avisa o que olhar', () => {
    const nota = notaDoAgendamentoDaIa(
      ev({
        acao: 'moveu',
        movidoDe: '2026-10-21T12:30:00.000Z',
        ficouNoHorarioAntigo: [{ startsAt: '2026-10-21T12:30:00.000Z', agenda: 'Dr. Otávio Prates', titulo: 'Avaliação · Léo' }],
      }),
      TZ,
    )
    expect(nota).toContain(
      '⚠️ Ficou outra consulta deste contato em qua 21/10, 09:30 na agenda Dr. Otávio Prates: se era a mesma lançada em duas agendas, mova ou cancele também; se é de outra pessoa da família, deixe.',
    )
  })

  it('marcador repetido: diz que nada mudou', () => {
    expect(notaDoAgendamentoDaIa(ev({ acao: 'manteve', rescheduled: false }), TZ)).toMatch(/nada foi criado nem movido/)
  })

  it('remarca sem alvo: a recepção vê na conversa que nada foi mexido', () => {
    const nf: ScheduleNotFound = { naoAchou: true, motivo: 'sem-compromisso', deLocal: '2026-10-22T09:30', startsLocal: '2026-10-30T15:00' }
    expect(notaDaRemarcacaoSemAlvo(nf, TZ)).toBe(
      '📅 A IA tentou remarcar a consulta de qui 22/10, 09:30 para sex 30/10, 15:00, mas não achou essa consulta deste contato — nada foi mexido na Agenda. Confira com o cliente: a resposta da IA pode ter dito que remarcou.',
    )
    expect(notaDaRemarcacaoSemAlvo({ ...nf, motivo: 'ambiguo' }, TZ)).toMatch(/mais de uma consulta nesse horário/)
    expect(notaDaRemarcacaoSemAlvo({ ...nf, motivo: 'sem-data', deLocal: null }, TZ)).toMatch(/não disse qual/)
  })

  it('sem modo: diz que faltou dizer nova/remarcação e quantas consultas o contato tem', () => {
    const nf: ScheduleNotFound = {
      naoAchou: true,
      motivo: 'sem-modo',
      deLocal: null,
      startsLocal: '2026-10-30T15:00',
      titulo: 'Avaliação · Bianca',
      consultas: 2,
    }
    expect(notaDaRemarcacaoSemAlvo(nf, TZ)).toBe(
      '📅 A IA tentou marcar/remarcar "Avaliação · Bianca" para sex 30/10, 15:00 sem dizer se era consulta nova ou remarcação; o contato tem 2 consultas marcadas — nada foi alterado na Agenda. Confira com o cliente: a resposta da IA pode ter dito que marcou ou remarcou.',
    )
    expect(tituloDoAvisoSemAlvo(nf)).toMatch(/faltou dizer se era consulta nova ou remarcação/)
  })

  it('profissional ocupado e troca de profissional: o porquê, e que nada foi mexido', () => {
    const ocupado: ScheduleNotFound = {
      naoAchou: true,
      motivo: 'ocupado',
      deLocal: null,
      startsLocal: '2026-10-23T10:00',
      titulo: 'Limpeza · Nina',
      conflito: { titulo: 'Avaliação · Davi', agenda: 'Dr. Otávio Prates', startsAt: '2026-10-23T13:00:00.000Z' },
    }
    expect(notaDaRemarcacaoSemAlvo(ocupado, TZ)).toContain(
      'a agenda Dr. Otávio Prates já tem uma consulta deste contato nesse horário ("Avaliação · Davi") — nada foi criado nem alterado na Agenda.',
    )
    const outra: ScheduleNotFound = {
      naoAchou: true,
      motivo: 'outra-agenda',
      deLocal: '2026-10-21T09:30',
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      conflito: { titulo: 'Avaliação · Léo', agenda: 'Dra. Marta Teixeira', startsAt: '2026-10-21T12:30:00.000Z' },
    }
    expect(motivoSemAlvo(outra, TZ)).toBe(
      'A IA tentou remarcar a consulta de qua 21/10, 09:30 (com Dra. Marta Teixeira) para sex 23/10, 10:00 com "Dr. Otávio", mas troca de profissional fica com a recepção — nada foi mexido na Agenda.',
    )
    expect(tituloDoAvisoSemAlvo(outra)).toBe('IA não remarcou: troca de profissional')
  })
})

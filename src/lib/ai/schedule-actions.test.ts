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
    contactId?: string | null
    title: string
    location: string | null
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
  notaDaRemarcacaoSemAlvo,
  notaDoAgendamentoDaIa,
  scheduleEventFromAi,
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

  it('sem 4º campo e sem consulta: cria', () => {
    expect(decidirAgendamento({ modo: null, existentes: [], inicio: em('2026-10-23T10:00'), deUtc: null, agendaPedida: null })).toEqual({
      acao: 'criar',
    })
  })

  it('sem 4º campo: move a MAIS PRÓXIMA (o de sempre)', () => {
    const d = decidirAgendamento({ modo: null, existentes: [leo, nina], inicio: em('2026-10-23T10:00'), deUtc: null, agendaPedida: null })
    expect(d).toEqual({ acao: 'mover', alvo: leo })
  })

  it('sem 4º campo, mas já existe uma NESTE início: mexe nela — nunca puxa a mais próxima para cima', () => {
    // Antes: a da Nina (28/10) era reemitida, e a do Léo (21/10, a mais
    // próxima) era MOVIDA para 28/10 — duas iguais e a do Léo sumia.
    const d = decidirAgendamento({ modo: null, existentes: [leo, nina], inicio: em('2026-10-28T14:00'), deUtc: null, agendaPedida: null })
    expect(d).toEqual({ acao: 'mover', alvo: nina })
  })

  it('nova: cria mesmo com outras consultas', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo, nina], inicio: em('2026-10-23T10:00'), deUtc: null, agendaPedida: 'cal-marta' })
    expect(d).toEqual({ acao: 'criar' })
  })

  it('nova repetida no mesmo início e na mesma agenda: não cria outra', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, agendaPedida: 'cal-marta' })
    expect(d).toEqual({ acao: 'manter', alvo: leo })
  })

  it('nova no mesmo início com OUTRO profissional (dois filhos, duas cadeiras): cria', () => {
    const d = decidirAgendamento({ modo: { tipo: 'nova' }, existentes: [leo], inicio: em('2026-10-21T09:30'), deUtc: null, agendaPedida: 'cal-otavio' })
    expect(d).toEqual({ acao: 'criar' })
  })

  it('remarca X: move exatamente a de X, não a mais próxima', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-28T14:00' },
      existentes: [leo, nina],
      inicio: em('2026-10-30T15:00'),
      deUtc: em('2026-10-28T14:00'),
      agendaPedida: null,
    })
    expect(d).toEqual({ acao: 'mover', alvo: nina })
  })

  it('remarca X sem consulta em X: não acha (não mexe em nada)', () => {
    const d = decidirAgendamento({
      modo: { tipo: 'remarca', deLocal: '2026-10-22T09:30' },
      existentes: [leo, nina],
      inicio: em('2026-10-30T15:00'),
      deUtc: em('2026-10-22T09:30'),
      agendaPedida: null,
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
      agendaPedida: null,
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
    expect(decidirAgendamento({ ...args, agendaPedida: 'cal-otavio' })).toEqual({ acao: 'mover', alvo: irmao })
    expect(decidirAgendamento({ ...args, agendaPedida: null })).toEqual({ acao: 'nao-achou', motivo: 'ambiguo' })
  })

  it('remarca sem dizer qual: não acha', () => {
    const d = decidirAgendamento({ modo: { tipo: 'remarca', deLocal: null }, existentes: [leo], inicio: em('2026-10-23T10:00'), deUtc: null, agendaPedida: null })
    expect(d).toEqual({ acao: 'nao-achou', motivo: 'sem-data' })
  })
})

describe('scheduleEventFromAi com o 4º campo', () => {
  it('sem 4º campo (o de sempre): move a mais próxima, mantém a agenda e a duração dela', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta', 30), consulta('nina', '2026-10-28T14:00', 'cal-otavio')]
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
    expect(ev).toMatchObject({ eventId: 'leo', acao: 'moveu', rescheduled: true, movidoDe: '2026-10-21T12:30:00.000Z' })
    expect(h.googlePushes).toEqual([['conta-1', 'leo', 'update']])
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
    h.existentes = [consulta('nova-1', '2026-10-23T10:00', 'cal-otavio')]
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
    expect(ev.agendaDiferente).toBeUndefined()
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
    })
  })

  it('remarca com profissional de OUTRA agenda: move, fica na agenda original e avisa', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta')]
    const ev = (await scheduleEventFromAi({
      ...base,
      startsLocal: '2026-10-23T10:00',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' },
    })) as ScheduleResult
    expect(h.updates[0].values).not.toHaveProperty('calendarId')
    expect(ev).toMatchObject({ eventId: 'leo', acao: 'moveu', agendaDiferente: true })
  })
})

describe('a IA move a consulta: a confirmação da Agenda que estava na fila sai dela (revisão de 02/10)', () => {
  it('horário mudou: tira da fila, o horário novo vira o que o paciente sabe e o desfecho diz por quê', async () => {
    h.existentes = [consulta('leo', '2026-10-21T09:30', 'cal-marta', 30)]
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

  it('marcador repetido no MESMO horário: a fila fica como está', async () => {
    h.existentes = [consulta('leo', '2026-10-23T10:00', 'cal-marta', 30)]
    const ev = (await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })) as ScheduleResult

    expect(ev.acao).toBe('manteve')
    for (const campo of ['confirmationDueAt', 'confirmationConversationId', 'confirmationKnown', 'confirmationResult']) {
      expect(h.updates[0].values).not.toHaveProperty(campo)
    }
  })

  it('criar não mexe na fila (compromisso novo não tem confirmação pendente)', async () => {
    await scheduleEventFromAi({ ...base, startsLocal: '2026-10-23T10:00' })

    expect(h.inserts[0].values).not.toHaveProperty('confirmationResult')
  })

  it('confirmacaoDadaPelaIa (pura): consulta sem paciente fica com contactId null', () => {
    const agora = new Date('2026-10-02T12:00:00.000Z')
    expect(confirmacaoDadaPelaIa({ calendarId: 'cal-x' }, new Date('2026-10-23T13:00:00.000Z'), agora)).toEqual({
      confirmationDueAt: null,
      confirmationConversationId: null,
      confirmationKnown: { startsAt: '2026-10-23T13:00:00.000Z', calendarId: 'cal-x', contactId: null },
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

  it('remarcou de/para', () => {
    const nota = notaDoAgendamentoDaIa(ev({ acao: 'moveu', movidoDe: '2026-10-21T12:30:00.000Z', rescheduled: true }), TZ)
    expect(nota).toMatch(/^📅 IA remarcou a consulta de qua 21\/10, 09:30 para sex 23\/10, 10:00/)
    const outraAgenda = notaDoAgendamentoDaIa(ev({ acao: 'moveu', movidoDe: '2026-10-21T12:30:00.000Z', agendaDiferente: true }), TZ, {
      profissional: 'Dr. Otávio',
    })
    expect(outraAgenda).toContain('confira o profissional')
  })

  it('marcador repetido: diz que nada mudou', () => {
    expect(notaDoAgendamentoDaIa(ev({ acao: 'manteve', rescheduled: false }), TZ)).toMatch(/nada foi criado nem movido/)
  })

  it('remarca sem alvo: a recepção vê na conversa que nada foi mexido', () => {
    const nf: ScheduleNotFound = { naoAchou: true, motivo: 'sem-compromisso', deLocal: '2026-10-22T09:30', startsLocal: '2026-10-30T15:00' }
    expect(notaDaRemarcacaoSemAlvo(nf, TZ)).toBe(
      '📅 A IA tentou remarcar a consulta de qui 22/10, 09:30 para sex 30/10, 15:00, mas não achou essa consulta deste contato. Nada foi mexido na Agenda. Confira com o cliente: a resposta da IA pode ter dito que remarcou.',
    )
    expect(notaDaRemarcacaoSemAlvo({ ...nf, motivo: 'ambiguo' }, TZ)).toMatch(/mais de uma consulta nesse horário/)
    expect(notaDaRemarcacaoSemAlvo({ ...nf, motivo: 'sem-data', deLocal: null }, TZ)).toMatch(/não disse qual/)
  })
})

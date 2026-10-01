import { beforeEach, describe, expect, it, vi } from 'vitest'

// 01/10 — revisão do "paciente vai junto para o Google". Banco falso: cada
// SELECT (ou escrita com RETURNING) consome a próxima resposta da fila; as
// escritas e as chamadas ao Google ficam registradas NA ORDEM, porque a ordem
// é o que importa ao trocar de agenda (gravar ANTES de apagar na antiga).
//
// Dados fictícios (LGPD): nenhum paciente de verdade aqui.

type Rec = { op: string; set?: unknown; values?: unknown; returning?: boolean }

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[], calls: [] as Rec[], updateFalha: false }
  const chain = (op: string) => {
    const rec: Rec = { op }
    state.calls.push(rec)
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        const reads = op === 'select' || rec.returning
        promise =
          op === 'update' && state.updateFalha
            ? Promise.reject(new Error('connection terminated'))
            : Promise.resolve(reads ? (state.results.shift() ?? []) : undefined)
      }
      return promise
    }
    const self: unknown = new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = settle()
            return (p as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string].bind(p)
          }
          return (...args: unknown[]) => {
            if (prop === 'set') rec.set = args[0]
            if (prop === 'values') rec.values = args[0]
            if (prop === 'returning') rec.returning = true
            return self
          }
        },
      },
    )
    return self
  }
  return {
    state,
    db: {
      select: () => chain('select'),
      insert: () => chain('insert'),
      update: () => chain('update'),
      delete: () => chain('delete'),
    },
    push: vi.fn(async (_acc: string, _id: string, op: string) => {
      state.calls.push({ op: `google:${op}` })
    }),
    apagar: vi.fn(async () => {
      state.calls.push({ op: 'google:apagar-na-antiga' })
    }),
    // Confirmação ao paciente (01/10): o envio de verdade é testado em
    // lib/agenda/confirmacao-envio.test.ts; aqui importa QUANDO a action pede.
    confirmar: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => {
      state.calls.push({ op: 'confirmacao' })
      return 'enviada'
    }),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: 'acc-1', userId: 'u-1', role: 'admin' }),
}))
vi.mock('@/lib/google/sync', () => ({
  pushEventToGoogle: h.push,
  apagarEventoNoGoogle: h.apagar,
  importGoogleEvents: vi.fn(),
}))
vi.mock('@/lib/google/calendar', () => ({ googleConfigured: () => true }))
vi.mock('@/lib/agenda/confirmacao-envio', () => ({ enviarConfirmacaoDoAgendamento: h.confirmar }))

import { createEvent, updateEvent } from './actions'

const INPUT = { title: 'RSC', startsAt: '2026-10-05T14:00:00.000Z', endsAt: '2026-10-05T15:00:00.000Z' }
const ANTES_GOOGLE_A = {
  startsAt: '2026-10-05 14:00:00+00',
  calendarId: 'cal-a',
  googleEventId: 'g-a',
  calGoogleId: 'a@group.calendar.google.com',
  connectionId: 'conn-1',
}
const AGENDA_GOOGLE = [{ googleCalendarId: 'b@group.calendar.google.com', connectionId: 'conn-1' }]
const AGENDA_LOCAL = [{ googleCalendarId: null, connectionId: null }]

/** O que aconteceu, na ordem: escritas no banco e pushes para o Google. */
const passos = () => h.state.calls.filter((c) => c.op !== 'select').map((c) => c.op)
const gravado = () => h.state.calls.find((c) => c.op === 'update')?.set as Record<string, unknown> | undefined

beforeEach(() => {
  h.state.results = []
  h.state.calls = []
  h.state.updateFalha = false
  h.push.mockClear()
  h.apagar.mockClear()
  h.confirmar.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('trocar o compromisso de agenda', () => {
  it('Google → Google: grava com o vínculo zerado, apaga na antiga e cria na nova', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_GOOGLE)

    const res = await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-b' })

    expect(res).toEqual({ error: null, confirmacao: null })
    // O 2º update cancela a cópia que o import pode ter trazido da agenda antiga.
    expect(passos()).toEqual(['update', 'google:apagar-na-antiga', 'update', 'google:create'])
    expect(gravado()).toMatchObject({ calendarId: 'cal-b', googleEventId: null, source: 'local' })
    // Apaga pela agenda e pelo id que ESTAVAM gravados.
    expect(h.apagar).toHaveBeenCalledWith('acc-1', 'cal-a', 'g-a')
    const updates = h.state.calls.filter((c) => c.op === 'update')
    expect(updates[1]?.set).toMatchObject({ status: 'cancelled' })
  })

  it('Google → local: só apaga na antiga', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_LOCAL)

    await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-local' })

    expect(passos()).toEqual(['update', 'google:apagar-na-antiga', 'update'])
    expect(gravado()).toMatchObject({ calendarId: 'cal-local', googleEventId: null })
  })

  it('a mesma agenda de sempre (o modal manda em todo salvamento): só espelha a edição', async () => {
    h.state.results.push([ANTES_GOOGLE_A], [{ googleCalendarId: 'a@group.calendar.google.com', connectionId: 'conn-1' }])

    await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-a' })

    expect(passos()).toEqual(['update', 'google:update'])
    expect(gravado()).not.toHaveProperty('calendarId')
    expect(gravado()).not.toHaveProperty('googleEventId')
  })

  it('o UPDATE falhou: nada sai do Google', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_GOOGLE)
    h.state.updateFalha = true

    const res = await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-b' })

    expect(res.error).toBeTruthy()
    expect(h.apagar).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
  })

  it('o apagar na antiga falhou: a troca no CRM fica e a nova é criada (best-effort, com log)', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_GOOGLE)
    h.apagar.mockImplementationOnce(async () => {
      throw new Error('Google delete event (500)')
    })

    const res = await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-b' })

    expect(res).toEqual({ error: null, confirmacao: null })
    expect(passos()).toEqual(['update', 'google:create'])
  })
})

describe('o que vem da tela tem que ser desta conta', () => {
  it('criar numa agenda de outra conta: recusa, não grava e não vai ao Google', async () => {
    h.state.results.push([]) // a agenda não é da conta

    const res = await createEvent({ ...INPUT, calendarId: 'cal-de-outra-conta' })

    expect(res).toEqual({ id: null, error: 'Agenda não encontrada.' })
    expect(passos()).toEqual([])
  })

  it('criar com contato de outra conta: recusa', async () => {
    h.state.results.push(AGENDA_GOOGLE, [])

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'contato-de-outra-conta' })

    expect(res).toEqual({ id: null, error: 'Contato não encontrado.' })
    expect(passos()).toEqual([])
  })

  it('criar com agenda e contato da conta: grava e espelha', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'c-1' })

    expect(res).toEqual({ id: 'ev-novo', error: null, confirmacao: null })
    expect(passos()).toEqual(['insert', 'google:create'])
  })

  it('mover para agenda de outra conta: recusa, e nada sai da agenda antiga', async () => {
    h.state.results.push([ANTES_GOOGLE_A], [])

    const res = await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-de-outra-conta' })

    expect(res).toEqual({ error: 'Agenda não encontrada.' })
    expect(passos()).toEqual([])
  })

  it('ligar contato de outra conta: recusa', async () => {
    h.state.results.push([ANTES_GOOGLE_A], [])

    const res = await updateEvent('ev-1', { ...INPUT, contactId: 'contato-de-outra-conta' })

    expect(res).toEqual({ error: 'Contato não encontrado.' })
    expect(passos()).toEqual([])
  })

  it('compromisso que não é da conta: recusa', async () => {
    h.state.results.push([])

    const res = await updateEvent('ev-de-outra-conta', INPUT)

    expect(res).toEqual({ error: 'Compromisso não encontrado.' })
    expect(passos()).toEqual([])
  })
})

describe('confirmação ao paciente ao salvar (01/10)', () => {
  // O compromisso como estava: com paciente, na agenda local.
  const ANTES_COM_PACIENTE = {
    startsAt: '2026-10-05 14:00:00+00',
    calendarId: 'cal-a',
    contactId: 'c-1',
    googleEventId: null,
    calGoogleId: null,
    connectionId: null,
  }

  it('criar com paciente e a caixa marcada: pede UMA confirmação de marcação, depois de gravar e espelhar', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({
      ...INPUT,
      calendarId: 'cal-b',
      contactId: 'c-1',
      notifyPatient: true,
      conversationId: 'cv-1',
    })

    expect(res).toEqual({ id: 'ev-novo', error: null, confirmacao: 'enviada' })
    expect(h.confirmar).toHaveBeenCalledTimes(1)
    expect(h.confirmar).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: 'ev-novo',
      tipo: 'marcacao',
      conversationId: 'cv-1',
    })
    // A mensagem só sai com o compromisso salvo em todo lugar.
    expect(passos()).toEqual(['insert', 'google:create', 'confirmacao'])
  })

  it('criar com a caixa desmarcada (ou sem ela): nada sai', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'c-1', notifyPatient: false })

    expect(res.confirmacao).toBeNull()
    expect(h.confirmar).not.toHaveBeenCalled()
  })

  it('criar sem paciente: nada sai, mesmo com a caixa', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'ev-novo' }])

    await createEvent({ ...INPUT, calendarId: 'cal-b', notifyPatient: true })

    expect(h.confirmar).not.toHaveBeenCalled()
  })

  it('a confirmação falhou (até lançou): o compromisso fica salvo e o aviso volta para a tela', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])
    h.confirmar.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'c-1', notifyPatient: true })

    expect(res.id).toBe('ev-novo')
    expect(res.error).toBeNull()
    expect(res.confirmacao).toEqual({ naoEnviada: 'não foi possível enviar a confirmação agora' })
    expect(passos()).toContain('insert')
  })

  it('editar só o título (o modal manda o mesmo horário e a mesma agenda): nada sai', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    const res = await updateEvent('ev-1', {
      ...INPUT,
      title: 'Outro título',
      startsAt: '2026-10-05T14:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(res).toEqual({ error: null, confirmacao: null })
    expect(h.confirmar).not.toHaveBeenCalled()
  })

  it('mudar o horário: pede a confirmação de REMARCAÇÃO', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    const res = await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      endsAt: '2026-10-06T18:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(res).toEqual({ error: null, confirmacao: 'enviada' })
    expect(h.confirmar).toHaveBeenCalledTimes(1)
    expect(h.confirmar).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: 'ev-1',
      tipo: 'remarcacao',
      conversationId: null,
    })
  })

  it('mudar o horário com a caixa desmarcada: nada sai', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: false,
    })

    expect(h.confirmar).not.toHaveBeenCalled()
  })

  it('ligar o paciente num compromisso que não tinha: é marcação para ele', async () => {
    h.state.results.push([{ ...ANTES_COM_PACIENTE, contactId: null }], AGENDA_LOCAL, [{ id: 'c-1' }])

    await updateEvent('ev-1', {
      ...INPUT,
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(h.confirmar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'marcacao' }))
  })

  describe('trocar de agenda no MESMO horário (01/10, revisão)', () => {
    const ANTES_DRA = { ...ANTES_COM_PACIENTE, calName: 'Dra. Fulana Exemplo' }
    const agendaLocal = (name: string) => [{ googleCalendarId: null, connectionId: null, name }]
    const trocarPara = () =>
      updateEvent('ev-1', {
        ...INPUT,
        startsAt: '2026-10-05T14:00:00.000Z',
        calendarId: 'cal-b',
        contactId: 'c-1',
        notifyPatient: true,
      })

    it('agenda de outro profissional: tipo "profissional", nunca "remarcação"', async () => {
      h.state.results.push([ANTES_DRA], agendaLocal('Dr. Beltrano Teste'), [{ id: 'c-1' }])

      await trocarPara()

      expect(h.confirmar).toHaveBeenCalledTimes(1)
      expect(h.confirmar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'profissional' }))
    })

    it('agenda nova genérica: nada sai (não há o que dizer ao paciente)', async () => {
      h.state.results.push([ANTES_DRA], agendaLocal('Minha agenda'), [{ id: 'c-1' }])

      const res = await trocarPara()

      expect(res.confirmacao).toBeNull()
      expect(h.confirmar).not.toHaveBeenCalled()
    })

    it('o mesmo profissional em outra agenda: nada sai', async () => {
      h.state.results.push([ANTES_DRA], agendaLocal('Agenda da Dra. Fulana Exemplo'), [{ id: 'c-1' }])

      await trocarPara()

      expect(h.confirmar).not.toHaveBeenCalled()
    })

    it('trocou a agenda E o horário: remarcação', async () => {
      h.state.results.push([ANTES_DRA], agendaLocal('Dr. Beltrano Teste'), [{ id: 'c-1' }])

      await updateEvent('ev-1', {
        ...INPUT,
        startsAt: '2026-10-06T17:00:00.000Z',
        endsAt: '2026-10-06T18:00:00.000Z',
        calendarId: 'cal-b',
        contactId: 'c-1',
        notifyPatient: true,
      })

      expect(h.confirmar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'remarcacao' }))
    })
  })

  it('o salvar falhou: nenhuma confirmação sai', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])
    h.state.updateFalha = true

    const res = await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(res.error).toBeTruthy()
    expect(h.confirmar).not.toHaveBeenCalled()
  })
})

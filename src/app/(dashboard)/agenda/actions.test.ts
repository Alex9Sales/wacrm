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
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('trocar o compromisso de agenda', () => {
  it('Google → Google: grava com o vínculo zerado, apaga na antiga e cria na nova', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_GOOGLE)

    const res = await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-b' })

    expect(res).toEqual({ error: null })
    expect(passos()).toEqual(['update', 'google:apagar-na-antiga', 'google:create'])
    expect(gravado()).toMatchObject({ calendarId: 'cal-b', googleEventId: null, source: 'local' })
    // Apaga pela agenda e pelo id que ESTAVAM gravados.
    expect(h.apagar).toHaveBeenCalledWith('acc-1', 'cal-a', 'g-a')
  })

  it('Google → local: só apaga na antiga', async () => {
    h.state.results.push([ANTES_GOOGLE_A], AGENDA_LOCAL)

    await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-local' })

    expect(passos()).toEqual(['update', 'google:apagar-na-antiga'])
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

    expect(res).toEqual({ error: null })
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

    expect(res).toEqual({ id: 'ev-novo', error: null })
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 02/10/2026 — fantasma do evento MOVIDO de agenda no Google. A recepção cria
// no CRM na agenda da dona e depois move, no Google Agenda, para a agenda do
// profissional. Mesmo id; na agenda antiga o evento vira lápide (cancelled,
// início em 1999) que a listagem por janela nunca traz — e a linha antiga
// ficava 'confirmed' para sempre. Ver sync.ts → liberarSumidos.
//
// Banco falso: cada SELECT consome a próxima resposta da fila `selects`; cada
// UPDATE com .returning() consome a próxima de `retornos`. Guarda o `set` e o
// `where` de cada chamada, para conferir O QUE foi gravado e com que trava.
// db.execute é só o now() do banco que o import lê antes de listar cada
// agenda (revisão de 02/10).
//
// Dados fictícios (LGPD): nenhum paciente de verdade aqui.

type Rec = { op: string; set?: Record<string, unknown>; where?: SQL; returning?: boolean }

const h = vi.hoisted(() => {
  const state = { selects: [] as unknown[], retornos: [] as unknown[], calls: [] as Rec[] }
  const chain = (op: string) => {
    const rec: Rec = { op }
    state.calls.push(rec)
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        const valor =
          op === 'select' ? (state.selects.shift() ?? []) : rec.returning ? (state.retornos.shift() ?? []) : undefined
        promise = valor instanceof Error ? Promise.reject(valor) : Promise.resolve(valor)
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
            if (prop === 'set') rec.set = args[0] as Record<string, unknown>
            if (prop === 'where') rec.where = args[0] as SQL
            if (prop === 'returning') rec.returning = true
            return self
          }
        },
      },
    )
    return self
  }
  const db: Record<string, unknown> = {
    select: () => chain('select'),
    insert: () => chain('insert'),
    update: () => chain('update'),
    delete: () => chain('delete'),
  }
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  const agoraNoBanco = vi.fn<(q: unknown) => Promise<{ rows: { agora: string }[] }>>(async () => ({
    rows: [{ agora: '2026-10-02 13:00:00.123456+00' }],
  }))
  db.execute = agoraNoBanco
  return {
    state,
    db,
    agoraNoBanco,
    listGoogleEvents: vi.fn(),
    getGoogleEvent: vi.fn(),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: vi.fn(async () => ({ businessTimezone: 'America/Sao_Paulo' })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token', encrypt: (s: string) => s }))
vi.mock('@/lib/assistant/rules', () => ({ zonedIso: vi.fn() }))
vi.mock('./calendar', () => ({
  refreshAccessToken: vi.fn(),
  listGoogleEvents: h.listGoogleEvents,
  getGoogleEvent: h.getGoogleEvent,
  listCalendarList: vi.fn(async () => []),
  insertGoogleEvent: vi.fn(),
  patchGoogleEvent: vi.fn(),
  deleteGoogleEvent: vi.fn(),
}))

import {
  decidirFantasma,
  importGoogleEvents,
  quaisCandidatas,
  SUMIDOS_POR_AGENDA,
  type LinhaSuspeita,
} from './sync'

const ACC = 'acc-1'
const CONN = 'conn-1'
const CONEXAO = { id: CONN, accessToken: 'x', refreshToken: null, tokenExpiry: '2999-01-01T00:00:00Z' }
const AGENDA_DONA = { id: 'cal-dona', googleCalendarId: 'dona@example.com' }
const AGENDA_PROF = { id: 'cal-prof', googleCalendarId: 'prof@example.com' }

const MIN = 60_000
const agora = () => Date.now()
/** Instante como o Postgres devolve timestamptz (espaço, sem T, "+00"). */
const pg = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00')

const linha = (l: Partial<LinhaSuspeita> = {}): LinhaSuspeita => ({
  id: 'ev-fantasma',
  googleEventId: 'g-movido',
  startsAt: pg(agora() + 2 * 24 * 60 * MIN),
  createdAt: pg(agora() - 3 * 24 * 60 * MIN),
  updatedAt: pg(agora() - 3 * 24 * 60 * MIN),
  contactId: null,
  dealId: null,
  remindersSent: 0,
  ...l,
})

/** Lista do Google falsa: devolve `eventos` e marca `truncated` como mandarem. */
const listagem = (porAgenda: Record<string, { id: string; status?: string }[]>, truncada: string[] = []) =>
  h.listGoogleEvents.mockImplementation(
    async (_tok: string, calId: string, _min: string, _max: string, opts?: { resultado?: { truncated: boolean } }) => {
      if (opts?.resultado) opts.resultado.truncated = truncada.includes(calId)
      return porAgenda[calId] ?? []
    },
  )

const updates = () => h.state.calls.filter((c) => c.op === 'update')
/** Os UPDATEs em calendar_events (tira o carimbo de last_synced_at da conexão). */
const updatesDeEvento = () =>
  updates().filter((c) => !(c.set && ('lastSyncedAt' in c.set || 'lastSyncError' in c.set)))
const cancelamentos = () => updatesDeEvento().filter((c) => c.set?.status === 'cancelled')
const render = (where: SQL | undefined) => new PgDialect().sqlToQuery(where as SQL)

beforeEach(() => {
  h.state.selects = []
  h.state.retornos = []
  h.state.calls = []
  h.listGoogleEvents.mockReset()
  h.getGoogleEvent.mockReset()
  h.agoraNoBanco.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// ------------------------------------------------------------
// Decisões puras
// ------------------------------------------------------------

describe('quaisCandidatas', () => {
  it('o id que veio na listagem (mesmo cancelado) não é suspeito', () => {
    const r = quaisCandidatas([linha({ googleEventId: 'g-listado' }), linha({ id: 'b' })], new Set(['g-listado']), agora())
    expect(r.candidatas.map((l) => l.id)).toEqual(['b'])
  })

  it('linha criada ou mexida há menos de 10 min não é suspeita (push recém-feito)', () => {
    const recente = pg(agora() - 3 * MIN)
    const r = quaisCandidatas(
      [linha({ id: 'criada-agora', createdAt: recente, updatedAt: recente }), linha({ id: 'editada-agora', updatedAt: recente }), linha({ id: 'velha' })],
      new Set(),
      agora(),
    )
    expect(r.candidatas.map((l) => l.id)).toEqual(['velha'])
  })

  it('10 min em ponto já conta; data ilegível conta como recente (na dúvida, não mexe)', () => {
    const t = agora()
    const r = quaisCandidatas(
      [linha({ id: 'dez', createdAt: pg(t - 10 * MIN), updatedAt: pg(t - 10 * MIN) }), linha({ id: 'lixo', updatedAt: 'ontem' })],
      new Set(),
      t,
    )
    expect(r.candidatas.map((l) => l.id)).toEqual(['dez'])
  })

  it('o que vai acontecer vem primeiro, do mais próximo ao mais longe; depois o que já passou', () => {
    const t = agora()
    const r = quaisCandidatas(
      [
        linha({ id: 'passou', startsAt: pg(t - 2 * 24 * 60 * MIN) }),
        linha({ id: 'semana-que-vem', startsAt: pg(t + 7 * 24 * 60 * MIN) }),
        linha({ id: 'amanha', startsAt: pg(t + 24 * 60 * MIN) }),
      ],
      new Set(),
      t,
    )
    expect(r.candidatas.map((l) => l.id)).toEqual(['amanha', 'semana-que-vem', 'passou'])
  })

  it(`no máximo ${SUMIDOS_POR_AGENDA} por agenda; o resto vai para o log`, () => {
    const muitas = Array.from({ length: SUMIDOS_POR_AGENDA + 7 }, (_, i) => linha({ id: `l${i}`, googleEventId: `g${i}` }))
    const r = quaisCandidatas(muitas, new Set(), agora())
    expect(r.candidatas).toHaveLength(SUMIDOS_POR_AGENDA)
    expect(r.sobraram).toBe(7)
  })
})

describe('decidirFantasma', () => {
  it('só 404/410 (gone) e a lápide cancelled cancelam', () => {
    expect(decidirFantasma({ status: 'gone' })).toBe('cancelar')
    expect(decidirFantasma({ status: 'cancelled' })).toBe('cancelar')
  })

  it('evento vivo fica — inclusive o que mudou de data para fora da janela', () => {
    expect(decidirFantasma({ status: 'confirmed' })).toBe('manter')
    expect(decidirFantasma({ status: 'tentative' })).toBe('manter')
    expect(decidirFantasma({})).toBe('manter')
  })
})

// ------------------------------------------------------------
// A varredura dentro do import
// ------------------------------------------------------------

/** Fila do banco do import: conexão e agendas. As linhas da varredura vêm depois. */
const inicio = (agendas = [AGENDA_DONA]) => h.state.selects.push([CONEXAO], agendas)

describe('importGoogleEvents → varredura de sumidos', () => {
  it('listagem TRUNCADA não varre: nem lê as linhas, nem pergunta ao Google', async () => {
    inicio()
    listagem({}, [AGENDA_DONA.googleCalendarId])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r).toEqual({ imported: 0, cancelled: 0 })
    expect(h.state.calls.filter((c) => c.op === 'select')).toHaveLength(2) // conexão e agendas
    expect(h.getGoogleEvent).not.toHaveBeenCalled()
    expect(cancelamentos()).toHaveLength(0)
  })

  it('GET 404 → cancela a linha, com as travas de candidata repetidas no UPDATE', async () => {
    inicio()
    listagem({})
    h.state.selects.push([linha()], []) // candidatas; gêmeos: nenhum
    h.getGoogleEvent.mockResolvedValue({ status: 'gone' })
    h.state.retornos.push([{ id: 'ev-fantasma' }])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(1)
    expect(h.getGoogleEvent).toHaveBeenCalledWith('token', AGENDA_DONA.googleCalendarId, 'g-movido')
    const [cancel] = cancelamentos()
    const q = render(cancel.where)
    // Só a linha certa, desta conta e agenda, ainda confirmada e intocada há 10 min.
    expect(q.params).toEqual(['ev-fantasma', ACC, AGENDA_DONA.id, 'g-movido', 'confirmed'])
    expect(q.sql).toContain(`"calendar_events"."updated_at" < now() - interval '600 seconds'`)
    expect(q.sql).toContain(`"calendar_events"."created_at" < now() - interval '600 seconds'`)
    // Sem paciente, negócio ou lembrete na fantasma: nada a passar ao gêmeo.
    expect(updatesDeEvento()).toHaveLength(1)
  })

  it('GET 200 cancelled (lápide do evento movido) → cancela e passa lembrete, paciente e negócio ao gêmeo', async () => {
    inicio()
    listagem({})
    const fantasma = linha({ contactId: 'c-ana', dealId: 'd-1', remindersSent: 1 })
    h.state.selects.push([fantasma], [{ id: 'ev-gemeo' }])
    h.getGoogleEvent.mockResolvedValue({
      id: 'g-movido',
      status: 'cancelled',
      start: { dateTime: '1999-12-31T22:00:00-02:00' },
      organizer: { email: AGENDA_PROF.googleCalendarId },
    })
    // O RETURNING do cancelamento (aqui igual à leitura da varredura).
    h.state.retornos.push([
      { id: 'ev-fantasma', contactId: 'c-ana', dealId: 'd-1', remindersSent: 1, startsAt: fantasma.startsAt },
    ])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(1)
    // A procura do gêmeo: mesma conta, mesmo id do Google, OUTRA agenda, confirmado.
    const busca = h.state.calls.filter((c) => c.op === 'select').at(-1)
    expect(render(busca?.where).params).toEqual([ACC, 'g-movido', AGENDA_DONA.id, 'confirmed'])
    expect(console.warn).not.toHaveBeenCalled()
    const sets = updatesDeEvento().map((c) => Object.keys(c.set ?? {}))
    // Ordem importa: o degrau é carimbado ANTES de o paciente chegar ao gêmeo.
    expect(sets).toEqual([['status', 'updatedAt'], ['remindersSent'], ['contactId'], ['dealId']])

    const [, lembrete, paciente, negocio] = updatesDeEvento()
    // Gêmeo = mesma conta, mesmo id do Google, OUTRA agenda, confirmado…
    const gemeo = [ACC, 'g-movido', AGENDA_DONA.id, 'confirmed']
    // …e, para o lembrete, no MESMO instante, atrás no contador, sem paciente ou com o MESMO.
    const ql = render(lembrete.where)
    expect(ql.params).toEqual([...gemeo, fantasma.startsAt, 1, 'c-ana'])
    expect(ql.sql).toContain('"calendar_events"."calendar_id" <> $3')
    expect(ql.sql).toContain('"calendar_events"."contact_id" is null')
    expect(render(lembrete.set?.remindersSent as SQL).sql).toContain('GREATEST(')
    // Paciente e negócio: só onde está VAZIO no gêmeo.
    expect(paciente.set).toEqual({ contactId: 'c-ana' })
    expect(render(paciente.where).sql).toContain('"calendar_events"."contact_id" is null')
    expect(negocio.set).toEqual({ dealId: 'd-1' })
    expect(render(negocio.where).sql).toContain('"calendar_events"."deal_id" is null')
  })

  it('movido para agenda que o CRM não vê (sem gêmeo): cancela, não passa nada e avisa no log', async () => {
    inicio()
    listagem({})
    h.state.selects.push([linha({ contactId: 'c-ana', remindersSent: 1 })], [])
    h.getGoogleEvent.mockResolvedValue({
      id: 'g-movido',
      status: 'cancelled',
      organizer: { email: 'invisivel@group.calendar.google.com' },
    })
    h.state.retornos.push([{ id: 'ev-fantasma' }])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(1)
    expect(updatesDeEvento()).toHaveLength(1) // só o cancelamento
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invisivel@group.calendar.google.com'))
  })

  it('GET 200 confirmado → não mexe (o evento só mudou de data para fora da janela)', async () => {
    inicio()
    listagem({})
    h.state.selects.push([linha({ contactId: 'c-ana' })])
    h.getGoogleEvent.mockResolvedValue({ id: 'g-movido', status: 'confirmed', start: { dateTime: '2027-03-01T10:00:00Z' } })

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(0)
    expect(updatesDeEvento()).toHaveLength(0)
  })

  it('erro no GET → pula aquela linha e segue com as outras da agenda', async () => {
    inicio()
    listagem({})
    h.state.selects.push([linha({ id: 'a', googleEventId: 'g-a' }), linha({ id: 'b', googleEventId: 'g-b' })])
    h.getGoogleEvent
      .mockRejectedValueOnce(new Error('Google get event (500): backendError'))
      .mockResolvedValueOnce({ status: 'gone' })
    h.state.retornos.push([{ id: 'b' }])
    h.state.selects.push([]) // gêmeos de 'b': nenhum

    const r = await importGoogleEvents(ACC, CONN)

    expect(h.getGoogleEvent).toHaveBeenCalledTimes(2)
    expect(r.cancelled).toBe(1)
    expect(cancelamentos()).toHaveLength(1)
    expect(render(cancelamentos()[0].where).params[0]).toBe('b')
    // A falha não vira erro da conexão ("reconecte o Google").
    const conexao = updates().find((c) => c.set && 'lastSyncedAt' in c.set)
    expect(conexao?.set?.lastSyncError).toBeNull()
  })

  it('linha recente (< 10 min) e id que veio na listagem como cancelado: nenhuma pergunta ao Google', async () => {
    inicio()
    listagem({ [AGENDA_DONA.googleCalendarId]: [{ id: 'g-apagado', status: 'cancelled' }] })
    h.state.retornos.push([]) // o cancelamento normal do import (já não havia linha confirmada)
    const recente = pg(agora() - 2 * MIN)
    h.state.selects.push([
      linha({ id: 'recem-criada', googleEventId: 'g-novo', createdAt: recente, updatedAt: recente }),
      linha({ id: 'listada', googleEventId: 'g-apagado' }),
    ])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(0)
    expect(h.getGoogleEvent).not.toHaveBeenCalled()
  })

  it('o UPDATE não pegou nada (recepção editou agora / outra rodada já cancelou): não conta nem passa ao gêmeo', async () => {
    inicio()
    listagem({})
    h.state.selects.push([linha({ contactId: 'c-ana', remindersSent: 2 })])
    h.getGoogleEvent.mockResolvedValue({ status: 'gone' })
    h.state.retornos.push([])

    const r = await importGoogleEvents(ACC, CONN)

    expect(r.cancelled).toBe(0)
    expect(updatesDeEvento()).toHaveLength(1) // só a tentativa de cancelar
  })

  it('varre DEPOIS de importar todas as agendas (o gêmeo da agenda nova já existe)', async () => {
    inicio([AGENDA_DONA, AGENDA_PROF])
    listagem({})
    h.state.selects.push([linha()], [{ id: 'ev-gemeo' }], []) // candidatas da dona; gêmeo; candidatas do profissional
    h.getGoogleEvent.mockResolvedValue({ status: 'cancelled' })
    h.state.retornos.push([{ id: 'ev-fantasma' }])

    await importGoogleEvents(ACC, CONN)

    const ultimaListagem = Math.max(...h.listGoogleEvents.mock.invocationCallOrder)
    const primeiraPergunta = Math.min(...h.getGoogleEvent.mock.invocationCallOrder)
    expect(h.listGoogleEvents).toHaveBeenCalledTimes(2)
    expect(ultimaListagem).toBeLessThan(primeiraPergunta)
  })

  it('o que passa ao gêmeo é o RETURNING do cancelamento, não a leitura de antes das perguntas ao Google (revisão de 02/10)', async () => {
    inicio()
    listagem({})
    // Lida pela varredura sem paciente e sem lembrete…
    const lida = linha({ contactId: null, dealId: null, remindersSent: 0 })
    h.state.selects.push([lida], [{ id: 'ev-gemeo' }])
    h.getGoogleEvent.mockResolvedValue({ status: 'cancelled' })
    // …mas, enquanto o Google respondia, o lembrete saiu e a recepção ligou o paciente.
    const naHora = { id: 'ev-fantasma', contactId: 'c-bia', dealId: 'd-2', remindersSent: 2, startsAt: lida.startsAt }
    h.state.retornos.push([naHora])

    await importGoogleEvents(ACC, CONN)

    const [cancel, lembrete, paciente, negocio] = updatesDeEvento()
    expect(cancel.returning).toBe(true)
    expect(render(lembrete.where).params).toEqual([ACC, 'g-movido', AGENDA_DONA.id, 'confirmed', lida.startsAt, 2, 'c-bia'])
    expect(render(lembrete.set?.remindersSent as SQL).params).toEqual([2])
    expect(paciente.set).toEqual({ contactId: 'c-bia' })
    expect(negocio.set).toEqual({ dealId: 'd-2' })
  })
})

describe('importGoogleEvents → não desfaz o salvar feito no CRM durante a importação (revisão de 02/10)', () => {
  const EV_GOOGLE = {
    id: 'g-1',
    status: 'confirmed',
    summary: 'Consulta Exemplo',
    start: { dateTime: '2026-10-05T13:00:00Z' },
    end: { dateTime: '2026-10-05T14:00:00Z' },
  }

  it('pega o now() do BANCO antes de listar e só atualiza a linha que ninguém mexeu desde então', async () => {
    inicio()
    listagem({ [AGENDA_DONA.googleCalendarId]: [EV_GOOGLE] })
    // A linha que já existe (o horário dela no CRM é outro: o recomeço do lembrete continua valendo).
    h.state.selects.push([{ id: 'ev-1', startsAt: '2026-10-05 12:00:00+00' }])

    await importGoogleEvents(ACC, CONN)

    expect(h.agoraNoBanco).toHaveBeenCalledTimes(1)
    expect(render(h.agoraNoBanco.mock.calls[0]?.[0] as SQL).sql).toBe('SELECT now()::text AS agora')
    expect(h.agoraNoBanco.mock.invocationCallOrder[0]).toBeLessThan(h.listGoogleEvents.mock.invocationCallOrder[0])
    const doEvento = updatesDeEvento().find((c) => c.set && 'title' in c.set)
    const q = render(doEvento?.where)
    expect(q.params).toEqual(['ev-1', '2026-10-02 13:00:00.123456+00'])
    expect(q.sql).toContain('"calendar_events"."updated_at" < $2')
    expect(doEvento?.set).toMatchObject({
      startsAt: '2026-10-05T13:00:00.000Z',
      status: 'confirmed',
      remindersSent: 0,
    })
  })

  it('um now() por agenda: cada listagem é uma foto do seu instante', async () => {
    inicio([AGENDA_DONA, AGENDA_PROF])
    listagem({})

    await importGoogleEvents(ACC, CONN)

    expect(h.agoraNoBanco).toHaveBeenCalledTimes(2)
    const [a1, a2] = h.agoraNoBanco.mock.invocationCallOrder
    const [l1, l2] = h.listGoogleEvents.mock.invocationCallOrder
    expect(a1).toBeLessThan(l1)
    expect(l1).toBeLessThan(a2)
    expect(a2).toBeLessThan(l2)
  })
})

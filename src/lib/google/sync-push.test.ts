import { beforeEach, describe, expect, it, vi } from 'vitest'

// 01/10 — revisão do "paciente vai junto para o Google". Banco falso: cada
// SELECT consome a próxima resposta da fila, na ordem em que o push consulta
// (evento+agenda, conexão, contato). O SQL não é testado — aqui interessa o que
// CHEGA ao Google: o corpo do insert/patch.
//
// Dados fictícios (LGPD): nenhum paciente de verdade aqui.

type Rec = { op: string; set?: unknown }

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[], calls: [] as Rec[] }
  const THROW = Symbol('throw')
  const chain = (op: string) => {
    const rec: Rec = { op }
    state.calls.push(rec)
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        const next = op === 'select' ? state.results.shift() : undefined
        promise =
          next && typeof next === 'object' && THROW in (next as object)
            ? Promise.reject((next as Record<symbol, unknown>)[THROW])
            : Promise.resolve(op === 'select' ? (next ?? []) : undefined)
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
    fail: (err: Error) => ({ [THROW]: err }),
    getAccountSettings: vi.fn(),
    insertGoogleEvent: vi.fn(),
    patchGoogleEvent: vi.fn(),
    deleteGoogleEvent: vi.fn(),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: h.getAccountSettings }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token', encrypt: (s: string) => s }))
vi.mock('@/lib/assistant/rules', () => ({ zonedIso: vi.fn() }))
vi.mock('./calendar', () => ({
  refreshAccessToken: vi.fn(),
  listGoogleEvents: vi.fn(),
  listCalendarList: vi.fn(),
  insertGoogleEvent: h.insertGoogleEvent,
  patchGoogleEvent: h.patchGoogleEvent,
  deleteGoogleEvent: h.deleteGoogleEvent,
}))

import { MARCADOR_FLUXIA } from './event-patient'
import { apagarEventoNoGoogle, pushEventToGoogle } from './sync'

const ACC = 'acc-1'
const EV = 'ev-1'
const ANA = { name: 'Ana Teste', phone: '5511912345678', isGroup: false }
const blocoAna = `${MARCADOR_FLUXIA}\nPaciente: Ana Teste\nTelefone: (11) 91234-5678`

type Linha = {
  title?: string
  description?: string | null
  location?: string | null
  googleEventId?: string | null
  contactId?: string | null
}
const evento = (l: Linha = {}) => ({
  id: EV,
  title: l.title ?? 'RSC',
  description: l.description ?? null,
  location: l.location ?? null,
  startsAt: '2026-10-05 14:00:00+00',
  endsAt: '2026-10-05 15:00:00+00',
  allDay: false,
  googleEventId: l.googleEventId ?? null,
  contactId: l.contactId ?? null,
  calGoogleId: 'agenda@group.calendar.google.com',
  connectionId: 'conn-1',
})
const CONEXAO = { id: 'conn-1', accessToken: 'x', refreshToken: null, tokenExpiry: '2999-01-01T00:00:00Z' }

/** Fila do banco: evento+agenda, conexão e (se vier) o contato. */
const fila = (ev: ReturnType<typeof evento>, contato?: unknown) => {
  h.state.results.push([ev], [CONEXAO])
  if (contato !== undefined) h.state.results.push(contato)
}
const corpoDoInsert = () => h.insertGoogleEvent.mock.calls.at(-1)?.[2]
const corpoDoPatch = () => h.patchGoogleEvent.mock.calls.at(-1)?.[3]
const selects = () => h.state.calls.filter((c) => c.op === 'select').length

const comOpcao = (googlePatientInfo: unknown) =>
  h.getAccountSettings.mockResolvedValue({ businessTimezone: 'America/Sao_Paulo', googlePatientInfo })

beforeEach(() => {
  h.state.results = []
  h.state.calls = []
  h.getAccountSettings.mockReset()
  h.insertGoogleEvent.mockReset().mockResolvedValue({ id: 'g-1' })
  h.patchGoogleEvent.mockReset().mockResolvedValue(undefined)
  h.deleteGoogleEvent.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('conta que NÃO optou (padrão)', () => {
  it('nada do paciente vai — o contato nem é lido', async () => {
    comOpcao(undefined)
    fila(evento({ contactId: 'c-1', description: 'rsc' }))

    await pushEventToGoogle(ACC, EV, 'create')

    expect(corpoDoInsert()).toMatchObject({ summary: 'RSC', description: 'rsc' })
    expect(selects()).toBe(2) // evento e conexão; contato, não
  })

  it('mesmo com "true" em texto no jsonb', async () => {
    comOpcao('true')
    fila(evento({ contactId: 'c-1' }))

    await pushEventToGoogle(ACC, EV, 'create')

    expect(corpoDoInsert()?.description).toBeUndefined()
    expect(selects()).toBe(2)
  })
})

describe('conta que optou (googlePatientInfo = true)', () => {
  it('criar com paciente: bloco no fim da descrição, título como foi digitado', async () => {
    comOpcao(true)
    fila(evento({ contactId: 'c-1', description: 'levar exames' }), [ANA])

    await pushEventToGoogle(ACC, EV, 'create')

    expect(corpoDoInsert()).toMatchObject({ summary: 'RSC', description: `levar exames\n\n${blocoAna}` })
  })

  it('criar com paciente → desligar com descrição null: o PATCH leva a descrição SEM o bloco', async () => {
    comOpcao(true)
    fila(evento({ contactId: 'c-1' }), [ANA])
    await pushEventToGoogle(ACC, EV, 'create')
    expect(corpoDoInsert()?.description).toBe(blocoAna)

    // A recepção desliga a paciente e deixa a descrição vazia (o CRM grava null).
    fila(evento({ contactId: null, description: null, googleEventId: 'g-1' }))
    await pushEventToGoogle(ACC, EV, 'update')

    const corpo = corpoDoPatch()
    expect(corpo?.description).toBe('')
    // Vai no JSON — `undefined` some no JSON.stringify e o Google mantinha o bloco.
    expect(JSON.parse(JSON.stringify(corpo))).toHaveProperty('description', '')
    expect(corpo?.summary).toBe('RSC')
  })

  it('desligar depois que o bloco voltou pelo import: o bloco sai', async () => {
    comOpcao(true)
    fila(evento({ contactId: null, description: `levar exames\n\n${blocoAna}`, googleEventId: 'g-1' }))

    await pushEventToGoogle(ACC, EV, 'update')

    expect(corpoDoPatch()?.description).toBe('levar exames')
  })

  it('criar com convidados: nenhum dado do paciente vai no convite', async () => {
    comOpcao(true)
    fila(evento({ contactId: 'c-1' }))

    await pushEventToGoogle(ACC, EV, 'create', { meet: true, attendees: ['lead@example.com'] })

    const corpo = corpoDoInsert()
    expect(corpo?.description).toBeUndefined()
    expect(corpo?.attendees).toEqual([{ email: 'lead@example.com' }])
    expect(selects()).toBe(2) // o contato nem é lido
  })

  it('editar reunião (sala do Meet no local): sem paciente, e o bloco antigo sai', async () => {
    comOpcao(true)
    fila(
      evento({
        contactId: 'c-1',
        location: 'https://meet.google.com/abc-defg-hij',
        description: `pauta\n\n${blocoAna}`,
        googleEventId: 'g-1',
      }),
    )

    await pushEventToGoogle(ACC, EV, 'update')

    expect(corpoDoPatch()?.description).toBe('pauta')
    expect(selects()).toBe(2)
  })

  it('contato de grupo: nenhum bloco', async () => {
    comOpcao(true)
    fila(evento({ contactId: 'c-grupo', description: 'rsc' }), [
      { name: 'Grupo da Família', phone: '120363000000000000', isGroup: true },
    ])

    await pushEventToGoogle(ACC, EV, 'create')

    expect(corpoDoInsert()?.description).toBe('rsc')
  })

  it('falha ao ler o contato: a descrição vai como estava (nada é apagado no Google)', async () => {
    comOpcao(true)
    fila(evento({ contactId: 'c-1', description: null, googleEventId: 'g-1' }), h.fail(new Error('connection terminated')))

    await pushEventToGoogle(ACC, EV, 'update')

    expect(corpoDoPatch()?.description).toBeUndefined()
  })
})

describe('edição em qualquer conta', () => {
  it('a descrição vai SEMPRE — vazia no CRM é vazia no Google', async () => {
    comOpcao(false)
    fila(evento({ description: null, googleEventId: 'g-1' }))

    await pushEventToGoogle(ACC, EV, 'update')

    expect(corpoDoPatch()?.description).toBe('')
  })
})

describe('apagar o evento que ficou na agenda antiga (trocar de agenda)', () => {
  it('apaga pelo id do Google na agenda antiga, com o token da conexão dela', async () => {
    h.state.results.push([{ calGoogleId: 'antiga@group.calendar.google.com', connectionId: 'conn-1' }], [CONEXAO])

    await apagarEventoNoGoogle(ACC, 'cal-antiga', 'g-antigo')

    expect(h.deleteGoogleEvent).toHaveBeenCalledWith('token', 'antiga@group.calendar.google.com', 'g-antigo')
  })

  it('agenda local, de outra conta ou sem conexão desta conta: nada', async () => {
    h.state.results.push([]) // a agenda não é desta conta
    await apagarEventoNoGoogle(ACC, 'cal-x', 'g-x')
    h.state.results.push([{ calGoogleId: null, connectionId: null }]) // agenda local
    await apagarEventoNoGoogle(ACC, 'cal-local', 'g-x')
    h.state.results.push([{ calGoogleId: 'a@group.calendar.google.com', connectionId: 'conn-x' }], []) // conexão de outra conta
    await apagarEventoNoGoogle(ACC, 'cal-a', 'g-x')

    expect(h.deleteGoogleEvent).not.toHaveBeenCalled()
  })
})

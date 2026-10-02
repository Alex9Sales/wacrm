import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    // Confirmação ao paciente (01/10; fila desde 02/10): a fila de verdade é
    // testada em lib/agenda/confirmacao-fila.test.ts e o envio em
    // confirmacao-envio.test.ts; aqui importa QUANDO a action põe ou tira da
    // fila, e com que "antes".
    agendar: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => {
      state.calls.push({ op: 'confirmacao' })
      return { agendada: '2026-10-02T13:08:00.000Z' }
    }),
    descartar: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => {
      state.calls.push({ op: 'descarte' })
      return { descartada: true }
    }),
    // Edição salva sem a caixa (revisão de 02/10): a conferência no banco é
    // testada em confirmacao-fila.test.ts; aqui, QUANDO a action chama. Não
    // entra em `passos()` para não mudar a ordem conferida nos outros testes.
    conferir: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => null),
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
vi.mock('@/lib/agenda/confirmacao-fila', () => ({
  agendarConfirmacao: h.agendar,
  descartarConfirmacaoPendente: h.descartar,
  conferirEdicaoSemCaixa: h.conferir,
}))

import { createEvent, estadoDaConfirmacao, listarConsultasFuturasDoContato, updateEvent } from './actions'
import { ERRO_REMARCACAO_INDISPONIVEL } from '@/lib/agenda/remarcacao'

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
  h.agendar.mockClear()
  h.descartar.mockClear()
  h.conferir.mockReset()
  h.conferir.mockImplementation(async () => null)
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

describe('confirmação ao paciente ao salvar — vai para a FILA (01/10; fila desde 02/10)', () => {
  // O compromisso como estava: com paciente, na agenda local.
  const ANTES_COM_PACIENTE = {
    startsAt: '2026-10-05 14:00:00+00',
    calendarId: 'cal-a',
    contactId: 'c-1',
    googleEventId: null,
    calGoogleId: null,
    connectionId: null,
  }

  it('criar com paciente e a caixa marcada: põe UMA na fila (consulta nova: sem "antes"), depois de gravar e antes do Google', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({
      ...INPUT,
      calendarId: 'cal-b',
      contactId: 'c-1',
      notifyPatient: true,
      conversationId: 'cv-1',
    })

    // Nada sai no salvar: a tela diz quando sai.
    expect(res).toEqual({ id: 'ev-novo', error: null, confirmacao: { agendada: '2026-10-02T13:08:00.000Z' } })
    expect(h.agendar).toHaveBeenCalledTimes(1)
    expect(h.agendar).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: 'ev-novo',
      antes: null,
      conversationId: 'cv-1',
    })
    expect(h.descartar).not.toHaveBeenCalled()
    // Gravado no CRM primeiro; a fila ANTES do espelho no Google: a varredura
    // de lembretes pula o compromisso com confirmação pendente.
    expect(passos()).toEqual(['insert', 'confirmacao', 'google:create'])
  })

  it('criar com a caixa desmarcada NA TELA: tira da fila (e a recepção fica sabendo se havia algo)', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    await createEvent({
      ...INPUT,
      calendarId: 'cal-b',
      contactId: 'c-1',
      notifyPatient: false,
      descartarConfirmacaoPendente: true,
    })

    expect(h.agendar).not.toHaveBeenCalled()
    expect(h.descartar).toHaveBeenCalledWith({ accountId: 'acc-1', eventId: 'ev-novo' })
  })

  it('criar sem a caixa na tela: nem põe nem tira da fila', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'c-1' })

    expect(res.confirmacao).toBeNull()
    expect(h.agendar).not.toHaveBeenCalled()
    expect(h.descartar).not.toHaveBeenCalled()
    // Compromisso novo: não há o que o paciente "já sabia" para conferir.
    expect(h.conferir).not.toHaveBeenCalled()
  })

  it('criar sem paciente: nada vai para a fila, mesmo com a caixa', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'ev-novo' }])

    await createEvent({ ...INPUT, calendarId: 'cal-b', notifyPatient: true })

    expect(h.agendar).not.toHaveBeenCalled()
  })

  it('a fila falhou (até lançou): o compromisso fica salvo e o aviso volta para a tela', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])
    h.agendar.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })

    const res = await createEvent({ ...INPUT, calendarId: 'cal-b', contactId: 'c-1', notifyPatient: true })

    expect(res.id).toBe('ev-novo')
    expect(res.error).toBeNull()
    expect(res.confirmacao).toEqual({ naoEnviada: 'não foi possível agendar a confirmação agora' })
    expect(passos()).toContain('insert')
    expect(passos()).toContain('google:create')
  })

  it('editar com a caixa marcada: a fila recebe como o compromisso estava ANTES do salvar (quem decide o tipo é ela)', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    const res = await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      endsAt: '2026-10-06T18:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(res).toEqual({ error: null, confirmacao: { agendada: '2026-10-02T13:08:00.000Z' } })
    expect(h.agendar).toHaveBeenCalledTimes(1)
    expect(h.agendar).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: 'ev-1',
      antes: { startsAt: '2026-10-05 14:00:00+00', calendarId: 'cal-a', contactId: 'c-1' },
      conversationId: null,
    })
    // Depois de gravar; antes do Google.
    expect(passos()).toEqual(['update', 'confirmacao', 'google:update'])
  })

  it('trocar de agenda: o "antes" leva a agenda ANTIGA (a fila compara os profissionais)', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-05T14:00:00.000Z',
      calendarId: 'cal-b',
      contactId: 'c-1',
      notifyPatient: true,
    })

    expect(h.agendar).toHaveBeenCalledWith(
      expect.objectContaining({ antes: { startsAt: '2026-10-05 14:00:00+00', calendarId: 'cal-a', contactId: 'c-1' } }),
    )
  })

  it('ligar o paciente num compromisso que não tinha: o "antes" vai sem paciente (marcação para ele)', async () => {
    h.state.results.push([{ ...ANTES_COM_PACIENTE, contactId: null }], AGENDA_LOCAL, [{ id: 'c-1' }])

    await updateEvent('ev-1', { ...INPUT, calendarId: 'cal-a', contactId: 'c-1', notifyPatient: true })

    expect(h.agendar).toHaveBeenCalledWith(expect.objectContaining({ antes: expect.objectContaining({ contactId: null }) }))
  })

  it('editar só o título (a caixa nem aparece): não põe nem tira — só pede ao servidor que confira no banco', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    const res = await updateEvent('ev-1', {
      ...INPUT,
      title: 'Outro título',
      startsAt: '2026-10-05T14:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: false,
    })

    expect(res).toEqual({ error: null, confirmacao: null })
    expect(h.agendar).not.toHaveBeenCalled()
    expect(h.descartar).not.toHaveBeenCalled()
    // A conferência recebe como o compromisso estava ANTES (revisão de 02/10).
    expect(h.conferir).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: 'ev-1',
      antes: { startsAt: '2026-10-05 14:00:00+00', calendarId: 'cal-a', contactId: 'c-1' },
      conversationId: null,
    })
  })

  it('edição sem a caixa com a grade velha: o que a conferência põe na fila volta para a tela, depois de gravar e antes do Google', async () => {
    // Salvou 10h→11h, o worker mandou "remarcada para 11h"; a grade velha não
    // mostrou a caixa quando a recepção voltou para 10h.
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])
    h.conferir.mockImplementationOnce(async () => {
      h.state.calls.push({ op: 'conferencia' })
      return { agendada: '2026-10-02T13:08:00.000Z', semCaixa: true }
    })

    const res = await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-05T13:00:00.000Z',
      endsAt: '2026-10-05T14:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
    })

    expect(res).toEqual({ error: null, confirmacao: { agendada: '2026-10-02T13:08:00.000Z', semCaixa: true } })
    // Como a caixa: depois de gravar; antes do Google (a varredura de
    // lembretes pula o compromisso com confirmação pendente).
    expect(passos()).toEqual(['update', 'conferencia', 'google:update'])
  })

  it('caixa NA TELA e desmarcada: descarta e NÃO confere (a recepção decidiu não avisar)', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: false,
      descartarConfirmacaoPendente: true,
    })

    expect(h.descartar).toHaveBeenCalledTimes(1)
    expect(h.conferir).not.toHaveBeenCalled()
  })

  it('mudar o horário com a caixa DESMARCADA na tela: tira da fila, não põe', async () => {
    h.state.results.push([ANTES_COM_PACIENTE], AGENDA_LOCAL, [{ id: 'c-1' }])

    const res = await updateEvent('ev-1', {
      ...INPUT,
      startsAt: '2026-10-06T17:00:00.000Z',
      calendarId: 'cal-a',
      contactId: 'c-1',
      notifyPatient: false,
      descartarConfirmacaoPendente: true,
    })

    expect(res.confirmacao).toEqual({ descartada: true })
    expect(h.agendar).not.toHaveBeenCalled()
    expect(h.descartar).toHaveBeenCalledWith({ accountId: 'acc-1', eventId: 'ev-1' })
  })

  it('o salvar falhou: nada vai para a fila nem sai dela', async () => {
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
    expect(h.agendar).not.toHaveBeenCalled()
    expect(h.descartar).not.toHaveBeenCalled()
  })
})

describe('remarcação no modal de compromisso NOVO (02/10)', () => {
  // A recepção marca para quem já tem consulta futura e responde "é a
  // remarcação da consulta X": nada é criado, X é editada pelo caminho do
  // updateEvent. O servidor confere X antes de gravar qualquer coisa.
  const X = '11111111-1111-4111-8111-111111111111'
  // "Agora" é 02/10 12:00Z; X é dia 13, a remarcação vai para o dia 14.
  const X_DE_PE = {
    status: 'confirmed',
    contactId: 'c-1',
    startsAt: '2026-10-13 12:30:00+00',
    endsAt: '2026-10-13 13:30:00+00',
    allDay: false,
  }
  // Como X estava, lida pelo updateEvent (o "antes" da edição).
  const ANTES_X = {
    startsAt: '2026-10-13 12:30:00+00',
    calendarId: 'cal-a',
    contactId: 'c-1',
    googleEventId: 'g-x',
    calGoogleId: 'a@group.calendar.google.com',
    connectionId: 'conn-1',
  }
  const NOVA = {
    title: 'Retorno · Davi',
    startsAt: '2026-10-14T12:00:00.000Z',
    endsAt: '2026-10-14T13:00:00.000Z',
    contactId: 'c-1',
    location: 'Sala 2',
    description: 'Trazer exames',
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('X válida: edita X com o formulário (não insere) e devolve o id dela', async () => {
    h.state.results.push(
      [X_DE_PE], // a conferência de X
      [ANTES_X], // updateEvent: como X estava
      [{ googleCalendarId: 'a@group.calendar.google.com', connectionId: 'conn-1' }], // mesma agenda
      [{ id: 'c-1' }], // o paciente é da conta
    )

    const res = await createEvent({ ...NOVA, calendarId: 'cal-a', remarcaEventoId: X, tituloDigitado: true })

    expect(res).toEqual({ id: X, error: null, confirmacao: null })
    expect(passos()).toEqual(['update', 'google:update'])
    expect(passos()).not.toContain('insert')
    expect(gravado()).toMatchObject({
      title: 'Retorno · Davi',
      startsAt: '2026-10-14T12:00:00.000Z',
      endsAt: '2026-10-14T13:00:00.000Z',
      location: 'Sala 2',
      description: 'Trazer exames',
      // Data nova: os lembretes recomeçam do zero.
      remindersSent: 0,
    })
    expect(h.push).toHaveBeenCalledWith('acc-1', X, 'update')
  })

  it('revisão de 02/10: título auto-preenchido (nome da mãe) e campos em branco NÃO apagam o que X tinha', async () => {
    // O modal põe o nome do contato no título vazio; descrição e local nascem
    // em branco. Antes isso ia inteiro para X: o título "Avaliação · Davi"
    // virava "Rosana Moura" e a observação de X sumia.
    h.state.results.push([X_DE_PE], [ANTES_X], [{ googleCalendarId: 'a@group.calendar.google.com', connectionId: 'conn-1' }], [{ id: 'c-1' }])

    const res = await createEvent({
      ...NOVA,
      title: 'Rosana Moura',
      location: '',
      description: '',
      calendarId: 'cal-a',
      remarcaEventoId: X,
      tituloDigitado: false,
    })

    expect(res.id).toBe(X)
    const set = gravado()!
    expect(set).not.toHaveProperty('title')
    expect(set).not.toHaveProperty('description')
    expect(set).not.toHaveProperty('location')
    expect(set).toMatchObject({ startsAt: '2026-10-14T12:00:00.000Z', endsAt: '2026-10-14T13:00:00.000Z', contactId: 'c-1' })
  })

  it('X válida em outra agenda: troca de agenda pelo caminho da edição (apaga na antiga, cria na nova)', async () => {
    h.state.results.push([X_DE_PE], [ANTES_X], AGENDA_GOOGLE, [{ id: 'c-1' }])

    const res = await createEvent({ ...NOVA, calendarId: 'cal-b', remarcaEventoId: X })

    expect(res.id).toBe(X)
    expect(passos()).toEqual(['update', 'google:apagar-na-antiga', 'update', 'google:create'])
    expect(gravado()).toMatchObject({ calendarId: 'cal-b', googleEventId: null })
    expect(h.apagar).toHaveBeenCalledWith('acc-1', 'cal-a', 'g-x')
  })

  it('X válida com a caixa marcada: a fila recebe X com o "antes" dela (sai como remarcada)', async () => {
    h.state.results.push([X_DE_PE], [ANTES_X], AGENDA_GOOGLE, [{ id: 'c-1' }])

    const res = await createEvent({
      ...NOVA,
      calendarId: 'cal-a',
      remarcaEventoId: X,
      notifyPatient: true,
      conversationId: 'cv-1',
    })

    expect(res).toEqual({ id: X, error: null, confirmacao: { agendada: '2026-10-02T13:08:00.000Z' } })
    expect(h.agendar).toHaveBeenCalledWith({
      accountId: 'acc-1',
      eventId: X,
      antes: { startsAt: '2026-10-13 12:30:00+00', calendarId: 'cal-a', contactId: 'c-1' },
      conversationId: 'cv-1',
    })
    expect(passos()).toEqual(['update', 'confirmacao', 'google:update'])
  })

  it.each([
    ['de outro paciente', [{ ...X_DE_PE, contactId: 'c-2' }]],
    ['de outra conta (não achou)', []],
    ['cancelada', [{ ...X_DE_PE, status: 'cancelled' }]],
    ['que já passou', [{ ...X_DE_PE, startsAt: '2026-10-02 11:00:00+00', endsAt: '2026-10-02 11:30:00+00' }]],
  ])('X %s: erro legível, nada gravado, nada no Google nem na fila', async (_caso, linhaDeX) => {
    h.state.results.push(linhaDeX, [ANTES_X], AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({ ...NOVA, calendarId: 'cal-a', remarcaEventoId: X, notifyPatient: true })

    expect(res).toEqual({ id: null, error: ERRO_REMARCACAO_INDISPONIVEL })
    expect(passos()).toEqual([])
    expect(h.push).not.toHaveBeenCalled()
    expect(h.agendar).not.toHaveBeenCalled()
  })

  it('sem paciente no formulário ou id que não é UUID: recusa sem nem procurar', async () => {
    const semPaciente = await createEvent({ ...NOVA, contactId: null, calendarId: 'cal-a', remarcaEventoId: X })
    const idTorto = await createEvent({ ...NOVA, calendarId: 'cal-a', remarcaEventoId: "x' OR 1=1" })

    expect(semPaciente.error).toBe(ERRO_REMARCACAO_INDISPONIVEL)
    expect(idTorto.error).toBe(ERRO_REMARCACAO_INDISPONIVEL)
    expect(h.state.calls).toEqual([])
  })

  it('sem o campo (consulta nova, mesmo com outra já marcada): cria como antes', async () => {
    h.state.results.push(AGENDA_GOOGLE, [{ id: 'c-1' }], [{ id: 'ev-novo' }])

    const res = await createEvent({ ...NOVA, calendarId: 'cal-a', remarcaEventoId: null })

    expect(res).toEqual({ id: 'ev-novo', error: null, confirmacao: null })
    expect(passos()).toEqual(['insert', 'google:create'])
  })

  it('a edição de X falhou: devolve o erro, sem id', async () => {
    h.state.results.push([X_DE_PE], [ANTES_X], AGENDA_GOOGLE, [{ id: 'c-1' }])
    h.state.updateFalha = true

    const res = await createEvent({ ...NOVA, calendarId: 'cal-a', remarcaEventoId: X })

    expect(res.id).toBeNull()
    expect(res.error).toBeTruthy()
    expect(h.push).not.toHaveBeenCalled()
  })
})

describe('estado fresco da confirmação (o modal pede ao abrir a edição — revisão de 02/10)', () => {
  const EV = '33333333-3333-4333-8333-333333333333'

  it('normaliza como a grade: vencimento em ISO, base e desfecho validados', async () => {
    h.state.results.push([
      {
        confirmationDueAt: null,
        confirmationKnown: { startsAt: '2026-10-05 15:00:00+00', calendarId: 'cal-a', contactId: 'c-1' },
        confirmationResult: { status: 'enviada', at: '2026-10-02T13:08:30.000Z' },
      },
    ])

    expect(await estadoDaConfirmacao(EV)).toEqual({
      confirmationDueAt: null,
      confirmationKnown: { startsAt: '2026-10-05 15:00:00+00', calendarId: 'cal-a', contactId: 'c-1' },
      confirmationResult: { status: 'enviada', at: '2026-10-02T13:08:30.000Z' },
    })
  })

  it('o worker está enviando: o vencimento é o do marcador (já passou → "saindo agora"), e o marcador não vira desfecho', async () => {
    h.state.results.push([
      {
        confirmationDueAt: '2026-10-02 13:18:00.123+00', // o lease (+10 min)
        confirmationKnown: { lixo: true },
        confirmationResult: { status: 'enviando', at: '2026-10-02T13:08:01.000Z' },
      },
    ])

    expect(await estadoDaConfirmacao(EV)).toEqual({
      confirmationDueAt: '2026-10-02T13:08:01.000Z',
      confirmationKnown: null,
      confirmationResult: null,
    })
  })

  it('pendente comum: o vencimento da fila, em ISO', async () => {
    h.state.results.push([{ confirmationDueAt: '2026-10-02 13:08:00+00', confirmationKnown: null, confirmationResult: null }])

    expect((await estadoDaConfirmacao(EV))?.confirmationDueAt).toBe('2026-10-02T13:08:00.000Z')
  })

  it('não achou (ou id torto, sem ir ao banco): null', async () => {
    h.state.results.push([])
    expect(await estadoDaConfirmacao(EV)).toBeNull()
    expect(await estadoDaConfirmacao('nao-e-uuid')).toBeNull()
    expect(h.state.calls.filter((c) => c.op === 'select')).toHaveLength(1)
  })
})

describe('consultas futuras do paciente (a pergunta do modal, 02/10)', () => {
  it('datas em ISO, base do que o paciente sabe validada, e só o que ainda vai acontecer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))
    try {
      h.state.results.push([
        {
          id: 'ev-1',
          startsAt: '2026-10-13 12:30:00+00',
          endsAt: '2026-10-13 13:30:00+00',
          allDay: false,
          calendarId: 'cal-a',
          calendarName: 'Dra. Helena Prado',
          title: 'Avaliação · Davi',
          confirmationDueAt: '2026-10-02 12:03:00+00',
          confirmationKnown: { startsAt: '2026-10-12 12:30:00+00', calendarId: 'cal-a', contactId: 'c-1' },
        },
        {
          // Começou há pouco (o banco filtra por now(); aqui vale a mesma régua).
          id: 'ev-2',
          startsAt: '2026-10-02 11:30:00+00',
          endsAt: '2026-10-02 12:30:00+00',
          allDay: false,
          calendarId: 'cal-a',
          calendarName: 'Dra. Helena Prado',
          title: 'Retorno · Bianca',
          confirmationDueAt: null,
          confirmationKnown: { lixo: true },
        },
      ])

      const lista = await listarConsultasFuturasDoContato('22222222-2222-4222-8222-222222222222')

      expect(lista).toEqual([
        {
          id: 'ev-1',
          startsAt: '2026-10-13T12:30:00.000Z',
          endsAt: '2026-10-13T13:30:00.000Z',
          allDay: false,
          calendarId: 'cal-a',
          calendarName: 'Dra. Helena Prado',
          title: 'Avaliação · Davi',
          confirmationDueAt: '2026-10-02T12:03:00.000Z',
          confirmationKnown: { startsAt: '2026-10-12 12:30:00+00', calendarId: 'cal-a', contactId: 'c-1' },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sem contato (ou id torto): lista vazia sem ir ao banco', async () => {
    expect(await listarConsultasFuturasDoContato('')).toEqual([])
    expect(await listarConsultasFuturasDoContato('nao-e-uuid')).toEqual([])
    expect(h.state.calls).toEqual([])
  })
})

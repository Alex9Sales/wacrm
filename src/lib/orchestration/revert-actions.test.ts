import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10/2026, revisão: "Desmarcar" um agendamento aprovado cancelava a
// consulta mesmo quando a aprovação tinha MOVIDO uma que já existia — às vezes
// a do irmão. Agora: criou → cancela; moveu → volta para o horário anterior;
// estado antigo sem dizer o que fez → não mexe. Banco e Google trocados por
// stubs; dados fictícios.

const h = vi.hoisted(() => ({
  atual: [] as unknown[],
  updates: [] as { table: unknown; set: Record<string, unknown> }[],
  pushes: [] as unknown[][],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit']) c[m] = () => c
    c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(h.atual).then(ok, ko)
    return c
  }
  return {
    ...actual,
    db: {
      select: () => chain(),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: async () => {
            h.updates.push({ table, set })
          },
        }),
      }),
    },
  }
})
vi.mock('@/lib/cadences/cadence', () => ({ cancelEnrollment: vi.fn() }))
vi.mock('./actions', () => ({ noteDealEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/google/sync', () => ({
  pushEventToGoogle: async (...a: unknown[]) => {
    h.pushes.push(a)
  },
}))

import { calendarEvents, conversations } from '@/db'
import { recomecoDoLembrete } from '@/lib/ai/meeting-reminder-block'
import { planoDeDesfazerAgendamento, revertOrchestrationAction } from './revert-actions'

const BASE = {
  accountId: 'conta-1',
  actorUserId: 'u-1',
  action: 'schedule_event' as const,
  dealId: null,
  conversationId: 'conv-1',
  reason: null,
}
const MOVEU = {
  acao: 'moveu',
  eventId: 'ev-davi',
  prevStartsAt: '2026-10-21T12:30:00.000Z',
  prevEndsAt: '2026-10-21T13:00:00.000Z',
  startsAt: '2026-10-23T13:00:00.000Z',
  conversationId: 'conv-1',
}

beforeEach(() => {
  h.atual = []
  h.updates = []
  h.pushes = []
})

describe('o plano de desfazer um agendamento aprovado (pura)', () => {
  it('criou → cancela; moveu → restaura o horário anterior; estado antigo → não sabe', () => {
    expect(planoDeDesfazerAgendamento({ acao: 'criou', eventId: 'x' })).toEqual({ tipo: 'cancelar' })
    expect(planoDeDesfazerAgendamento(MOVEU)).toEqual({
      tipo: 'restaurar',
      startsAt: '2026-10-21T12:30:00.000Z',
      endsAt: '2026-10-21T13:00:00.000Z',
      movidaPara: '2026-10-23T13:00:00.000Z',
    })
    // Antes de 02/10 o estado era só { eventId, conversationId }.
    expect(planoDeDesfazerAgendamento({ eventId: 'x', conversationId: 'c' })).toEqual({ tipo: 'nao-sei' })
    // "moveu" sem o horário anterior também não chuta.
    expect(planoDeDesfazerAgendamento({ acao: 'moveu', eventId: 'x' })).toEqual({ tipo: 'nao-sei' })
  })
})

describe('desfazer schedule_event', () => {
  it('moveu: devolve a consulta ao horário anterior (NÃO cancela), recomeça os lembretes e pausa a IA', async () => {
    h.atual = [{ startsAt: '2026-10-23 13:00:00+00', status: 'confirmed' }]
    const r = await revertOrchestrationAction({ ...BASE, revertState: MOVEU })

    expect(r.ok).toBe(true)
    expect(r.done).toMatch(/voltou para o horário anterior/)
    const naConsulta = h.updates.filter((u) => u.table === calendarEvents)
    expect(naConsulta).toHaveLength(1)
    expect(naConsulta[0].set).toMatchObject({
      startsAt: '2026-10-21T12:30:00.000Z',
      endsAt: '2026-10-21T13:00:00.000Z',
      remindersSent: 0,
      reminderBlock: null,
    })
    expect(naConsulta[0].set).not.toHaveProperty('status')
    expect(h.pushes).toEqual([['conta-1', 'ev-davi', 'update']])
    expect(h.updates.some((u) => u.table === conversations && u.set.aiAutoreplyDisabled === true)).toBe(true)
  })

  it('moveu pela IA → desfazer: o contador do horário de antes volta (o lembrete que já saiu não sai de novo)', async () => {
    // 02/10/2026, revisão: o desfazer gravava remindersSent: 0 e o lembrete
    // de 24h do horário original, que o paciente já tinha recebido, saía DE
    // NOVO. Horário original com 1 degrau enviado; a IA move (pela mesma
    // regra do [[AGENDAR]]); o banco fica como o UPDATE dela deixou.
    const original = { startsAt: '2026-10-21 12:30:00+00', remindersSent: 1, remindersPrevStartsAt: null, remindersPrevSent: 0 }
    const daIa = recomecoDoLembrete(original, MOVEU.startsAt)
    expect(daIa).toMatchObject({ remindersSent: 0, remindersPrevStartsAt: '2026-10-21T12:30:00.000Z', remindersPrevSent: 1 })
    h.atual = [{ ...original, ...daIa, startsAt: '2026-10-23 13:00:00+00', status: 'confirmed' }]

    const r = await revertOrchestrationAction({ ...BASE, revertState: MOVEU })

    expect(r.ok).toBe(true)
    const naConsulta = h.updates.filter((u) => u.table === calendarEvents)
    expect(naConsulta).toHaveLength(1)
    expect(naConsulta[0].set).toMatchObject({
      startsAt: '2026-10-21T12:30:00.000Z',
      remindersSent: 1,
      reminderBlock: null,
      reminderBlockAt: null,
    })
    // No horário da IA nada tinha saído: nada a guardar, o guardado fica.
    expect(naConsulta[0].set).not.toHaveProperty('remindersPrevStartsAt')
    expect(naConsulta[0].set).not.toHaveProperty('remindersPrevSent')
  })

  it('moveu pela IA, saiu lembrete no horário novo → desfazer volta o do original e guarda o da IA', async () => {
    h.atual = [
      {
        startsAt: '2026-10-23 13:00:00+00',
        status: 'confirmed',
        remindersSent: 2,
        remindersPrevStartsAt: '2026-10-21 12:30:00+00',
        remindersPrevSent: 1,
      },
    ]
    await revertOrchestrationAction({ ...BASE, revertState: MOVEU })

    const naConsulta = h.updates.filter((u) => u.table === calendarEvents)
    // Só o guardado: os 2 degraus eram do horário da IA, não do original.
    expect(naConsulta[0].set).toMatchObject({
      remindersSent: 1,
      remindersPrevStartsAt: '2026-10-23T13:00:00.000Z',
      remindersPrevSent: 2,
    })
  })

  it('moveu, mas mexeram na consulta depois: não desfaz (nem cancela)', async () => {
    h.atual = [{ startsAt: '2026-10-24 13:00:00+00', status: 'confirmed' }]
    const r = await revertOrchestrationAction({ ...BASE, revertState: MOVEU })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/já foi mexida depois/)
    expect(h.updates).toEqual([])
    expect(h.pushes).toEqual([])
  })

  it('moveu, e a consulta já foi cancelada: não mexe', async () => {
    h.atual = [{ startsAt: '2026-10-23 13:00:00+00', status: 'cancelled' }]
    const r = await revertOrchestrationAction({ ...BASE, revertState: MOVEU })
    expect(r.ok).toBe(false)
    expect(h.updates).toEqual([])
  })

  it('criou: cancela a consulta criada e apaga no Google (como sempre)', async () => {
    const r = await revertOrchestrationAction({ ...BASE, revertState: { acao: 'criou', eventId: 'ev-novo', conversationId: 'conv-1' } })

    expect(r.ok).toBe(true)
    const naConsulta = h.updates.filter((u) => u.table === calendarEvents)
    expect(naConsulta).toHaveLength(1)
    expect(naConsulta[0].set).toMatchObject({ status: 'cancelled' })
    expect(h.pushes).toEqual([['conta-1', 'ev-novo', 'delete']])
  })

  it('estado antigo (sem dizer se criou ou moveu): não cancela nada', async () => {
    const r = await revertOrchestrationAction({ ...BASE, revertState: { eventId: 'ev-x', conversationId: 'conv-1' } })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/desfaça na Agenda/)
    expect(h.updates).toEqual([])
    expect(h.pushes).toEqual([])
  })
})

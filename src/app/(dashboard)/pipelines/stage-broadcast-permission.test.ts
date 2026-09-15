import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09: o disparo por etapa aceitava VIEWER (só getCurrentAccount) e
// hoje manda template pago, e-mail com anexos e dá acesso às conversas. Agora
// é agent+, com motivo claro (não o "Falha ao disparar" genérico). Tudo que a
// action importa vira stub — o que interessa é a porta de entrada.
const h = vi.hoisted(() => ({
  role: 'viewer' as string,
  dbTouched: 0,
  enqueued: 0,
}))

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const
  }
  const ctx = () => ({ accountId: 'acc-1', userId: 'u-1', role: h.role })
  const rank: Record<string, number> = { viewer: 1, agent: 2, supervisor: 3, admin: 4, owner: 5 }
  return {
    ForbiddenError,
    getCurrentAccount: async () => ctx(),
    requireRole: async (min: string) => {
      if ((rank[h.role] ?? 0) < rank[min]) throw new ForbiddenError(`This action requires the '${min}' role or higher`)
      return ctx()
    },
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const touch = () => {
    h.dbTouched++
    throw new Error('banco não deveria ser consultado por viewer')
  }
  return { ...actual, db: { select: touch, insert: touch, update: touch, delete: touch } }
})

vi.mock('@/lib/broadcasts/text-broadcast', () => ({
  enqueueTextBroadcast: async () => {
    h.enqueued++
    return { broadcastId: 'b1', totalRecipients: 1 }
  },
}))
vi.mock('@/lib/broadcasts/template-broadcast', () => ({
  enqueueTemplateBroadcast: async () => {
    h.enqueued++
    return { broadcastId: 'b1', totalRecipients: 1 }
  },
}))
vi.mock('@/lib/broadcasts/audit', () => ({ logBroadcastEvent: async () => {} }))
vi.mock('@/lib/broadcasts/channel-owner-guard', () => ({ otherPersonNumberError: async () => null }))
// Módulos pesados (fila, IA, e-mail, outras actions) — não participam.
vi.mock('@/lib/pipelines/stage-tasks', () => ({}))
vi.mock('@/lib/proposals/proposal', () => ({}))
vi.mock('@/lib/proposals/shared', () => ({}))
vi.mock('@/lib/whatsapp/send-message', () => ({}))
vi.mock('@/lib/channels/inbound', () => ({}))
vi.mock('@/lib/queue/queues', () => ({}))
vi.mock('@/lib/sectors/access', () => ({}))
vi.mock('@/lib/ai/config', () => ({}))
vi.mock('@/lib/ai/generate', () => ({}))
vi.mock('@/lib/ai/context', () => ({}))
vi.mock('@/app/(dashboard)/contacts/actions', () => ({}))
vi.mock('@/app/(dashboard)/tarefas/actions', () => ({}))
vi.mock('@/app/(dashboard)/inbox/schedule-actions', () => ({}))
vi.mock('@/lib/settings/account-settings', () => ({}))
vi.mock('@/lib/cadences/cadence', () => ({}))
vi.mock('@/lib/ai/deal-suggest', () => ({}))
vi.mock('@/lib/ai/followup', () => ({}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({}))

import { broadcastToStage, stageBroadcastInfo } from './actions'

const READ_ONLY = 'Seu acesso é só de leitura — peça a um agente para disparar.'

beforeEach(() => {
  h.role = 'viewer'
  h.dbTouched = 0
  h.enqueued = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('disparo por etapa: permissão', () => {
  it('viewer não dispara: motivo claro, nada enfileirado, banco intocado', async () => {
    const res = await broadcastToStage({ stageId: 's1', channelId: 'ch-1', kind: 'text', text: 'Oi' })
    expect(res).toEqual({ ok: false, error: READ_ONLY })
    expect(h.enqueued).toBe(0)
    expect(h.dbTouched).toBe(0)
  })

  it('viewer também não recebe canais nem leads da etapa', async () => {
    const info = await stageBroadcastInfo('s1')
    expect(info).toEqual({
      leadCount: 0,
      leadCountWithEmail: 0,
      sampleLead: null,
      channels: [],
      error: READ_ONLY,
    })
    expect(h.dbTouched).toBe(0)
  })

  it('agente passa da porta (chega ao banco)', async () => {
    h.role = 'agent'
    const res = await broadcastToStage({ stageId: 's1', channelId: 'ch-1', kind: 'text', text: 'Oi' })
    // O stub do banco lança de propósito: prova que a checagem de papel deixou passar.
    expect(h.dbTouched).toBeGreaterThan(0)
    expect(res).toEqual({ ok: false, error: 'Falha ao disparar para a etapa.' })
  })
})

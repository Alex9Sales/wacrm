import { beforeEach, describe, expect, it, vi } from 'vitest'

// Moeda (02/10/2026): aceitar uma sugestão da IA num campo personalizado de
// MOEDA falhava com o aviso genérico do save ("Não entendi o valor…") quando
// a IA tinha escrito "3 mil" / "R$ 5k". A geração já descarta isso, mas
// sugestão antiga pode estar pendente — o acceptDealSuggestion confere ANTES
// de salvar, explica o que fazer e, se for número, grava no formato do campo.
// O banco é um stub que responde por tabela; o resto da action vira stub.
const h = vi.hoisted(() => ({
  sug: null as Record<string, unknown> | null,
  field: null as { name: string; type: string } | null,
  saved: [] as { contactId: string; map: Record<string, string> }[],
  updates: [] as unknown[],
  inserts: [] as unknown[],
}))

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const CONTACT_ID = '22222222-2222-4222-8222-222222222222'

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const
  }
  const ctx = () => ({ accountId: 'acc-1', userId: 'u-1', role: 'admin' })
  return { ForbiddenError, getCurrentAccount: async () => ctx(), requireRole: async () => ctx() }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const rowsFor = (table: unknown): unknown[] => {
    if (table === actual.dealSuggestions) return h.sug ? [h.sug] : []
    if (table === actual.customFields) return h.field ? [h.field] : []
    if (table === actual.deals) {
      return [{ id: DEAL_ID, contact_id: CONTACT_ID, assigned_to: null, value: '0', contact: null, assignee: null }]
    }
    throw new Error('tabela inesperada no teste')
  }
  const db = {
    select: () => {
      let table: unknown = null
      const chain: Record<string, unknown> = {}
      for (const m of ['leftJoin', 'where', 'orderBy']) chain[m] = () => chain
      chain.from = (t: unknown) => {
        table = t
        return chain
      }
      chain.limit = async () => rowsFor(table)
      return chain
    },
    update: () => ({
      set: (v: unknown) => {
        h.updates.push(v)
        return { where: async () => {} }
      },
    }),
    insert: () => ({
      values: async (v: unknown) => {
        h.inserts.push(v)
      },
    }),
    delete: () => {
      throw new Error('nada deveria ser apagado')
    },
  }
  return { ...actual, db }
})

vi.mock('@/app/(dashboard)/contacts/actions', () => ({
  listContactCustomValues: async () => [],
  saveContactCustomValues: async (contactId: string, map: Record<string, string>) => {
    h.saved.push({ contactId, map })
    return { error: null }
  },
}))
vi.mock('@/lib/queue/queues', () => ({ enqueueOrchestrationNudge: async () => {} }))
// Módulos pesados (fila, IA, e-mail, outras actions) — não participam.
vi.mock('@/lib/broadcasts/text-broadcast', () => ({}))
vi.mock('@/lib/broadcasts/template-broadcast', () => ({}))
vi.mock('@/lib/broadcasts/audit', () => ({}))
vi.mock('@/lib/broadcasts/channel-owner-guard', () => ({}))
vi.mock('@/lib/pipelines/stage-tasks', () => ({}))
vi.mock('@/lib/proposals/proposal', () => ({}))
vi.mock('@/lib/proposals/shared', () => ({}))
vi.mock('@/lib/whatsapp/send-message', () => ({}))
vi.mock('@/lib/channels/inbound', () => ({}))
vi.mock('@/lib/sectors/access', () => ({}))
vi.mock('@/lib/ai/config', () => ({}))
vi.mock('@/lib/ai/generate', () => ({}))
vi.mock('@/lib/ai/context', () => ({}))
vi.mock('@/app/(dashboard)/tarefas/actions', () => ({}))
vi.mock('@/app/(dashboard)/inbox/schedule-actions', () => ({}))
vi.mock('@/lib/settings/account-settings', () => ({}))
vi.mock('@/lib/cadences/cadence', () => ({}))
vi.mock('@/lib/ai/deal-suggest', () => ({}))
vi.mock('@/lib/ai/followup', () => ({}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({}))

import { acceptDealSuggestion } from './actions'

function sugestao(value: string) {
  return {
    id: 'sug-1',
    dealId: DEAL_ID,
    kind: 'field',
    target: 'custom:cf-moeda',
    label: 'Orçamento',
    value,
    evidence: 'trecho da conversa',
    dueAt: null,
  }
}

beforeEach(() => {
  h.sug = null
  h.field = { name: 'Orçamento', type: 'currency' }
  h.saved = []
  h.updates = []
  h.inserts = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('aceitar sugestão da IA em campo de moeda', () => {
  it.each(['3 mil', 'entre 3 e 5 mil', 'R$ 5k'])(
    '"%s": erro claro, nada salvo e a sugestão continua pendente',
    async (valor) => {
      h.sug = sugestao(valor)
      const res = await acceptDealSuggestion('sug-1')
      expect(res).toEqual({
        error: `A IA sugeriu "${valor}" para "Orçamento", que não é um valor em reais. Preencha o campo à mão ou dispense a sugestão.`,
      })
      expect(h.saved).toEqual([])
      expect(h.updates).toEqual([])
      expect(h.inserts).toEqual([])
    },
  )

  it('valor em reais é gravado no formato do campo de moeda', async () => {
    h.sug = sugestao('R$ 1.500,00')
    const res = await acceptDealSuggestion('sug-1')
    expect(res).toEqual({ error: null })
    expect(h.saved).toEqual([{ contactId: CONTACT_ID, map: { 'cf-moeda': '1500' } }])
    expect(h.updates).toEqual([{ status: 'accepted' }])
  })

  it('campo que NÃO é de moeda segue gravando o texto como veio', async () => {
    h.field = { name: 'Observação', type: 'text' }
    h.sug = sugestao('uns 3 mil')
    const res = await acceptDealSuggestion('sug-1')
    expect(res).toEqual({ error: null })
    expect(h.saved).toEqual([{ contactId: CONTACT_ID, map: { 'cf-moeda': 'uns 3 mil' } }])
  })
})

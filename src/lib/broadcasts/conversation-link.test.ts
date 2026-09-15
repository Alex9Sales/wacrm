import { beforeEach, describe, expect, it, vi } from 'vitest'

// 15/09 (GoLink): o disparo do Vitor saiu pelo número dedicado ao Leonardo e
// ele não via nenhuma conversa. Vira participante — sem trocar responsável,
// setor nem número. O db é trocado por respostas por tabela; a tabela de
// participantes simula o índice único (conversation_id, user_id).
const h = vi.hoisted(() => ({
  channel: null as { accountId: string; provider: string } | null,
  contact: null as { userId: string } | null,
  throwOnSelect: false,
  participants: new Set<string>(),
  inserts: [] as { values: unknown; conflictTarget: unknown }[],
  conv: null as { conversation: { id: string }; created: boolean } | null,
  findCalls: [] as unknown[][],
  webhooks: [] as unknown[][],
  events: [] as unknown[][],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (h.throwOnSelect) throw new Error('db caiu')
            if (table === actual.channels) return h.channel ? [h.channel] : []
            if (table === actual.contacts) return h.contact ? [h.contact] : []
            return []
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: { conversationId: string; userId: string }) => ({
        onConflictDoNothing: async (opts?: { target?: unknown }) => {
          if (table !== actual.conversationParticipants) throw new Error('tabela errada')
          h.inserts.push({ values, conflictTarget: opts?.target })
          // índice único: repetido é ignorado (DO NOTHING), nunca duplica
          h.participants.add(`${values.conversationId}:${values.userId}`)
        },
      }),
    }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/channels/inbound', () => ({
  findOrCreateConversation: vi.fn(async (...args: unknown[]) => {
    h.findCalls.push(args)
    return h.conv
  }),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async (...args: unknown[]) => {
    h.webhooks.push(args)
  }),
}))
vi.mock('@/lib/events/publish', () => ({
  publishEvent: vi.fn(async (...args: unknown[]) => {
    h.events.push(args)
  }),
}))

import { linkBroadcastConversation } from './conversation-link'

const input = { accountId: 'acc', channelId: 'ch-atendimento', contactId: 'c1', creatorUserId: 'u-vitor' }

beforeEach(() => {
  h.channel = { accountId: 'acc', provider: 'waha' }
  h.contact = { userId: 'u-owner' }
  h.throwOnSelect = false
  h.participants = new Set()
  h.inserts = []
  h.conv = { conversation: { id: 'cv1' }, created: false }
  h.findCalls = []
  h.webhooks = []
  h.events = []
})

describe('linkBroadcastConversation', () => {
  it('garante a conversa pelo helper do eco e põe quem disparou como participante', async () => {
    await linkBroadcastConversation(input)
    // autoria da conversa = dono do contato (igual ao eco), não quem disparou
    expect(h.findCalls).toEqual([['acc', 'u-owner', 'c1', 'ch-atendimento']])
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].values).toEqual({ conversationId: 'cv1', userId: 'u-vitor' })
    expect(h.inserts[0].conflictTarget).toBeTruthy()
    expect([...h.participants]).toEqual(['cv1:u-vitor'])
    // conversa já existia (eco chegou antes) → nada de conversation.created
    expect(h.webhooks).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })

  it('não duplica participante (2º envio pra mesma conversa / retry)', async () => {
    await linkBroadcastConversation(input)
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(2)
    expect(h.participants.size).toBe(1)
  })

  it('pula canal de e-mail e gmail sem criar conversa', async () => {
    for (const provider of ['email', 'gmail']) {
      h.channel = { accountId: 'acc', provider }
      await linkBroadcastConversation(input)
    }
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('canal de outra conta ou contato de outra conta → não faz nada', async () => {
    h.channel = { accountId: 'outra', provider: 'waha' }
    await linkBroadcastConversation(input)
    h.channel = { accountId: 'acc', provider: 'waha' }
    h.contact = null
    await linkBroadcastConversation(input)
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('criou a conversa aqui → emite o conversation.created que o eco não vai emitir', async () => {
    h.conv = { conversation: { id: 'cv-new' }, created: true }
    await linkBroadcastConversation(input)
    expect(h.webhooks).toEqual([
      ['acc', 'conversation.created', { conversation_id: 'cv-new', contact_id: 'c1' }, 'ch-atendimento'],
    ])
    expect(h.events).toEqual([['acc', { type: 'conversation.created', conversationId: 'cv-new' }]])
  })

  it('nunca lança: conversa não resolvida ou banco fora', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.conv = null
    await expect(linkBroadcastConversation(input)).resolves.toBeUndefined()
    expect(h.inserts).toHaveLength(0)
    h.throwOnSelect = true
    await expect(linkBroadcastConversation(input)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('sem quem criou (disparo antigo/automático) → não consulta', async () => {
    h.throwOnSelect = true
    await expect(linkBroadcastConversation({ ...input, creatorUserId: '' })).resolves.toBeUndefined()
    expect(h.findCalls).toHaveLength(0)
  })
})

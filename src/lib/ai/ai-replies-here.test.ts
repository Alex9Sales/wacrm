import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09 (GoLink): "IA em espera"/"Tirar responsável" apareciam em
// canal que o roteamento não atende — lista de canais vazia de um agente
// NÃO-default era lida como "todos". Usa o roteamento real (agents.ts
// pickAgentIdForChannel); só o banco é stub.
type Agent = {
  id: string
  isDefault: boolean
  isActive: boolean
  autoReplyEnabled: boolean
  channelIds: string[]
}

const h = vi.hoisted(() => ({
  agents: [] as {
    id: string
    isDefault: boolean
    isActive: boolean
    autoReplyEnabled: boolean
    channelIds: string[]
  }[],
  ownerLookups: 0,
  /** Agente que a consulta do dono encontra (o id pedido no WHERE). */
  ownerId: null as string | null,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const eligible = () => h.agents.filter((a: Agent) => a.isActive && a.autoReplyEnabled)
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          // pickAgentIdForChannel: agentes ativos com auto-resposta (requireAutoReply).
          orderBy: async () =>
            eligible().map((a: Agent) => ({ id: a.id, isDefault: a.isDefault, channelIds: a.channelIds })),
          // Dono da conversa (ativo + auto-resposta): o teste diz qual id é o dono.
          limit: async () => {
            h.ownerLookups++
            const owner = eligible().find((a: Agent) => a.id === h.ownerId)
            return owner ? [{ id: owner.id }] : []
          },
        }),
      }),
    }),
  }
  return { ...actual, db }
})

import { aiRepliesOnConversation } from './ai-replies-here'

const agent = (over: Partial<Agent> & { id: string }): Agent => ({
  isDefault: false,
  isActive: true,
  autoReplyEnabled: true,
  channelIds: [],
  ...over,
})

beforeEach(() => {
  h.agents = []
  h.ownerLookups = 0
  h.ownerId = null
})

describe('aiRepliesOnConversation', () => {
  it('agente NÃO-default de lista vazia numa conta com 2 agentes: não atende o canal (o bug)', async () => {
    h.agents = [
      agent({ id: 'vendas', isDefault: true, channelIds: ['ch-vendas'] }),
      agent({ id: 'cobranca', channelIds: [] }),
    ]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-leonardo', aiAgentId: null })).toBe(false)
  })

  it('default de lista vazia cobre qualquer canal', async () => {
    h.agents = [agent({ id: 'geral', isDefault: true }), agent({ id: 'cobranca', channelIds: ['ch-cob'] })]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-leonardo', aiAgentId: null })).toBe(true)
  })

  it('conta com um agente só e lista vazia: atende todos (comportamento antigo)', async () => {
    h.agents = [agent({ id: 'unico' })]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-1', aiAgentId: null })).toBe(true)
  })

  it('canal listado explicitamente: atende', async () => {
    h.agents = [agent({ id: 'vendas', isDefault: true, channelIds: ['ch-vendas'] }), agent({ id: 'cob', channelIds: ['ch-cob'] })]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-cob', aiAgentId: null })).toBe(true)
  })

  it('agente com auto-resposta desligada ou inativo não conta', async () => {
    h.agents = [agent({ id: 'geral', isDefault: true, autoReplyEnabled: false })]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-1', aiAgentId: null })).toBe(false)
    h.agents = [agent({ id: 'geral', isDefault: true, isActive: false })]
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-1', aiAgentId: null })).toBe(false)
  })

  it('agente dono da conversa (transferência) ativo com auto-resposta: atende mesmo fora do canal', async () => {
    h.agents = [
      agent({ id: 'vendas', isDefault: true, channelIds: ['ch-vendas'] }),
      agent({ id: 'cobranca', channelIds: [] }),
    ]
    h.ownerId = 'cobranca'
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-leonardo', aiAgentId: 'cobranca' })).toBe(true)
    expect(h.ownerLookups).toBe(1)
  })

  it('dono desativado: cai no roteamento do canal', async () => {
    h.agents = [
      agent({ id: 'vendas', isDefault: true, channelIds: ['ch-vendas'] }),
      agent({ id: 'cobranca', autoReplyEnabled: false }),
    ]
    h.ownerId = 'cobranca'
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-leonardo', aiAgentId: 'cobranca' })).toBe(false)
    expect(await aiRepliesOnConversation('acc', { channelId: 'ch-vendas', aiAgentId: 'cobranca' })).toBe(true)
  })

  it('sem canal e sem dono: só o default de lista vazia atende', async () => {
    h.agents = [agent({ id: 'vendas', isDefault: true, channelIds: ['ch-vendas'] }), agent({ id: 'x' })]
    expect(await aiRepliesOnConversation('acc', { channelId: null, aiAgentId: null })).toBe(false)
    expect(h.ownerLookups).toBe(0)
  })
})

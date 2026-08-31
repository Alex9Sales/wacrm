import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  // Cycle-safe stringify — drizzle SQL objects can hold circular refs.
  safeStringify(o: unknown): string {
    const seen = new WeakSet<object>()
    return JSON.stringify(o, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return undefined
        seen.add(v)
      }
      return v
    })
  },
  loadAiConfig: vi.fn(),
  hasAgent: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    recentHumanMsgs: [] as { id: string }[],
    // 🏁 guard anti-eco: a última msg não-interna da conversa (com orderBy).
    lastMessages: [{ senderType: 'customer' }] as { senderType: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    sqlCalls: [] as string[],
  },
}))

// Multi-agente: o auto-reply agora roteia por canal (loadAiConfigForChannel)
// e faz um early-out barato (hasActiveAutoReplyAgent). Mapeamos os dois para
// os mocks existentes — o roteamento por canal é testado em agents.ts.
vi.mock('./config', () => ({
  loadAiConfigForChannel: h.loadAiConfig,
  loadAiConfigById: vi.fn(async () => null),
}))
vi.mock('./agents', () => ({ hasActiveAutoReplyAgent: h.hasAgent }))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
  stripLeadingTimestamp: (s: string) => s,
  loadContactHistoryDigest: vi.fn(async () => null),
}))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('@/lib/cdl/metrics', () => ({
  buildCustomerFactsBlock: vi.fn(async () => null),
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
// Ações do agente (Fase 1/2): no-op nos testes de elegibilidade do auto-reply.
vi.mock('./close-actions', () => ({
  listAccountTagNames: async () => [],
  applyTagsByName: async () => [],
  loadDealCloseContext: async () => null,
  applyCloseActions: async () => ({ resolved: false, movedTo: null }),
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return {
    ...actual,
    db: {
      // Two select chains: automations (auto-responder guard) and
      // conversations (eligibility read). Distinguished by the table
      // passed to .from() — real table objects survive via importOriginal.
      select: () => ({
        from: (table: unknown) => {
          // The eligibility read joins contacts (for is_group); the automations
          // guard doesn't. `innerJoin` returns the same chain so both shapes
          // resolve through the same where().limit().
          const chain: {
            innerJoin: () => typeof chain
            where: () => {
              limit: () => Promise<unknown[]>
              orderBy: () => { limit: () => Promise<unknown[]> }
            }
          } = {
            innerJoin: () => chain,
            where: () => ({
              limit: () => {
                if (table === actual.automations) {
                  return Promise.resolve(h.state.autoResponders)
                }
                if (table === actual.messages) {
                  // 🤫 gate do barge-in: msgs de HUMANO recentes na conversa.
                  return Promise.resolve(h.state.recentHumanMsgs ?? [])
                }
                return Promise.resolve(h.state.conv ? [h.state.conv] : [])
              },
              // 🏁 guard anti-eco (messages + orderBy + limit): última msg.
              orderBy: () => ({
                limit: () => Promise.resolve(h.state.lastMessages ?? []),
              }),
            }),
          }
          return chain
        },
      }),
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => {
            h.state.updatePayload = payload
            return Promise.resolve()
          },
        }),
      }),
      // claim_ai_reply_slot — serialized SQL carries the fn name + params.
      execute: (query: unknown) => {
        h.state.sqlCalls.push(h.safeStringify(query))
        return Promise.resolve({ rows: [{ claimed: h.state.claim }] })
      },
    },
  }
})

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyChannelIds: [],
    autoReplyMaxPerConversation: 3,
    autoReplyHoursMode: 'always',
    embeddingsApiKey: null,
    signatureName: null,
    signatureEnabled: false,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assignedAgentId: null,
    aiAutoreplyDisabled: false,
    aiReplyCount: 0,
    isGroup: false,
  }
  h.state.autoResponders = []
  h.state.recentHumanMsgs = []
  h.state.lastMessages = [{ senderType: 'customer' }]
  h.state.claim = true
  h.state.updatePayload = null
  h.state.sqlCalls = []
  h.hasAgent.mockResolvedValue(true)
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('🏁 anti-eco: última msg NÃO é do cliente → não gera (chase já coberto)', async () => {
    h.state.lastMessages = [{ senderType: 'bot' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🏁 anti-eco: humano respondeu por último → IA não fala por cima', async () => {
    h.state.lastMessages = [{ senderType: 'agent' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.sqlCalls).toHaveLength(1)
    expect(h.state.sqlCalls[0]).toContain('claim_ai_reply_slot')
    expect(h.state.sqlCalls[0]).toContain('conv-1') // conversation param
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🤫 barge-in: humano respondeu há pouco → IA fica em silêncio', async () => {
    h.state.recentHumanMsgs = [{ id: 'm-human' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    // silêncio temporário: NÃO desliga a IA
    expect(h.state.updatePayload).toBeNull()
  })

  it('🔊 responder por áudio OFF: [[AUDIO]] vira texto normal', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ audioRepliesEnabled: false }))
    h.generateReply.mockResolvedValue({ text: '[[AUDIO]]Oi, tudo bem?', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Oi, tudo bem?' }),
    )
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.sqlCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('NEVER replies in a group thread (hard lock)', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
      isGroup: true,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.sqlCalls).toHaveLength(0)
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assignedAgentId: 'agent-9',
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: true,
      aiReplyCount: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: false,
      aiReplyCount: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('handoff sem texto: manda despedida padrão e desliga a IA', async () => {
    // Bug da 1ª transferência da Maria (26/08): o cliente ficava no vácuo.
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    const sent = h.engineSendText.mock.calls[0][0] as { text: string }
    expect(sent.text).toContain('responsável')
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(h.state.sqlCalls).toHaveLength(0)
  })

  it('handoff COM texto: envia a despedida do modelo e desliga a IA', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Perfeito! O responsável já vai falar contigo.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Perfeito! O responsável já vai falar contigo.',
      }),
    )
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
  })
})

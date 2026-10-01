import { beforeEach, describe, expect, it, vi } from 'vitest'

// 01/10 (revisão da confirmação ao agendar): depois do INSERT, a mensagem JÁ
// SAIU e JÁ ESTÁ gravada. O UPDATE da conversa (prévia da lista) que falhasse
// lançava Error cru, e quem chamou lia "o envio falhou" com o cliente já
// tendo recebido — a recepção mandava de novo. Banco falso em fila; provedor
// e canal falsos. Dados fictícios (LGPD).

const h = vi.hoisted(() => {
  const state = { results: [] as unknown[], updates: 0, updateFalha: false }
  const chain = (op: 'select' | 'insert' | 'update') => {
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        if (op === 'update') {
          state.updates++
          promise = state.updateFalha ? Promise.reject(new Error('connection terminated')) : Promise.resolve(undefined)
        } else {
          promise = Promise.resolve(state.results.shift() ?? [])
        }
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
          return () => self
        },
      },
    )
    return self
  }
  return {
    state,
    db: { select: () => chain('select'), insert: () => chain('insert'), update: () => chain('update') },
    sendText: vi.fn(async () => ({ externalMessageId: 'wa-1' })),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: async () => ({ id: 'ch-1', accountId: 'acct-1', provider: 'waha', providerMeta: {} }),
  loadDefaultChannel: async () => null,
}))
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ id: 'waha', capabilities: { templates: false }, sendText: h.sendText }),
}))
vi.mock('@/lib/events/publish', () => ({ publishEvent: vi.fn(async () => {}) }))

import { sendMessageToConversation } from './send-message'

const CONVERSA = [{ id: 'cv-1', contactId: 'c-1', channelId: 'ch-1' }]
const CONTATO = [{ id: 'c-1', phone: '5500900000000', isGroup: false, externalId: null, email: null }]

beforeEach(() => {
  h.state.results = []
  h.state.updates = 0
  h.state.updateFalha = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('depois de enviar e gravar, nada vira erro', () => {
  it('o UPDATE da conversa falhou: o envio continua sendo sucesso (com log)', async () => {
    h.state.results.push(CONVERSA, CONTATO, [{ id: 'm-1' }])
    h.state.updateFalha = true

    const r = await sendMessageToConversation('acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Olá! Sua consulta está confirmada.',
      senderType: 'bot',
    })

    expect(r).toEqual({ messageId: 'm-1', whatsappMessageId: 'wa-1' })
    expect(h.sendText).toHaveBeenCalledTimes(1)
    expect(h.state.updates).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('atualizar a conversa falhou'),
      'connection terminated',
    )
  })

  it('caminho feliz: atualiza a conversa e devolve os ids', async () => {
    h.state.results.push(CONVERSA, CONTATO, [{ id: 'm-1' }])

    const r = await sendMessageToConversation('acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Olá!',
      senderType: 'bot',
    })

    expect(r).toEqual({ messageId: 'm-1', whatsappMessageId: 'wa-1' })
    expect(h.state.updates).toBe(1)
  })
})

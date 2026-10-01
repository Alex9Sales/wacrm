import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * engineSendText limpa marcador interno ANTES de enviar e de gravar (01/10).
 *
 * Zelo: o gatilho de etapa "Envio da COF" mandou quatro vezes
 * "[[ENVIAR: Circular de Oferta de Franquia]]" cru para leads de franquia. Ele
 * envia por engineSendText — e a rede que limpa marcador só existia no
 * auto-reply e em sendMessageToConversation. Tudo que é automático (follow-up,
 * lembrete, fluxo, CSAT) passa por aqui, então a rede também tem que passar.
 *
 * Sem banco e sem WhatsApp: o banco é um dublê que entrega o contato e a
 * conversa e anota o que foi gravado; o provedor anota o que foi enviado.
 * Telefone e ids fictícios.
 */
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  selectCalls: 0,
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  sent: [] as string[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return {
    ...actual,
    db: {
      select: () => {
        h.selectCalls++
        const rows = h.selects.shift() ?? []
        return { from: () => ({ where: () => ({ limit: async () => rows }) }) }
      },
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.inserts.push(v)
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            h.updates.push(v)
          },
        }),
      }),
    },
  }
})

vi.mock('@/lib/channels/channels', () => ({
  loadChannel: async () => ({ id: 'canal-1', accountId: 'conta-1', provider: 'waha' }),
  loadDefaultChannel: async () => null,
}))

vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({
    id: 'waha',
    capabilities: {},
    sendText: async (_ch: unknown, _to: string, text: string) => {
      h.sent.push(text)
      return { externalMessageId: 'msg-externo-1' }
    },
  }),
}))

vi.mock('@/lib/events/publish', () => ({ publishEvent: async () => {} }))

import { engineSendText } from './meta-send'

const base = {
  accountId: 'conta-1',
  userId: 'usuario-1',
  conversationId: 'conversa-1',
  contactId: 'contato-1',
}

function contatoEConversa() {
  h.selects.push([{ id: 'contato-1', phone: '5511900000000', externalId: null }])
  h.selects.push([{ channelId: 'canal-1' }])
}

describe('engineSendText — marcador interno nunca sai', () => {
  beforeEach(() => {
    h.selects = []
    h.selectCalls = 0
    h.inserts = []
    h.updates = []
    h.sent = []
  })

  it('tira o [[ENVIAR:…]] do texto enviado E do texto gravado', async () => {
    contatoEConversa()
    await engineSendText({
      ...base,
      text: 'Segue a circular para você analisar com calma.\n[[ENVIAR: Circular de Oferta de Franquia]]',
    })
    expect(h.sent).toEqual(['Segue a circular para você analisar com calma.'])
    expect(h.inserts[0].contentText).toBe('Segue a circular para você analisar com calma.')
    expect(h.updates[0].lastMessageText).toBe('Segue a circular para você analisar com calma.')
  })

  it('texto sem "[[" sai idêntico (inclusive espaços e quebras)', async () => {
    contatoEConversa()
    const texto = 'Oi!\n\n  Tudo certo por aí?  '
    await engineSendText({ ...base, text: texto })
    expect(h.sent).toEqual([texto])
    expect(h.inserts[0].contentText).toBe(texto)
  })

  it('preserva o que é conteúdo de verdade: [[AUDIO]] e [[foto:…]]', async () => {
    contatoEConversa()
    await engineSendText({ ...base, text: 'Olha só [[foto:fachada]]' })
    expect(h.sent).toEqual(['Olha só [[foto:fachada]]'])
  })

  it('só marcador: lança erro claro ANTES de tocar no banco ou no WhatsApp', async () => {
    await expect(
      engineSendText({ ...base, text: '[[ENVIAR: Circular de Oferta de Franquia]]' }),
    ).rejects.toThrow('mensagem vazia depois de limpar marcadores internos')
    expect(h.selectCalls).toBe(0)
    expect(h.sent).toEqual([])
    expect(h.inserts).toEqual([])
  })
})

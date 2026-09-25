import { describe, expect, it, vi, beforeEach } from 'vitest'

// 25/09 — ferramenta externa LENTA. A chamada normal vive dentro do turno e
// aborta em 12s; uma API de 25s nunca fecha ali. Aqui interessa a DECISÃO:
// a lenta sai do turno em vez de ir à rede, o cliente recebe um aviso em vez
// de silêncio, e o modelo não é deixado livre para inventar o resultado.

const enqueued: unknown[] = []
const enqueueMock = vi.hoisted(() => ({
  fn: vi.fn(async (job: unknown) => Boolean(job)),
}))

vi.mock('@/lib/queue/queues', () => ({
  enqueueSlowTool: enqueueMock.fn,
}))

const fetchSpy = vi.fn()
vi.stubGlobal('fetch', fetchSpy)

vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }) }) }),
  },
  agentTools: { tableName: 'agentTools' },
  agentToolRuns: { tableName: 'agentToolRuns' },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }))
vi.mock('@/lib/net/safe-url', () => ({ assertPublicUrl: async (u: URL) => u }))
vi.mock('./crm-fallback', () => ({ crmFallbackForTool: async () => '' }))
vi.mock('./generate', () => ({ generateReply: async () => ({ text: '', handoff: false }) }))

import { executeTool, type ExternalTool } from './external-tools'

const base: ExternalTool = {
  id: 'tool1',
  slug: 'consultar_tutor',
  name: 'Tutor',
  description: 'tira dúvida do aluno',
  method: 'POST',
  url: 'https://api.exemplo.com/ask',
  headers: {},
  params: [{ name: 'email', type: 'string', description: 'e-mail', required: true }],
  bodyTemplate: null,
  risk: 'read',
  dedupScope: 'off',
  createsDeal: false,
  slow: false,
}

const ctx = {
  accountId: 'acc1',
  agentId: 'ag1',
  conversationId: 'conv1',
  contactId: 'c1',
  question: 'por que a peça desprende?',
}

beforeEach(() => {
  enqueued.length = 0
  enqueueMock.fn.mockClear()
  enqueueMock.fn.mockImplementation(async (job: unknown) => {
    enqueued.push(job)
    return true
  })
  fetchSpy.mockReset()
})

describe('ferramenta lenta sai do turno', () => {
  it('enfileira em vez de chamar a API na hora', async () => {
    const out = await executeTool({ ...base, slow: true }, { email: 'a@b.com' }, ctx)
    expect(out.status).toBe('pending')
    expect(enqueueMock.fn).toHaveBeenCalledTimes(1)
    // O que não pode acontecer de jeito nenhum: segurar o turno na rede.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leva a pergunta e o contato — é quem vai receber a resposta depois', async () => {
    await executeTool({ ...base, slow: true }, { email: 'a@b.com' }, ctx)
    expect(enqueued[0]).toMatchObject({
      conversationId: 'conv1',
      contactId: 'c1',
      toolId: 'tool1',
      question: 'por que a peça desprende?',
    })
  })

  it('manda o modelo avisar E proíbe inventar o resultado', async () => {
    const out = await executeTool({ ...base, slow: true }, { email: 'a@b.com' }, ctx)
    // Só "avise que está consultando" deixaria o modelo livre para completar
    // o silêncio com um palpite — que é pior do que a demora.
    expect(out.summary).toMatch(/não invente/i)
    expect(out.summary).toMatch(/outra mensagem/i)
  })

  it('ferramenta normal continua indo à rede na hora', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' })
    const out = await executeTool(base, { email: 'a@b.com' }, ctx)
    expect(out.status).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(enqueueMock.fn).not.toHaveBeenCalled()
  })
})

describe('quando não dá para enfileirar, o cliente não fica no vácuo', () => {
  it('fila fora do ar vira erro com orientação, não silêncio', async () => {
    enqueueMock.fn.mockResolvedValue(false)
    const out = await executeTool({ ...base, slow: true }, { email: 'a@b.com' }, ctx)
    expect(out.status).toBe('error')
    expect(out.summary).toMatch(/diga ao cliente/i)
  })

  it('fora de uma conversa não há para onde responder depois', async () => {
    const out = await executeTool({ ...base, slow: true }, { email: 'a@b.com' }, { ...ctx, conversationId: null })
    expect(out.status).toBe('error')
    expect(enqueueMock.fn).not.toHaveBeenCalled()
  })
})

describe('as travas de sempre valem antes de enfileirar', () => {
  it('parâmetro obrigatório faltando não vira consulta lenta', async () => {
    const out = await executeTool({ ...base, slow: true }, {}, ctx)
    expect(out.status).toBe('invalid')
    expect(enqueueMock.fn).not.toHaveBeenCalled()
  })

  it('ação crítica continua bloqueada mesmo sendo lenta', async () => {
    const out = await executeTool({ ...base, slow: true, risk: 'critical' }, { email: 'a@b.com' }, ctx)
    expect(out.status).toBe('blocked')
    expect(enqueueMock.fn).not.toHaveBeenCalled()
  })
})

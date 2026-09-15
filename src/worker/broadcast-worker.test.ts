import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09 (B): disparo A pausado com pendentes + disparo B com a mesma
// mensagem → quando A voltava, os pendentes recebiam de novo. O worker agora
// confere na hora do envio. Aqui o processador REAL do job de destinatário
// roda com BullMQ, Redis, banco e envio trocados por stubs: o Worker falso
// guarda o processador de cada fila, e a recuperação de filas na subida
// (KEYS bull:outbound-*:meta) cria o da fila do canal.
const h = vi.hoisted(() => ({
  processors: new Map<string, (job: unknown) => Promise<void>>(),
  ctx: null as unknown,
  alreadyReceived: false as boolean | Error,
  sends: [] as unknown[],
  failed: [] as { id: string; attempts: number; error: string }[],
  sent: [] as string[],
  finalized: [] as string[],
  dupCalls: [] as Record<string, unknown>[],
}))

vi.mock('bullmq', () => {
  class Worker {
    constructor(name: string, processor: (job: unknown) => Promise<void>) {
      h.processors.set(name, processor)
    }
    on() {
      return this
    }
    async close() {}
  }
  class UnrecoverableError extends Error {}
  class DelayedError extends Error {}
  return { Worker, UnrecoverableError, DelayedError }
})
vi.mock('@/lib/queue/connection', () => ({
  bullConnection: () => ({}),
  createRedisClient: () => ({ keys: async () => ['bull:outbound-ch1:meta'], quit: async () => {} }),
}))
vi.mock('@/lib/queue/queues', () => ({
  BROADCAST_DISPATCH_QUEUE: 'broadcast-dispatch',
  outboundQueueName: (id: string) => `outbound-${id}`,
  enqueueRecipient: vi.fn(),
}))
vi.mock('@/lib/queue/throughput', () => ({
  limiterForChannel: () => ({ max: 10, duration: 60_000 }),
  jitterForChannel: () => null,
}))
vi.mock('@/lib/queue/errors', () => ({
  channelHaltReason: () => null,
  isPermanentSendError: () => false,
}))
vi.mock('@/lib/queue/broadcast-controls', () => ({ haltBroadcast: vi.fn() }))
vi.mock('@/lib/queue/broadcast-jobs', () => ({
  loadBroadcastRow: vi.fn(),
  resolveBroadcastChannel: vi.fn(),
  markBroadcastSending: vi.fn(),
  listPendingRecipientSlots: vi.fn(async () => []),
  loadRecipientJobContext: vi.fn(async () => ({ kind: 'ok', ctx: h.ctx })),
  markRecipientSent: vi.fn(async (id: string) => {
    h.sent.push(id)
  }),
  recordRecipientAttempt: vi.fn(),
  markRecipientFailed: vi.fn(async (id: string, attempts: number, error: string) => {
    h.failed.push({ id, attempts, error })
  }),
  finalizeBroadcastIfDone: vi.fn(async (id: string) => {
    h.finalized.push(id)
  }),
}))
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ capabilities: { needsJitter: true } }),
}))
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: vi.fn(async (id: string) => ({ id, accountId: 'acc', provider: 'waha', settings: {} })),
}))
vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  sendBroadcastRecipient: vi.fn(async (_ch: unknown, _ctx: unknown, r: unknown) => {
    h.sends.push(r)
    return { ok: true, externalMessageId: 'wamid-1' }
  }),
}))
vi.mock('@/lib/broadcasts/conversation-link', () => ({ linkBroadcastConversation: vi.fn() }))
vi.mock('@/lib/broadcasts/duplicate-sends', () => ({
  ALREADY_RECEIVED_ELSEWHERE_ERROR: 'Já recebeu esta mensagem por outro disparo nas últimas 24 h',
  contactAlreadyReceivedElsewhere: vi.fn(async (input: Record<string, unknown>) => {
    h.dupCalls.push(input)
    if (h.alreadyReceived instanceof Error) throw h.alreadyReceived
    return h.alreadyReceived
  }),
}))
vi.mock('./scheduled-message-worker', () => ({ startScheduledMessageWorker: () => ({ close: async () => {} }) }))

type Ctx = {
  broadcast: Record<string, unknown>
  channel: Record<string, unknown>
  sendContext: Record<string, unknown>
  recipient: Record<string, unknown>
}

function makeCtx(over: { broadcast?: Record<string, unknown>; recipient?: Record<string, unknown> } = {}): Ctx {
  return {
    broadcast: {
      id: 'b-pausado',
      accountId: 'acc',
      userId: 'u-vitor',
      channelId: 'ch1',
      status: 'sending',
      messageKind: 'text',
      bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
      subject: null,
      media: null,
      mediaUrl: null,
      mediaType: null,
      mediaFilename: null,
      pacing: null,
      templateName: null,
      templateLanguage: 'en_US',
      includeOptOut: true,
      allowRepeats: false,
      ...over.broadcast,
    },
    channel: { id: 'ch1', accountId: 'acc', provider: 'waha', settings: {} },
    sendContext: { messageKind: 'text', templateName: '', templateLanguage: 'en_US', templateRow: null },
    recipient: {
      id: 'r1',
      contactId: 'c-flash',
      status: 'pending',
      attempts: 0,
      phone: '5567999990001',
      params: [],
      slotAt: null,
      vars: { nome: 'Flash Baterias' },
      optedOut: false,
      hasOwnVars: false,
      ...over.recipient,
    },
  }
}

const job = { data: { broadcastId: 'b-pausado', recipientRowId: 'r1' }, token: 't', attemptsMade: 0, opts: { attempts: 3 } }

let processRecipient: (job: unknown) => Promise<void>

beforeAll(async () => {
  process.env.BROADCAST_DRY_RUN = 'false'
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await import('./broadcast-worker')
  await vi.waitFor(() => {
    expect(h.processors.has('outbound-ch1')).toBe(true)
  })
  processRecipient = h.processors.get('outbound-ch1')!
  log.mockRestore()
})

beforeEach(() => {
  h.ctx = makeCtx()
  h.alreadyReceived = false
  h.sends = []
  h.failed = []
  h.sent = []
  h.finalized = []
  h.dupCalls = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('broadcast worker — repetido na hora do envio', () => {
  it('já recebeu por outro disparo → falha com o motivo, não envia, finaliza', async () => {
    h.alreadyReceived = true
    await processRecipient(job)
    expect(h.sends).toHaveLength(0)
    expect(h.failed).toEqual([
      { id: 'r1', attempts: 1, error: 'Já recebeu esta mensagem por outro disparo nas últimas 24 h' },
    ])
    expect(h.finalized).toEqual(['b-pausado'])
    expect(h.dupCalls[0]).toMatchObject({
      accountId: 'acc',
      broadcastId: 'b-pausado',
      contactId: 'c-flash',
      messageKind: 'text',
      bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
    })
  })

  it('não recebeu → envia normalmente', async () => {
    await processRecipient(job)
    expect(h.dupCalls).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
    expect(h.sent).toEqual(['r1'])
    expect(h.failed).toHaveLength(0)
  })

  it('disparo com "enviar também pra quem já recebeu" (allowRepeats) → nem confere', async () => {
    h.alreadyReceived = true
    h.ctx = makeCtx({ broadcast: { allowRepeats: true } })
    await processRecipient(job)
    expect(h.dupCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    expect(h.failed).toHaveLength(0)
  })

  it('destinatário com mensagem própria ({{mensagem}}) fica fora da checagem', async () => {
    h.alreadyReceived = true
    h.ctx = makeCtx({ broadcast: { bodyText: '{{mensagem}}' }, recipient: { hasOwnVars: true } })
    await processRecipient(job)
    expect(h.dupCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
  })

  it('consulta falhou → segue enviando', async () => {
    h.alreadyReceived = new Error('db caiu')
    await processRecipient(job)
    expect(h.sends).toHaveLength(1)
    expect(h.failed).toHaveLength(0)
  })

  it('template: manda os valores do destinatário pra comparação', async () => {
    h.ctx = makeCtx({
      broadcast: { messageKind: 'template', bodyText: null, templateName: 'dia_do_cliente', templateLanguage: 'pt_BR' },
      recipient: { params: ['Flash Baterias'], messageParams: { headerText: 'Oi' } },
    })
    await processRecipient(job)
    expect(h.dupCalls[0]).toMatchObject({
      messageKind: 'template',
      templateName: 'dia_do_cliente',
      templateLanguage: 'pt_BR',
      params: ['Flash Baterias'],
      messageParams: { headerText: 'Oi' },
    })
  })
})

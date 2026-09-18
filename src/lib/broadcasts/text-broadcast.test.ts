import { beforeEach, describe, expect, it, vi } from 'vitest'

// 15/09 (GoLink): o Vitor refez o "dia do cliente" e a mesma imagem chegou 2×
// pra várias empresas. Aqui só o miolo do enqueueTextBroadcast: quem já
// recebeu sai da lista antes de gravar. Banco, canal e fila são stubs.
const h = vi.hoisted(() => ({
  contacts: [] as { id: string; phone: string | null; email: string | null }[],
  broadcastValues: [] as Record<string, unknown>[],
  recipientRows: [] as { contactId: string }[],
  dispatched: [] as string[],
  dupResult: [] as { contactId: string; name: string | null; lastSentAt: string }[],
  dupError: null as Error | null,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const rowsPromise = (rows: unknown[]) => ({
    then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
  })
  const db = {
    select: () => ({
      from: () => ({ where: () => rowsPromise(h.contacts) }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === actual.broadcasts) {
          h.broadcastValues.push(values as Record<string, unknown>)
          return { returning: async () => [{ id: 'b-new' }] }
        }
        if (table === actual.broadcastRecipients) {
          h.recipientRows.push(...(values as { contactId: string }[]))
        }
        return rowsPromise([])
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/channels/channels', () => ({
  loadChannel: vi.fn(async (id: string) => ({ id, accountId: 'acc', provider: 'waha', settings: {} })),
}))
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ capabilities: { needsJitter: true } }),
}))
vi.mock('@/lib/queue/queues', () => ({
  enqueueBroadcastDispatch: vi.fn(async (id: string) => {
    h.dispatched.push(id)
  }),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  resolveOrCreateContactIdsByPhone: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/broadcasts/duplicate-sends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/broadcasts/duplicate-sends')>()
  return {
    ...actual,
    findRecentDuplicateContacts: vi.fn(async () => {
      if (h.dupError) throw h.dupError
      return h.dupResult
    }),
  }
})

import { findRecentDuplicateContacts } from '@/lib/broadcasts/duplicate-sends'
import { enqueueTextBroadcast } from './text-broadcast'

const base = {
  channelId: 'ch-vitor',
  bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
  sendNow: true,
  recipientContactIds: ['c1', 'c2', 'c3'],
}

beforeEach(() => {
  h.contacts = [
    { id: 'c1', phone: '5567999990001', email: null },
    { id: 'c2', phone: '5567999990002', email: null },
    { id: 'c3', phone: '5567999990003', email: null },
  ]
  h.broadcastValues = []
  h.recipientRows = []
  h.dispatched = []
  h.dupResult = []
  h.dupError = null
})

describe('enqueueTextBroadcast — envios repetidos', () => {
  it('tira quem já recebeu e devolve a lista de pulados', async () => {
    h.dupResult = [{ contactId: 'c2', name: 'Pisos Modelo', lastSentAt: '2026-09-15T12:55:00.000Z' }]
    const res = await enqueueTextBroadcast('acc', 'u-vitor', base)
    expect(res.error).toBeNull()
    expect(res.broadcastId).toBe('b-new')
    expect(res.totalRecipients).toBe(2)
    expect(res.skippedDuplicates).toEqual(h.dupResult)
    expect(h.recipientRows.map((r) => r.contactId)).toEqual(['c1', 'c3'])
    expect(h.broadcastValues[0].totalRecipients).toBe(2)
    expect(h.dispatched).toEqual(['b-new'])
    expect(findRecentDuplicateContacts).toHaveBeenCalledWith('acc', ['c1', 'c2', 'c3'], {
      bodyText: base.bodyText,
      mediaFilenames: [],
      subject: null,
      emailChannel: false,
    })
  })

  it('todos já receberam → erro com a lista, sem gravar nem enfileirar', async () => {
    h.dupResult = ['c1', 'c2', 'c3'].map((contactId) => ({
      contactId,
      name: null,
      lastSentAt: '2026-09-15T12:55:00.000Z',
    }))
    const res = await enqueueTextBroadcast('acc', 'u-vitor', base)
    expect(res.broadcastId).toBeNull()
    expect(res.error).toBe('Todos os 3 contatos já receberam esta mensagem nas últimas 24 h.')
    expect(res.skippedDuplicates).toHaveLength(3)
    expect(h.broadcastValues).toHaveLength(0)
    expect(h.recipientRows).toHaveLength(0)
    expect(h.dispatched).toHaveLength(0)
  })

  it('"enviar mesmo assim" (skipRecentDuplicates=false) não consulta e grava allowRepeats', async () => {
    const res = await enqueueTextBroadcast('acc', 'u-vitor', { ...base, skipRecentDuplicates: false })
    expect(res.totalRecipients).toBe(3)
    expect(findRecentDuplicateContacts).not.toHaveBeenCalled()
    // Revisão 15/09: a escolha fica no disparo pro worker não conferir de novo.
    expect(h.broadcastValues[0].allowRepeats).toBe(true)
  })

  it('padrão (confere repetidos) grava allowRepeats=false — o worker confere na hora', async () => {
    await enqueueTextBroadcast('acc', 'u-vitor', base)
    expect(h.broadcastValues[0].allowRepeats).toBe(false)
    await enqueueTextBroadcast('acc', 'u-vitor', { ...base, skipRecentDuplicates: true })
    expect(h.broadcastValues[1].allowRepeats).toBe(false)
  })

  it('e-mail: manda o assunto pra checagem (assunto diferente não é repetido)', async () => {
    const { loadChannel } = await import('@/lib/channels/channels')
    vi.mocked(loadChannel).mockResolvedValueOnce({
      id: 'ch-mail',
      accountId: 'acc',
      provider: 'email',
      settings: {},
    } as unknown as Awaited<ReturnType<typeof loadChannel>>)
    h.contacts = [{ id: 'c1', phone: null, email: 'a@b.com' }]
    await enqueueTextBroadcast('acc', 'u-vitor', {
      ...base,
      channelId: 'ch-mail',
      bodyText: 'Segue em anexo.',
      subject: '  Boleto de setembro ',
      recipientContactIds: ['c1'],
    })
    expect(findRecentDuplicateContacts).toHaveBeenCalledWith('acc', ['c1'], {
      bodyText: 'Segue em anexo.',
      mediaFilenames: [],
      subject: 'Boleto de setembro',
      emailChannel: true,
    })
  })

  // Conferência 15/09: o formulário guardava o assunto ao trocar de e-mail pra WhatsApp.
  it('WhatsApp: assunto que sobrou não vai pra checagem nem pro disparo', async () => {
    await enqueueTextBroadcast('acc', 'u-vitor', { ...base, subject: 'Boleto de setembro' })
    expect(findRecentDuplicateContacts).toHaveBeenCalledWith(
      'acc',
      expect.any(Array),
      expect.objectContaining({ subject: null, emailChannel: false }),
    )
    expect(h.broadcastValues[0].subject).toBeNull()
  })

  it('mensagem por pessoa ("Chamar de volta", recipientVars) não é comparada', async () => {
    const res = await enqueueTextBroadcast('acc', 'u-ia', {
      ...base,
      bodyText: '{{mensagem}}',
      recipientVars: { c1: { mensagem: 'Oi A' }, c2: { mensagem: 'Oi B' }, c3: { mensagem: 'Oi C' } },
    })
    expect(res.totalRecipients).toBe(3)
    expect(findRecentDuplicateContacts).not.toHaveBeenCalled()
  })

  it('checagem falhou → segue mandando pra todos', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.dupError = new Error('db caiu')
    const res = await enqueueTextBroadcast('acc', 'u-vitor', base)
    expect(res.error).toBeNull()
    expect(res.totalRecipients).toBe(3)
    expect(res.skippedDuplicates).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('só imagem: compara pelo nome do arquivo (a URL muda a cada upload)', async () => {
    await enqueueTextBroadcast('acc', 'u-vitor', {
      ...base,
      bodyText: '',
      media: [{ url: 'https://crm/api/files/media/9f1c-uuid.jpeg', type: 'image', filename: 'Dia do Cliente.jpeg' }],
    })
    expect(findRecentDuplicateContacts).toHaveBeenCalledWith('acc', ['c1', 'c2', 'c3'], {
      bodyText: null,
      mediaFilenames: ['dia do cliente.jpeg'],
      subject: null,
      emailChannel: false,
    })
  })
})

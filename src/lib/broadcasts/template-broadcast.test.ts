import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09 (envios repetidos, template): repetido só se nome + idioma E
// os valores que a pessoa vê baterem; a checagem roda depois de montar os
// valores de cada um; quem está na fila de um disparo ativo conta; a escolha
// "enviar mesmo assim" fica em broadcasts.allow_repeats. Banco, canal, fila e
// template são stubs; cada select devolve a próxima resposta da fila.
const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  selectCalls: 0,
  broadcastValues: [] as Record<string, unknown>[],
  recipientRows: [] as { contactId: string; params: unknown; messageParams: unknown }[],
  dispatched: [] as string[],
  failSelectAt: -1,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = (rows: unknown[], fail: boolean) => {
    const p: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy']) p[m] = () => p
    p.then = (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
      (fail ? Promise.reject(new Error('db caiu')) : Promise.resolve(rows)).then(res, rej)
    return p
  }
  const db = {
    select: () => {
      const i = h.selectCalls++
      return chain(h.results[i] ?? [], i === h.failSelectAt)
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === actual.broadcasts) {
          h.broadcastValues.push(values as Record<string, unknown>)
          return { returning: async () => [{ id: 'b-new' }] }
        }
        if (table === actual.broadcastRecipients) {
          h.recipientRows.push(...(values as typeof h.recipientRows))
        }
        return Promise.resolve([])
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/channels/channels', () => ({
  loadChannel: vi.fn(async (id: string) => ({ id, accountId: 'acc', provider: 'meta', settings: {} })),
}))
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ capabilities: { templates: true }, sendTemplate: vi.fn() }),
}))
vi.mock('@/lib/queue/queues', () => ({
  enqueueBroadcastDispatch: vi.fn(async (id: string) => {
    h.dispatched.push(id)
  }),
}))
vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  BroadcastError: class BroadcastError extends Error {
    code = 'x'
  },
  loadBroadcastTemplateRow: vi.fn(async () => ({
    status: 'APPROVED',
    body_text: 'Olá {{1}}, feliz dia do cliente!',
    header_type: 'image',
    header_content: null,
    buttons: [],
  })),
}))

import { enqueueTemplateBroadcast, findRecentTemplateRecipients } from './template-broadcast'

const contactsRows = [
  { id: 'c1', name: 'Flash Baterias', phone: '5567999990001', email: null, company: null },
  { id: 'c2', name: 'Piso Decor', phone: '5567999990002', email: null, company: null },
  // sem nome: {{1}} fica vazio (sem "Se faltar") — barraria o disparo
  { id: 'c3', name: null, phone: '5567999990003', email: null, company: null },
]

const base = {
  channelId: 'ch-meta',
  templateName: 'dia_do_cliente',
  templateLanguage: 'pt_BR',
  mapping: {
    variables: { '1': { source: 'name' as const } },
    headerMediaUrl: 'https://crm/api/files/media/novo-upload.jpg',
  },
  recipientContactIds: ['c1', 'c2', 'c3'],
}

const sentRow = (contactId: string, params: string[], extra: Record<string, unknown> = {}) => ({
  contactId,
  name: null,
  status: 'delivered',
  sentAt: '2026-09-15 12:50:04+00',
  queuedAt: '2026-09-15 12:50:00+00',
  params,
  messageParams: { headerMediaUrl: 'https://crm/api/files/media/upload-antigo.jpg' },
  ...extra,
})

beforeEach(() => {
  h.results = []
  h.selectCalls = 0
  h.broadcastValues = []
  h.recipientRows = []
  h.dispatched = []
  h.failSelectAt = -1
})

describe('enqueueTemplateBroadcast — envios repetidos', () => {
  it('template com valores diferentes não barra; mesmos valores e fila ativa ficam de fora', async () => {
    h.results = [
      contactsRows,
      [
        // mesmo template, mesmo {{1}}, arquivo do cabeçalho subido de novo → repetido
        sentRow('c1', ['Flash Baterias']),
        // mesmo template, {{1}} diferente → outra mensagem
        sentRow('c2', ['Piso Decor Ltda']),
        // na fila de um disparo ativo com os mesmos valores (vazio)
        sentRow('c3', [''], { status: 'pending', sentAt: null, messageParams: null }),
      ],
    ]
    const res = await enqueueTemplateBroadcast('acc', 'u-vitor', base)
    expect(res.error).toBeNull()
    expect(res.broadcastId).toBe('b-new')
    expect(res.totalRecipients).toBe(1)
    expect(res.skippedDuplicates).toEqual([
      { contactId: 'c1', name: null, lastSentAt: '2026-09-15T12:50:04.000Z', reason: 'same_template' },
      { contactId: 'c3', name: null, lastSentAt: '2026-09-15T12:50:00.000Z', reason: 'queued' },
    ])
    // c3 (sem nome) ficou de fora por repetido e NÃO barrou o disparo por valor faltando
    expect(h.recipientRows.map((r) => r.contactId)).toEqual(['c2'])
    expect(h.recipientRows[0].params).toEqual(['Piso Decor'])
    expect(h.broadcastValues[0].allowRepeats).toBe(false)
    expect(h.dispatched).toEqual(['b-new'])
  })

  it('todos já receberam → erro, sem gravar', async () => {
    h.results = [
      contactsRows.slice(0, 2),
      [sentRow('c1', ['Flash Baterias']), sentRow('c2', ['Piso Decor'])],
    ]
    const res = await enqueueTemplateBroadcast('acc', 'u-vitor', { ...base, recipientContactIds: ['c1', 'c2'] })
    expect(res.broadcastId).toBeNull()
    expect(res.error).toBe('Todos os 2 contatos já receberam esta mensagem nas últimas 24 h.')
    expect(res.skippedDuplicates).toHaveLength(2)
    expect(h.broadcastValues).toHaveLength(0)
    expect(h.dispatched).toHaveLength(0)
  })

  it('"enviar mesmo assim": não consulta e grava allowRepeats=true', async () => {
    h.results = [contactsRows.slice(0, 2)]
    const res = await enqueueTemplateBroadcast('acc', 'u-vitor', {
      ...base,
      recipientContactIds: ['c1', 'c2'],
      skipRecentDuplicates: false,
    })
    expect(res.totalRecipients).toBe(2)
    expect(h.selectCalls).toBe(1)
    expect(h.broadcastValues[0].allowRepeats).toBe(true)
  })

  it('valor faltando em quem vai receber continua barrando', async () => {
    h.results = [contactsRows, []]
    const res = await enqueueTemplateBroadcast('acc', 'u-vitor', base)
    expect(res.broadcastId).toBeNull()
    expect(res.error).toContain('1 lead está sem')
    expect(h.broadcastValues).toHaveLength(0)
  })

  it('checagem falhou → segue mandando', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.results = [contactsRows.slice(0, 2)]
    h.failSelectAt = 1
    const res = await enqueueTemplateBroadcast('acc', 'u-vitor', { ...base, recipientContactIds: ['c1', 'c2'] })
    expect(res.error).toBeNull()
    expect(res.totalRecipients).toBe(2)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('findRecentTemplateRecipients', () => {
  it('sem destinatários → [] sem consultar', async () => {
    expect(await findRecentTemplateRecipients('acc', [], 'dia_do_cliente', 'pt_BR')).toEqual([])
    expect(h.selectCalls).toBe(0)
  })

  it('cabeçalho de texto e botão também decidem', async () => {
    h.results = [
      [
        sentRow('c1', ['A'], { messageParams: { headerText: 'Oi', buttonParams: { 0: 'cupom10' } } }),
        sentRow('c2', ['B'], { messageParams: { headerText: 'Oi', buttonParams: { 0: 'cupom20' } } }),
      ],
    ]
    const out = await findRecentTemplateRecipients(
      'acc',
      [
        { contactId: 'c1', params: ['A'], messageParams: { headerText: 'Oi', buttonParams: { 0: 'cupom10' } } },
        { contactId: 'c2', params: ['B'], messageParams: { headerText: 'Oi', buttonParams: { 0: 'cupom10' } } },
      ],
      'dia_do_cliente',
      'pt_BR',
    )
    expect(out.map((d) => [d.contactId, d.reason])).toEqual([['c1', 'same_template']])
  })
})

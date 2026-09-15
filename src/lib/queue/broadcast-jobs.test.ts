import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09 (envios repetidos): o worker precisa saber, do banco, se o
// disparo aceita repetido (allow_repeats) e se o destinatário tem mensagem
// própria (vars) — os dois decidem se ele confere "já recebeu por outro
// disparo" na hora do envio. Cada select devolve a próxima resposta da fila.
const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  selectCalls: 0,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = (rows: unknown[]) => {
    const p: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy']) p[m] = () => p
    p.then = (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej)
    return p
  }
  const db = {
    select: () => chain(h.results[h.selectCalls++] ?? []),
  }
  return { ...actual, db }
})
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: vi.fn(async (id: string) => ({ id, accountId: 'acc', provider: 'waha', settings: {} })),
  loadDefaultChannel: vi.fn(async () => null),
}))
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ loadBroadcastTemplateRow: vi.fn(async () => null) }))

import { loadRecipientJobContext } from './broadcast-jobs'

const recipientRow = (vars: unknown) => ({
  id: 'r1',
  broadcastId: 'b1',
  contactId: 'c1',
  status: 'pending',
  attempts: 0,
  params: [],
  messageParams: null,
  extraVars: vars,
  slotAt: null,
  phone: '5567999990001',
  contactName: 'Flash Baterias',
  contactEmail: null,
  contactCompany: null,
  optedOut: false,
})

const broadcastRow = (allowRepeats: boolean) => ({
  id: 'b1',
  accountId: 'acc',
  userId: 'u1',
  channelId: 'ch1',
  status: 'sending',
  messageKind: 'text',
  bodyText: 'Oi',
  subject: null,
  media: null,
  mediaUrl: null,
  mediaType: null,
  mediaFilename: null,
  pacing: null,
  templateName: null,
  templateLanguage: 'en_US',
  includeOptOut: true,
  allowRepeats,
})

beforeEach(() => {
  h.results = []
  h.selectCalls = 0
})

describe('loadRecipientJobContext — dados da checagem de repetido', () => {
  it('leva allowRepeats do disparo e hasOwnVars=false sem vars', async () => {
    h.results = [[recipientRow(null)], [broadcastRow(true)]]
    const loaded = await loadRecipientJobContext('r1')
    if (loaded.kind !== 'ok') throw new Error(`esperava ok, veio ${loaded.kind}`)
    expect(loaded.ctx.broadcast.allowRepeats).toBe(true)
    expect(loaded.ctx.recipient.hasOwnVars).toBe(false)
    // tokens do contato continuam nas vars (não contam como mensagem própria)
    expect(Object.keys(loaded.ctx.recipient.vars).length).toBeGreaterThan(0)
  })

  it('{{mensagem}} do "Chamar de volta" → hasOwnVars=true; objeto vazio não conta', async () => {
    h.results = [[recipientRow({ mensagem: 'Oi Flash, sumiu!' })], [broadcastRow(false)]]
    const withVars = await loadRecipientJobContext('r1')
    if (withVars.kind !== 'ok') throw new Error('esperava ok')
    expect(withVars.ctx.recipient.hasOwnVars).toBe(true)
    expect(withVars.ctx.broadcast.allowRepeats).toBe(false)

    h.selectCalls = 0
    h.results = [[recipientRow({})], [broadcastRow(false)]]
    const empty = await loadRecipientJobContext('r1')
    if (empty.kind !== 'ok') throw new Error('esperava ok')
    expect(empty.ctx.recipient.hasOwnVars).toBe(false)
  })
})

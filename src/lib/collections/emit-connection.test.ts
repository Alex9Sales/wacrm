import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// createChargeForContact — trava do documento + conta do Asaas (15/09).
// Banco e Asaas falsificados: aqui interessa a DECISÃO (qual conta, recusa,
// troca, nenhuma escrita no Asaas), não o SQL nem o HTTP.
// ============================================================

type Conn = { id: string; label: string; environment: string; createdAt: string; apiKeyEnc: string; enabled: boolean; accountId: string }
type Customer = { id: string; cpfCnpj?: string | null }

const state = vi.hoisted(() => ({
  contact: null as null | { name: string | null; phone: string | null; email: string | null },
  conns: [] as Conn[],
  history: [] as { connectionId: string; label: string; enabled: boolean; environment: string; charges: number; lastAt: string | null }[],
  wallet: [] as { doc: string | null; customerName: string | null }[],
  recent: [] as { id: string; value: string; createdAt: string; open: boolean; invoiceUrl: string | null; connectionId: string }[],
  /** Cliente reencontrado por apiKey (findCustomer na conta escolhida). */
  foundByKey: {} as Record<string, Customer | undefined>,
  /** Cliente achado pela consulta por documento por apiKey (salvaguarda). */
  byDocByKey: {} as Record<string, Customer | undefined>,
  lookupThrows: {} as Record<string, boolean>,
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  notes: [] as string[],
}))

/** Todos os valores simples dentro de uma condição do Drizzle (para saber qual conexão a query filtrou). */
function sqlValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node == null) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) sqlValues(n, out)
    return out
  }
  if (typeof node === 'object') {
    const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown }
    if (o.queryChunks) sqlValues(o.queryChunks, out)
    else if ('encoder' in o && 'value' in o) sqlValues(o.value, out)
  }
  return out
}

vi.mock('@/db', () => {
  const table = (name: string) =>
    new Proxy({ __table: name } as Record<string, unknown>, {
      get: (t, p) => (p in t ? t[p as string] : { __col: `${name}.${String(p)}` }),
    })
  const route = (q: { fields: Record<string, unknown>; table: string; where: unknown }) => {
    if (q.table === 'contacts') return state.contact ? [state.contact] : []
    if (q.table === 'asaasCharges' && 'doc' in q.fields) return state.wallet
    if (q.table === 'asaasCharges' && 'invoiceUrl' in q.fields) {
      const vals = sqlValues(q.where)
      return state.recent.filter((r) => vals.includes(r.connectionId))
    }
    return []
  }
  const select = (fields: Record<string, unknown> = {}) => {
    const q = { fields, table: '', where: undefined as unknown }
    const c: Record<string, unknown> = {}
    c.from = (t: { __table: string }) => ((q.table = t.__table), c)
    c.innerJoin = () => c
    c.where = (w: unknown) => ((q.where = w), c)
    c.orderBy = () => c
    c.groupBy = () => c
    c.limit = () => c
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(route(q)).then(res, rej)
    return c
  }
  const insert = (t: { __table: string }) => ({
    values: (values: Record<string, unknown>) => {
      state.inserts.push({ table: t.__table, values })
      const ret = { returning: async () => [{ id: 'row-1' }] }
      return { ...ret, onConflictDoNothing: () => ret, onConflictDoUpdate: async () => [] }
    },
  })
  return {
    db: { select, insert },
    asaasCharges: table('asaasCharges'),
    asaasConnections: table('asaasConnections'),
    contactCustomValues: table('contactCustomValues'),
    contacts: table('contacts'),
    customFields: table('customFields'),
    member: table('member'),
    messages: table('messages'),
  }
})

vi.mock('@/db/helpers', () => ({ firstOrNull: <T,>(rows: T[]) => rows[0] ?? null }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }))
vi.mock('@/lib/ai/close-actions', () => ({
  postInternalNote: vi.fn(async (n: { text: string }) => {
    state.notes.push(n.text)
    return true
  }),
}))
vi.mock('@/lib/orchestration/actions', () => ({ notifyUsers: vi.fn(async () => {}) }))
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: vi.fn(async () => ({ collections: {} })) }))

vi.mock('@/lib/asaas/collections', () => {
  class AsaasApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  }
  class AsaasDocumentRequiredError extends AsaasApiError {
    constructor() {
      super('Para gerar cobrança no Asaas de produção é preciso o CPF ou CNPJ do cliente.', 0)
    }
  }
  return {
    AsaasApiError,
    AsaasDocumentRequiredError,
    findCustomer: vi.fn(async (cred: { apiKey: string }) => state.foundByKey[cred.apiKey] ?? null),
    findCustomerByDocument: vi.fn(async (cred: { apiKey: string }) => {
      if (state.lookupThrows[cred.apiKey]) throw new AsaasApiError('O Asaas demorou demais para responder. Nada foi alterado.', 0)
      return state.byDocByKey[cred.apiKey] ?? null
    }),
    findOrCreateCustomer: vi.fn(async (cred: { apiKey: string }, input: { cpfCnpj?: string | null }, opts: { existing?: Customer | null } = {}) =>
      opts.existing ?? { id: `cus_novo_${cred.apiKey}`, cpfCnpj: input.cpfCnpj ?? null },
    ),
    createPayment: vi.fn(async (cred: { apiKey: string }, input: { customer: string; value: number }) => ({
      id: 'pay_1',
      customer: input.customer,
      value: input.value,
      status: 'PENDING',
      billingType: 'UNDEFINED',
      invoiceUrl: `https://asaas/i/${cred.apiKey}`,
    })),
    createSubscription: vi.fn(),
    listSubscriptionPayments: vi.fn(async () => []),
  }
})

vi.mock('./connection-pick', async (importOriginal) => {
  const real = await importOriginal<typeof import('./connection-pick')>()
  return {
    ...real,
    enabledConnectionsOf: vi.fn(async () => state.conns),
    connectionHistoryFor: vi.fn(async () => state.history),
  }
})

const collections = await import('@/lib/asaas/collections')
const { createChargeForContact } = await import('./emit')

const CNPJ = '11222333000181'
const A: Conn = { id: 'c-asaas', label: 'Asaas', environment: 'production', createdAt: '2026-09-10T00:18:57Z', apiKeyEnc: 'key-asaas', enabled: true, accountId: 'acc' }
const G: Conn = { id: 'c-golink', label: 'AsaasGoLink', environment: 'production', createdAt: '2026-09-10T00:19:30Z', apiKeyEnc: 'key-golink', enabled: true, accountId: 'acc' }

const base = (over: Partial<Parameters<typeof createChargeForContact>[0]> = {}) => ({
  accountId: 'acc',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  connectionId: null as string | null,
  value: 150,
  dueDate: '2026-09-20',
  description: 'Mensalidade',
  origin: 'manual' as const,
  actorLabel: 'por Alex',
  cpfCnpj: CNPJ,
  ...over,
})

const m = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  state.contact = { name: 'Tio Burguer', phone: '5567999991234', email: null }
  state.conns = [A, G]
  state.history = []
  state.wallet = []
  state.recent = []
  state.foundByKey = {}
  state.byDocByKey = {}
  state.lookupThrows = {}
  state.inserts = []
  state.notes = []
})
afterEach(() => vi.restoreAllMocks())

describe('conta do Asaas — salvaguarda só quando o cliente não existe na escolhida', () => {
  it('(1) cliente achado na conta escolhida → nenhuma consulta na outra e nenhum cadastro novo', async () => {
    state.foundByKey['key-asaas'] = { id: 'cus_a', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out.ok).toBe(true)
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
    const [cred, , opts] = m(collections.findOrCreateCustomer).mock.calls[0]
    expect(cred.apiKey).toBe('key-asaas')
    expect(opts.existing).toEqual({ id: 'cus_a', cpfCnpj: CNPJ })
    if (out.ok) expect(out.connectionId).toBe(A.id)
  })

  it('(2) não achado + CPF na outra conta + conta ESCOLHIDA na tela → recusa com otherConnection, nada criado', async () => {
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: false, otherConnection: { id: G.id, label: 'AsaasGoLink' } })
    if (!out.ok) expect(out.reason).toBe('este cliente já está cadastrado na conta AsaasGoLink do Asaas, não na Asaas. Nada foi criado')
    expect(m(collections.findOrCreateCustomer)).not.toHaveBeenCalled()
    expect(m(collections.createPayment)).not.toHaveBeenCalled()
    expect(state.inserts.filter((i) => i.table === 'asaasCharges')).toHaveLength(0)
  })

  it('(3) mesmo cenário sem conta escolhida (IA/dono) → gera na conta do cliente e diz na nota', async () => {
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: null, origin: 'ai', actorLabel: 'pela IA' }))
    expect(out).toMatchObject({ ok: true, connectionId: G.id, connectionLabel: 'AsaasGoLink', switchedToHome: true })
    expect(m(collections.createPayment).mock.calls[0][0].apiKey).toBe('key-golink')
    const [cred, , opts] = m(collections.findOrCreateCustomer).mock.calls[0]
    expect(cred.apiKey).toBe('key-golink')
    expect(opts.existing).toEqual({ id: 'cus_g', cpfCnpj: CNPJ })
    const row = state.inserts.find((i) => i.table === 'asaasCharges')
    expect(row?.values.connectionId).toBe(G.id)
    expect(state.notes.some((n) => n.includes('conta AsaasGoLink (o cliente já era cadastrado nessa conta).'))).toBe(true)
  })

  // Revisão 15/09: órfão sem CPF na conta escolhida não pode desligar a salvaguarda.
  it('(3b) órfão SEM documento na escolhida + cliente na outra → recusa (tela) e troca (IA), sem adotar o órfão', async () => {
    state.foundByKey['key-asaas'] = { id: 'cus_o', cpfCnpj: null }
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const tela = await createChargeForContact(base({ connectionId: A.id }))
    expect(tela).toMatchObject({ ok: false, otherConnection: { id: G.id, label: 'AsaasGoLink' } })
    expect(m(collections.findOrCreateCustomer)).not.toHaveBeenCalled()

    const ia = await createChargeForContact(base({ connectionId: null, origin: 'ai', actorLabel: 'pela IA' }))
    expect(ia).toMatchObject({ ok: true, connectionId: G.id, switchedToHome: true })
    const [cred, , opts] = m(collections.findOrCreateCustomer).mock.calls[0]
    expect(cred.apiKey).toBe('key-golink')
    expect(opts.existing).toEqual({ id: 'cus_g', cpfCnpj: CNPJ })
  })

  it('(3c) órfão SEM documento e cliente em nenhuma outra conta → adota o órfão na escolhida', async () => {
    state.foundByKey['key-asaas'] = { id: 'cus_o', cpfCnpj: null }
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    const [cred, , opts] = m(collections.findOrCreateCustomer).mock.calls[0]
    expect(cred.apiKey).toBe('key-asaas')
    expect(opts.existing).toEqual({ id: 'cus_o', cpfCnpj: null })
  })

  it('(4) allowNewCustomerHere → cria na escolhida sem consultar a outra', async () => {
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: A.id, allowNewCustomerHere: true }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
    const [cred, , opts] = m(collections.findOrCreateCustomer).mock.calls[0]
    expect(cred.apiKey).toBe('key-asaas')
    expect(opts.existing).toBeNull()
  })

  it('(5) consulta na outra conta falha → segue na escolhida (fail-open) com aviso no log', async () => {
    state.lookupThrows['key-golink'] = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[cobranca] conferir cliente na conta AsaasGoLink falhou'), expect.anything())
  })

  it('(6) outra conexão é sandbox e a escolhida produção → ignorada', async () => {
    state.conns = [A, { ...G, environment: 'sandbox' }]
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
  })

  it('(7) histórico local na outra conta → decide sem consultar o Asaas (escolhida → recusa)', async () => {
    state.history = [{ connectionId: G.id, label: G.label, enabled: true, environment: 'production', charges: 3, lastAt: '2026-09-11' }]
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: false, otherConnection: { id: G.id, label: 'AsaasGoLink' } })
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
  })

  it('(7b) sandbox sem documento e sem histórico → nenhuma consulta extra, cria na 1ª conta', async () => {
    state.conns = [{ ...A, environment: 'sandbox' }, { ...G, environment: 'sandbox' }]
    const out = await createChargeForContact(base({ cpfCnpj: null }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
  })

  it('(7c) cliente em 2 outras contas e ninguém escolheu → falha com motivo, nada criado', async () => {
    const Z: Conn = { ...G, id: 'c-zeta', label: 'Zeta', apiKeyEnc: 'key-zeta', createdAt: '2026-09-11T00:00:00Z' }
    state.conns = [A, G, Z]
    state.byDocByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    state.byDocByKey['key-zeta'] = { id: 'cus_z', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: null }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('mais de uma conta do Asaas (AsaasGoLink e Zeta)')
      expect(out.otherConnection).toBeUndefined()
    }
    expect(m(collections.createPayment)).not.toHaveBeenCalled()
  })

  it('(8) duplicata de 6h em OUTRA conta não reaproveita o link; na mesma, reaproveita', async () => {
    state.foundByKey['key-asaas'] = { id: 'cus_a', cpfCnpj: CNPJ }
    const now = new Date().toISOString()
    state.recent = [{ id: 'r-g', value: '150', createdAt: now, open: true, invoiceUrl: 'https://asaas/i/antigo-g', connectionId: G.id }]
    const out = await createChargeForContact(base({ connectionId: A.id }))
    expect(out).toMatchObject({ ok: true, reused: false, invoiceUrl: 'https://asaas/i/key-asaas' })

    vi.clearAllMocks()
    state.recent = [{ id: 'r-a', value: '150', createdAt: now, open: true, invoiceUrl: 'https://asaas/i/antigo-a', connectionId: A.id }]
    const again = await createChargeForContact(base({ connectionId: A.id }))
    expect(again).toMatchObject({ ok: true, reused: true, invoiceUrl: 'https://asaas/i/antigo-a', connectionId: A.id })
    expect(m(collections.createPayment)).not.toHaveBeenCalled()
    expect(m(collections.findCustomer)).not.toHaveBeenCalled()
  })

  it('sem conta escolhida, o histórico do cliente decide a conta (não a mais antiga)', async () => {
    state.history = [{ connectionId: G.id, label: G.label, enabled: true, environment: 'production', charges: 1, lastAt: '2026-09-11' }]
    state.foundByKey['key-golink'] = { id: 'cus_g', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ connectionId: null }))
    expect(out).toMatchObject({ ok: true, connectionId: G.id })
    if (out.ok) expect(out.switchedToHome).toBeUndefined()
    expect(m(collections.findCustomerByDocument)).not.toHaveBeenCalled()
  })
})

describe('trava do documento — recusa ANTES de qualquer chamada ao Asaas', () => {
  const noAsaas = () => {
    for (const fn of ['findCustomer', 'findCustomerByDocument', 'findOrCreateCustomer', 'createPayment', 'createSubscription'] as const) {
      expect(m(collections[fn]), fn).not.toHaveBeenCalled()
    }
  }

  it('produção sem documento em lugar nenhum → needsDocument, nada no Asaas', async () => {
    const out = await createChargeForContact(base({ cpfCnpj: null }))
    expect(out).toMatchObject({ ok: false, needsDocument: true })
    if (!out.ok) expect(out.reason).toBe('falta o CPF ou CNPJ do cliente (o Asaas de produção não gera cobrança sem ele)')
    noAsaas()
  })

  it('documento digitado inválido → invalidDocument, sem cair no documento da carteira', async () => {
    state.wallet = [{ doc: CNPJ, customerName: 'Tio Burguer Lanches' }]
    const out = await createChargeForContact(base({ cpfCnpj: '529.982.247-26' }))
    expect(out).toMatchObject({ ok: false, needsDocument: true, invalidDocument: true })
    noAsaas()
  })

  it('sem digitado, o documento da carteira vale (e vai para a busca do cliente)', async () => {
    state.wallet = [{ doc: '11.222.333/0001-81', customerName: 'Tio Burguer Lanches' }]
    state.conns = [A]
    state.foundByKey['key-asaas'] = { id: 'cus_a', cpfCnpj: CNPJ }
    const out = await createChargeForContact(base({ cpfCnpj: null, connectionId: null }))
    expect(out).toMatchObject({ ok: true, connectionId: A.id })
    expect(m(collections.findCustomer).mock.calls[0][1]).toMatchObject({ cpfCnpj: CNPJ })
    expect(m(collections.findOrCreateCustomer).mock.calls[0][1]).toMatchObject({ cpfCnpj: CNPJ, requireDocument: true })
  })

  it('nenhuma conta ligada → motivo claro, nada no Asaas', async () => {
    state.conns = []
    const out = await createChargeForContact(base())
    expect(out).toMatchObject({ ok: false, reason: 'nenhuma conta do Asaas conectada em Cobranças' })
    noAsaas()
  })

  it('erro de documento lançado pelo findOrCreateCustomer (segunda defesa) vira needsDocument', async () => {
    state.conns = [A]
    m(collections.findOrCreateCustomer).mockRejectedValueOnce(new collections.AsaasDocumentRequiredError())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await createChargeForContact(base())
    expect(out).toMatchObject({ ok: false, needsDocument: true })
  })
})

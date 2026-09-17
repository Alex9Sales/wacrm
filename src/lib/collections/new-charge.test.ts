import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AsaasCustomer, AsaasPayment } from '@/lib/asaas/collections'

import { newChargesMessage } from './emit-rules'
import { queueNewChargeNotices } from './new-charge'
import { COLLECTIONS_DEFAULTS, type CollectionsSettings } from './rules'

// ------------------------------------------------------------------ dublês
// Banco e Asaas falsificados: interessa a DECISÃO da varredura (o que vira
// pedido, o que pula e por quê), não o SQL nem o HTTP.
const state = vi.hoisted(() => ({
  conns: [] as { id: string; label: string; apiKeyEnc: string; environment: string; createdAt: string }[],
  previous: [] as { payload: unknown }[],
  crmCharges: [] as { asaasId: string }[],
  crmConversationIds: [] as string[],
  fichas: [] as { id: string; name: string | null; optedOut: boolean }[],
  paused: [] as string[],
  payments: {} as Record<string, AsaasPayment[]>,
  customers: {} as Record<string, AsaasCustomer>,
  customers429: {} as Record<string, boolean>,
  flags: {} as Record<string, { enabled: boolean; email: boolean; sms: boolean; whatsapp: boolean; phoneCall: boolean }>,
  /** Registro de quando o CRM calou cada cliente (chave `${connectionId}|${customerId}`). */
  silenced: {} as Record<string, { at: string; beforeSince?: string | null; before?: string[] | null }>,
  /** Redis fora: loadSilenced devolve null. */
  silencedDown: false,
  contactOf: {} as Record<string, string>,
  linksSent: [] as string[],
  delivery: { ok: true, label: 'WhatsApp' } as { ok: true; label: string } | { ok: false; error: string },
  listCalls: [] as { apiKey: string; since: string }[],
  customerCalls: [] as string[][],
  flagCalls: [] as string[],
  fallbackEmails: [] as unknown[],
  inserts: [] as Record<string, unknown>[],
}))

vi.mock('@/db', () => {
  const table = (name: string) =>
    new Proxy({ __table: name } as Record<string, unknown>, {
      get: (t, p) => (p in t ? t[p as string] : { __col: `${name}.${String(p)}` }),
    })
  const route = (q: { fields: Record<string, unknown>; table: string }) => {
    if (q.table === 'asaasConnections') return state.conns
    if (q.table === 'agentActionRequests') return state.previous
    if (q.table === 'asaasCharges') return state.crmCharges
    if (q.table === 'conversations' && 'aiOff' in q.fields) return [{ id: 'conv-1', aiOff: false }]
    if (q.table === 'conversations') return state.crmConversationIds.map((id) => ({ id }))
    if (q.table === 'contacts' && 'name' in q.fields) return state.fichas
    if (q.table === 'collectionsTouches') return state.paused.map((contactId) => ({ contactId }))
    return []
  }
  const select = (fields: Record<string, unknown> = {}) => {
    const q = { fields, table: '' }
    const c: Record<string, unknown> = {}
    c.from = (t: { __table: string }) => ((q.table = t.__table), c)
    c.where = () => c
    c.orderBy = () => c
    c.limit = () => c
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(route(q)).then(res, rej)
    return c
  }
  const insert = () => ({
    values: (values: Record<string, unknown>) => {
      state.inserts.push(values)
      const ret = { returning: async () => [{ id: `row-${state.inserts.length}` }] }
      return { ...ret, onConflictDoNothing: () => ret }
    },
  })
  return {
    db: { select, insert },
    agentActionRequests: table('agentActionRequests'),
    asaasCharges: table('asaasCharges'),
    asaasConnections: table('asaasConnections'),
    collectionsTouches: table('collectionsTouches'),
    contacts: table('contacts'),
    conversations: table('conversations'),
    messages: table('messages'),
    organization: table('organization'),
  }
})
vi.mock('@/db/helpers', () => ({ firstOrNull: <T,>(rows: T[]) => rows[0] ?? null }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))
vi.mock('@/lib/orchestration/policy', () => ({ decide: () => ({ decision: 'auto_execute', reason: 'collect_charges=auto' }) }))
vi.mock('@/lib/asaas/collections', () => {
  class AsaasApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  }
  return {
    AsaasApiError,
    listPaymentsCreatedSince: vi.fn(async (cred: { apiKey: string }, since: string) => {
      state.listCalls.push({ apiKey: cred.apiKey, since })
      // Como o Asaas: só o que foi criado a partir do dia pedido.
      return (state.payments[cred.apiKey] ?? []).filter((p) => (p.dateCreated ?? '') >= since)
    }),
    fetchCustomers: vi.fn(async (cred: { apiKey: string }, ids: string[]) => {
      state.customerCalls.push(ids)
      if (state.customers429[cred.apiKey]) throw new AsaasApiError('O Asaas pediu para diminuir o ritmo', 429)
      return new Map(ids.filter((id) => state.customers[id]).map((id) => [id, state.customers[id]]))
    }),
    getCustomerPaymentCreatedFlags: vi.fn(async (_cred: unknown, id: string) => {
      state.flagCalls.push(id)
      return state.flags[id] ?? { enabled: false, email: false, sms: false, whatsapp: false, phoneCall: false }
    }),
  }
})
vi.mock('@/lib/asaas/sync', () => ({
  loadCustomerLinks: vi.fn(async () => new Map()),
  findContact: vi.fn(async (_acc: string, phone: string | null) => {
    const hit = Object.entries(state.contactOf).find(([cus]) => !!phone && state.customers[cus]?.mobilePhone === phone)
    return { contactId: hit ? hit[1] : null, matchedBy: hit ? 'phone' : null, ambiguous: false }
  }),
}))
vi.mock('./asaas-silenced', () => ({
  loadSilenced: vi.fn(async (pairs: { connectionId: string; customerId: string }[]) => {
    if (state.silencedDown) return null
    return new Map(pairs.map((p) => [`${p.connectionId}|${p.customerId}`, state.silenced[`${p.connectionId}|${p.customerId}`] ?? null]))
  }),
}))
vi.mock('./links-sent', () => ({
  linksAlreadySent: vi.fn(async (_acc: string, _contact: string, urls: string[]) => new Set(urls.filter((u) => state.linksSent.includes(u)))),
}))
vi.mock('./outreach', () => ({
  resolveCollectionTargets: vi.fn(async (_acc: string, _contact: string, _hint: unknown, opts: { fallbackEmail?: unknown }) => {
    state.fallbackEmails.push(opts.fallbackEmail)
    return state.delivery
  }),
}))

// Espaço fino / NBSP do toLocaleString atrapalha a leitura do teste.
const norm = (s: string) => s.replace(/ | /g, ' ')

describe('newChargesMessage — o aviso de cobrança NOVA (11/09, caso Sérgio Lemes)', () => {
  const uma = { value: 10, dueDate: '2026-09-10', description: 'Teste Asaas', url: 'https://asaas.com/i/abc' }

  it('uma cobrança sai igual ao link mandado à mão: entrega o link, não cobra', () => {
    const m = norm(newChargesMessage('Sérgio Lemes', [uma]))
    expect(m).toContain('Oi, Sérgio Lemes!')
    expect(m).toContain('R$ 10,00')
    expect(m).toContain('(Teste Asaas)')
    expect(m).toContain('vencimento em 10/09/2026')
    expect(m).toContain('https://asaas.com/i/abc')
    // É aviso, não cobrança: nada de atraso nem pressão.
    expect(m.toLowerCase()).not.toContain('atraso')
    expect(m.toLowerCase()).not.toContain('vencid')
    expect(m.toLowerCase()).not.toContain('regulariz')
  })

  it('sem nome não inventa saudação', () => {
    expect(norm(newChargesMessage(null, [uma])).startsWith('Oi! ')).toBe(true)
  })

  it('mais de uma vira uma lista só, com um link por linha', () => {
    const m = norm(
      newChargesMessage('Drogaria Imaculada', [
        uma,
        { value: 250.5, dueDate: '2026-10-01', description: '', url: 'https://asaas.com/i/def' },
      ]),
    )
    expect(m).toContain('Seguem os links para pagamento')
    expect(m).toContain('R$ 10,00 (Teste Asaas), vence 10/09/2026')
    expect(m).toContain('R$ 250,50, vence 01/10/2026')
    expect(m).toContain('https://asaas.com/i/abc')
    expect(m).toContain('https://asaas.com/i/def')
    // Uma mensagem só — não duas.
    expect(m.split('Seguem os links').length).toBe(2)
  })
})

// 17/09 (GoLink, "Mostrar valores" desligado): o aviso ignorava a opção e
// sairia com "R$". E a descrição do painel do Asaas vem num parágrafo inteiro.
describe('newChargesMessage — sem valores e descrição longa', () => {
  const alpha = { value: 189.9, dueDate: '2026-09-26', description: 'Plano Site', url: 'https://www.asaas.com/i/alpha' }
  const leva = { value: 300, dueDate: '2026-09-20', description: 'Leva Entulho 1/3', url: 'https://www.asaas.com/i/leva1' }

  it('uma cobrança sem valores: descrição, vencimento e link, nenhum R$', () => {
    const m = norm(newChargesMessage('Alpha Gás', [alpha], { showValues: false }))
    expect(m).toContain('Oi, Alpha Gás!')
    expect(m).toContain('Segue o link para pagamento (Plano Site), com vencimento em 26/09/2026:')
    expect(m).toContain('https://www.asaas.com/i/alpha')
    expect(m).not.toContain('R$')
    expect(m).not.toMatch(/189/)
  })

  it('várias sem valores continuam UMA mensagem, com um link por linha', () => {
    const m = norm(newChargesMessage(null, [leva, { ...alpha, description: '' }], { showValues: false }))
    expect(m).not.toContain('R$')
    expect(m).toContain('• Leva Entulho 1/3, vence 20/09/2026:\nhttps://www.asaas.com/i/leva1')
    expect(m).toContain('• Vence 26/09/2026:\nhttps://www.asaas.com/i/alpha')
    expect(m.split('Seguem os links').length).toBe(2)
  })

  it('descrição de 200 caracteres é cortada (com e sem valores)', () => {
    const longa = { ...alpha, description: `Contrato de manutenção ${'x'.repeat(200)}` }
    for (const showValues of [true, false]) {
      const m = norm(newChargesMessage('Alpha Gás', [longa], { showValues }))
      expect(m).not.toContain('x'.repeat(100))
      expect(m).toContain('…)')
      expect(m).toContain('https://www.asaas.com/i/alpha')
    }
  })

  it('sem a opção, igual a antes (com valores)', () => {
    expect(newChargesMessage('Alpha Gás', [alpha])).toBe(newChargesMessage('Alpha Gás', [alpha], { showValues: true }))
    expect(norm(newChargesMessage('Alpha Gás', [alpha]))).toContain('R$ 189,90 (Plano Site)')
  })
})

// ------------------------------------------------ a varredura (17/09, GoLink)
// Os casos reais de 15 a 17/09 nas duas contas do Asaas da GoLink.
describe('queueNewChargeNotices — lê no Asaas o que foi CRIADO, não a carteira de vencidas', () => {
  const url = (id: string) => `https://www.asaas.com/i/${id}`
  const pay = (over: Partial<AsaasPayment> & { id: string; customer: string }): AsaasPayment => ({
    status: 'PENDING',
    value: 150,
    dateCreated: '2026-09-15',
    dueDate: '2026-09-20',
    billingType: 'BOLETO',
    description: 'Mensalidade',
    invoiceUrl: url(over.id),
    ...over,
  })
  const CONV_CRM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const golink: CollectionsSettings = { ...COLLECTIONS_DEFAULTS, enabled: true, asaasNotificationsOff: true, showValues: false }
  // Quinta 17/09 às 10h em Brasília: a janela começa na terça 15/09.
  const NOW = new Date('2026-09-17T13:00:00Z')

  const run = (over: Partial<Parameters<typeof queueNewChargeNotices>[0]> = {}) =>
    queueNewChargeNotices({
      accountId: 'acc-golink',
      settings: golink,
      accountSettings: { autonomyPaused: false, aiMode: 'on' } as never,
      policy: {} as never,
      agentId: 'agent-1',
      budget: 10,
      alreadyQueued: new Set(),
      contactedToday: new Set(),
      usedToday: 0,
      tz: 'America/Sao_Paulo',
      now: NOW,
      ...over,
    })

  beforeEach(() => {
    state.conns = [
      { id: 'c-asaas', label: 'Asaas', apiKeyEnc: 'k1', environment: 'production', createdAt: '2026-08-01T12:00:00Z' },
      { id: 'c-golink', label: 'AsaasGoLink', apiKeyEnc: 'k2', environment: 'production', createdAt: '2026-08-01T12:00:00Z' },
      { id: 'c-sandbox', label: 'Sandbox', apiKeyEnc: 'k3', environment: 'sandbox', createdAt: '2026-08-01T12:00:00Z' },
    ]
    state.payments = {
      k1: [
        // Renovação de assinatura: nasce 39 dias antes → o lembrete D-5 cobre.
        pay({ id: 'pay_ren', customer: 'cus_ren', dateCreated: '2026-09-17', dueDate: '2026-10-26', subscription: 'sub_ren' }),
        // Pix recebido gerado automaticamente.
        pay({ id: 'pay_pix', customer: 'cus_pix', status: 'RECEIVED', billingType: 'PIX', dateCreated: '2026-09-16' }),
        // Leva Entulho 3x, criada no painel em 15/09.
        pay({ id: 'pay_leva1', customer: 'cus_leva', installment: 'ins_leva', dueDate: '2026-09-20' }),
        pay({ id: 'pay_leva2', customer: 'cus_leva', installment: 'ins_leva', dueDate: '2026-10-20' }),
        pay({ id: 'pay_leva3', customer: 'cus_leva', installment: 'ins_leva', dueDate: '2026-11-20' }),
        // Alpha Gás, assinatura nova no painel em 15/09.
        pay({ id: 'pay_alpha1', customer: 'cus_alpha', subscription: 'sub_alpha', dueDate: '2026-09-26' }),
      ],
      k2: [
        // Criadas pelo CRM: por referência (conversa) e pelo grupo de uma parcela da carteira.
        pay({ id: 'pay_crm_ref', customer: 'cus_dom', externalReference: CONV_CRM, dateCreated: '2026-09-16', dueDate: '2026-09-25' }),
        pay({ id: 'pay_crm_p1', customer: 'cus_dom', installment: 'ins_crm', dateCreated: '2026-09-16', dueDate: '2026-09-24' }),
        pay({ id: 'pay_crm_p2', customer: 'cus_dom', installment: 'ins_crm', dateCreated: '2026-09-16', dueDate: '2026-09-29' }),
        // Andressa e Convictus: o cadastro do Asaas não tem telefone.
        pay({ id: 'pay_andressa', customer: 'cus_andressa' }),
        pay({ id: 'pay_conv1', customer: 'cus_convictus', subscription: 'sub_conv', dueDate: '2026-09-20' }),
        pay({ id: 'pay_conv2', customer: 'cus_convictus', subscription: 'sub_conv', dueDate: '2026-10-20' }),
      ],
      k3: [pay({ id: 'pay_teste', customer: 'cus_leva' })],
    }
    state.customers = {
      cus_leva: { id: 'cus_leva', name: 'Leva Entulho', mobilePhone: '67990000001', email: 'financeiro@leva.com', notificationDisabled: true, dateCreated: '2025-03-01' },
      cus_alpha: { id: 'cus_alpha', name: 'Alpha Gás', mobilePhone: '67990000002', notificationDisabled: true, dateCreated: '2026-09-15' },
      cus_andressa: { id: 'cus_andressa', name: 'Fisioterapeuta Andressa Amorelli', notificationDisabled: true, dateCreated: '2026-09-15' },
      cus_convictus: { id: 'cus_convictus', name: 'Convictus Contabilidade', notificationDisabled: true, dateCreated: '2026-09-15' },
    }
    state.customers429 = {}
    state.contactOf = { cus_leva: 'ct_leva', cus_alpha: 'ct_alpha' }
    state.fichas = [
      { id: 'ct_leva', name: 'Leva', optedOut: false },
      { id: 'ct_alpha', name: 'Alpha', optedOut: false },
    ]
    state.flags = { cus_alpha: { enabled: true, email: false, sms: false, whatsapp: false, phoneCall: false } }
    // Alpha nasceu no painel em 15/09 com os avisos ligados; a varredura de 16/09
    // às 9h calou e a lista tirada logo depois tinha a pay_alpha1 (o Asaas podia
    // ter avisado). Leva é calado há meses: sem registro.
    state.silenced = { 'c-asaas|cus_alpha': { at: '2026-09-16T12:05:00Z', beforeSince: '2026-09-15', before: ['pay_alpha1'] } }
    state.silencedDown = false
    state.previous = []
    state.crmCharges = [{ asaasId: 'pay_crm_p1' }]
    state.crmConversationIds = [CONV_CRM]
    state.paused = []
    state.linksSent = []
    state.delivery = { ok: true, label: 'WhatsApp' }
    state.listCalls = []
    state.customerCalls = []
    state.flagCalls = []
    state.fallbackEmails = []
    state.inserts = []
  })

  it('dia da correção: o João já tinha mandado os links à mão → 0 mensagens, cada pulo explicado', async () => {
    state.linksSent = [url('pay_leva1'), url('pay_alpha1')]
    const r = await run()
    expect(r.queued).toBe(0)
    expect(state.inserts).toHaveLength(0)
    expect(r.skipped).toMatchObject({
      sandbox: 1,
      vence_longe: 4,
      status: 1,
      criada_pelo_crm: 3,
      sem_contato: 2,
      link_ja_enviado: 2,
    })
    // Sandbox junto com produção nunca é lido; a janela começa na terça.
    expect(state.listCalls.map((c) => c.apiKey)).toEqual(['k1', 'k2'])
    expect(state.listCalls.every((c) => c.since === '2026-09-15')).toBe(true)
    // Cadastro só de quem passou na classificação; chave de aviso só de quem ia receber.
    expect(state.customerCalls.flat().sort()).toEqual(['cus_alpha', 'cus_andressa', 'cus_convictus', 'cus_leva'])
    expect(state.flagCalls).toEqual([])
  })

  it('sem o envio à mão: Leva 1/3 e Alpha Gás recebem o link, sem valores, e ocupam o dia', async () => {
    const contactedToday = new Set<string>()
    const alreadyQueued = new Set<string>()
    const r = await run({ contactedToday, alreadyQueued })
    expect(r.queued).toBe(2)
    expect(r.found).toBe(4)
    // Vence antes, sai antes.
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_leva', 'ct_alpha'])
    const leva = state.inserts[0]
    expect(leva.payload).toMatchObject({
      kind: 'new_charge',
      asaasIds: ['pay_leva1'],
      paymentRefs: [{ asaasId: 'pay_leva1', connectionId: 'c-asaas' }],
      connectionId: 'c-asaas',
      links: [url('pay_leva1')],
      charges: 1,
      touch: 0,
      asaasEmail: 'financeiro@leva.com',
    })
    expect(leva.decision).toBe('auto')
    expect(String(leva.suggestedText)).toContain(url('pay_leva1'))
    expect(String(leva.suggestedText)).not.toContain('R$')
    expect(String(leva.suggestedText)).toContain('20/09/2026')
    expect(String(leva.reason)).toContain('30 min')
    expect((state.inserts[1].payload as Record<string, unknown>).asaasEmail).toBeUndefined()
    expect([...contactedToday].sort()).toEqual(['ct_alpha', 'ct_leva'])
    expect([...alreadyQueued].sort()).toEqual(['ct_alpha', 'ct_leva'])
    // Alpha foi calado DEPOIS da cobrança nascer: só as chaves do Asaas dizem se ele avisou. Leva é calado há tempo: sem GET.
    expect(state.flagCalls).toEqual(['cus_alpha'])
    expect(state.fallbackEmails).toEqual(['financeiro@leva.com', null])
  })

  it('uma mensagem de cobrança por pessoa por dia; o Asaas que ainda avisa não ganha segundo aviso', async () => {
    state.flags = { cus_alpha: { enabled: true, email: false, sms: true, whatsapp: false, phoneCall: false } }
    const r = await run({ contactedToday: new Set(['ct_leva']) })
    expect(r.queued).toBe(0)
    expect(r.skipped).toMatchObject({ mesmo_dia: 1, asaas_avisa: 1 })
  })

  // Revisão 17/09: o Asaas com só o e-mail ligado não entrega a quem não tem e-mail.
  it('chave de e-mail ligada num cadastro sem e-mail → o Asaas não entregou, o CRM avisa', async () => {
    state.flags = { cus_alpha: { enabled: true, email: true, sms: false, whatsapp: false, phoneCall: false } }
    const r = await run()
    expect(r.skipped.asaas_avisa).toBeUndefined()
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_leva', 'ct_alpha'])
  })

  // Revisão 17/09: a cobrança nasceu DEPOIS de a varredura calar o cliente (fora
  // da lista) → o Asaas não avisou, mesmo com as chaves ligadas; nem pergunta.
  it('cobrança criada depois de o CRM calar o cliente → avisa sem perguntar as chaves', async () => {
    state.flags = { cus_alpha: { enabled: true, email: false, sms: true, whatsapp: false, phoneCall: false } }
    state.silenced = { 'c-asaas|cus_alpha': { at: '2026-09-15T12:05:00Z', beforeSince: '2026-09-14', before: [] } }
    const r = await run()
    expect(r.skipped.asaas_avisa).toBeUndefined()
    expect(state.flagCalls).toEqual([])
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_leva', 'ct_alpha'])
  })

  it('Redis fora: sem saber quando calou, as chaves decidem (até do cliente calado há tempo)', async () => {
    state.silencedDown = true
    state.flags = { cus_alpha: { enabled: true, email: false, sms: true, whatsapp: false, phoneCall: false } }
    const r = await run()
    expect(state.flagCalls.sort()).toEqual(['cus_alpha', 'cus_leva'])
    expect(r.skipped.asaas_avisa).toBe(1)
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_leva'])
  })

  // Revisão 17/09: quem gerou o boleto num link de pagamento do Asaas já está com ele.
  it('cobrança gerada pelo cliente num link de pagamento do Asaas → não avisa', async () => {
    state.payments.k1 = state.payments.k1.map((p) => (p.id === 'pay_leva1' ? { ...p, paymentLink: 'lnk_golink' } : p))
    const r = await run()
    expect(r.skipped.gerada_pelo_cliente).toBe(1)
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_alpha'])
  })

  it('teto: sai quem vence antes, o resto conta como teto', async () => {
    const r = await run({ budget: 1 })
    expect(r.queued).toBe(1)
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_leva'])
    expect(r.skipped.teto).toBe(1)
  })

  it('já avisada e pausado não recebem; o cache do scanUpcoming poupa o GET do cliente', async () => {
    state.previous = [{ payload: { kind: 'new_charge', asaasIds: ['pay_alpha1'] } }]
    state.paused = ['ct_leva']
    const r = await run({ customers: new Map([['c-asaas', new Map([['cus_leva', state.customers.cus_leva]])]]) })
    expect(r.queued).toBe(0)
    expect(r.skipped).toMatchObject({ ja_avisado: 1, pausado: 1 })
    expect(state.customerCalls.flat()).not.toContain('cus_leva')
    expect(state.customerCalls.flat()).not.toContain('cus_alpha')
  })

  it('opt-out não recebe', async () => {
    state.fichas = state.fichas.map((f) => ({ ...f, optedOut: true }))
    const r = await run()
    expect(r.queued).toBe(0)
    expect(r.skipped.opt_out).toBe(2)
  })

  it('429 ao abrir os clientes de uma conta não derruba a rodada: a outra conta segue', async () => {
    state.customers429 = { k1: true }
    state.contactOf = { ...state.contactOf, cus_andressa: 'ct_andressa' }
    state.customers.cus_andressa = { ...state.customers.cus_andressa, mobilePhone: '67990000003', dateCreated: '2025-01-01' }
    state.fichas = [...state.fichas, { id: 'ct_andressa', name: 'Andressa', optedOut: false }]
    const r = await run()
    expect(r.skipped.conta_indisponivel).toBe(1)
    expect(state.inserts.map((i) => i.contactId)).toEqual(['ct_andressa'])
  })

  it('mesmo contato nas duas contas do Asaas: UMA mensagem, cada parcela com a conta dela', async () => {
    state.payments.k2.push(pay({ id: 'pay_leva_b', customer: 'cus_leva_b', dueDate: '2026-09-22' }))
    state.customers.cus_leva_b = { id: 'cus_leva_b', name: 'Leva Entulho ME', mobilePhone: '67990000001', notificationDisabled: true, dateCreated: '2024-01-01' }
    state.contactOf = { ...state.contactOf, cus_leva_b: 'ct_leva' }
    await run()
    const leva = state.inserts.find((i) => i.contactId === 'ct_leva')!
    expect(leva.payload).toMatchObject({
      asaasIds: ['pay_leva1', 'pay_leva_b'],
      paymentRefs: [
        { asaasId: 'pay_leva1', connectionId: 'c-asaas' },
        { asaasId: 'pay_leva_b', connectionId: 'c-golink' },
      ],
    })
    expect((leva.payload as Record<string, unknown>).connectionId).toBeUndefined()
    expect(String(leva.suggestedText).split('Seguem os links').length).toBe(2)
  })

  it('só depois do dia da 1ª varredura que seguiu o "CRM assume os avisos"', async () => {
    await run({ settings: { ...golink, asaasNotificationsOffAt: '2026-09-15T13:00:00Z', asaasNotificationsSweptAt: '2026-09-15T20:00:00Z' } })
    expect(state.listCalls).toHaveLength(2)
    expect(state.listCalls.every((c) => c.since === '2026-09-16')).toBe(true)
    // Leva e Alpha nasceram em 15/09: o Asaas ainda avisava.
    expect(state.inserts).toHaveLength(0)
  })

  // Revisão 17/09: ligada sexta 17h30, a varredura só roda segunda 9h — o Asaas
  // avisou as do fim de semana; contar do clique mandava o link de novo.
  it('ligou e a varredura ainda não calou ninguém → não lê nada, "aguardando_varredura"', async () => {
    const r = await run({ settings: { ...golink, asaasNotificationsOffAt: '2026-09-16T20:30:00Z', asaasNotificationsSweptAt: null } })
    expect(state.listCalls).toHaveLength(0)
    expect(r.skipped.aguardando_varredura).toBe(2)
    expect(state.inserts).toHaveLength(0)
  })

  // Revisão 17/09: ligada às 10:00 e varrida às 10:30 de hoje → o piso é amanhã.
  // Trazer para hoje punha na janela a das 08:00 que o Asaas já tinha avisado.
  it('varredura de hoje → piso amanhã: sem janela hoje, nenhuma listagem', async () => {
    const r = await run({ settings: { ...golink, asaasNotificationsOffAt: '2026-09-17T12:00:00Z', asaasNotificationsSweptAt: '2026-09-17T12:30:00Z' } })
    expect(state.listCalls).toHaveLength(0)
    expect(r.skipped.aguardando_varredura).toBe(2)
    expect(state.inserts).toHaveLength(0)
  })

  it('Asaas avisando (conta não assumiu os avisos) → não lê nada', async () => {
    const r = await run({ settings: { ...golink, asaasNotificationsOff: false } })
    expect(r).toMatchObject({ queued: 0, listed: 0 })
    expect(state.listCalls).toHaveLength(0)
  })

  it('conexão ligada há menos de 3 dias é carga inicial', async () => {
    state.conns = state.conns.map((c) => ({ ...c, createdAt: '2026-09-16T12:00:00Z' }))
    const r = await run()
    expect(r.skipped.conexao_nova).toBe(2)
    expect(state.listCalls).toHaveLength(0)
  })

  it('dryRun devolve o que entraria sem inserir nem ocupar o dia', async () => {
    const contactedToday = new Set<string>()
    const r = await run({ dryRun: true, contactedToday })
    expect(state.inserts).toHaveLength(0)
    expect(contactedToday.size).toBe(0)
    expect(r.preview?.map((p) => p.contactId)).toEqual(['ct_leva', 'ct_alpha'])
    expect(r.preview?.[0].text).toContain(url('pay_leva1'))
  })
})

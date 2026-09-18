import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 16/09 do "A vencer sem contato" (Veloz Gás e Água, GoLink). Banco
// falso: cada consulta awaited (select, ou escrita com RETURNING) consome a
// próxima resposta da fila, e as escritas ficam registradas. O SQL não é
// testado — aqui interessa a DECISÃO:
//   • "Criar contato" (carteira e painel) nunca chuta entre dois contatos;
//   • o aviso depois de ligar sabe se o lembrete vai sair;
//   • o nome do Asaas vai para o vínculo;
//   • a lista "Ligados nos últimos dias" chega à tela (e a falha dela também);
//   • o Desfazer do "Criar contato" só apaga o contato de quem criou;
//   • revisão 16/09: o aviso olha o freio da régua, "Criar" confere pela chave
//     que cria, ligar não leva cobrança do CRM e o Desligar recusa quem já
//     está na carteira.

type Rec = { op: string; table?: unknown; values?: unknown; set?: unknown; returning?: boolean }

const h = vi.hoisted(() => {
  const state = {
    results: [] as unknown[],
    calls: [] as Rec[],
    tx: 0,
  }
  const THROW = Symbol('throw')
  const chain = (op: string, table?: unknown) => {
    const rec: Rec = { op, table }
    state.calls.push(rec)
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        const reads = op === 'select' || rec.returning
        const next = reads ? state.results.shift() : undefined
        promise =
          next && typeof next === 'object' && THROW in (next as object)
            ? Promise.reject((next as Record<symbol, unknown>)[THROW])
            : Promise.resolve(reads ? (next ?? []) : undefined)
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
          return (...args: unknown[]) => {
            if (prop === 'from') rec.table = args[0]
            if (prop === 'values') rec.values = args[0]
            if (prop === 'set') rec.set = args[0]
            if (prop === 'returning') rec.returning = true
            return self
          }
        },
      },
    )
    return self
  }
  const db = {
    select: () => chain('select'),
    selectDistinct: () => chain('select'),
    insert: (t: unknown) => chain('insert', t),
    update: (t: unknown) => chain('update', t),
    delete: (t: unknown) => chain('delete', t),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.tx += 1
      return fn(db)
    },
  }
  return {
    state,
    db,
    fail: (err: Error) => ({ [THROW]: err }),
    findContact: vi.fn(),
    findOrCreateContact: vi.fn(),
    resolveCollectionTargets: vi.fn(),
    getAccountSettings: vi.fn(),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/account', () => {
  const ctx = async () => ({ accountId: 'acc-1', userId: 'u-1', role: 'agent' })
  return { getCurrentAccount: ctx, requireRole: ctx }
})
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: h.getAccountSettings, updateAccountSettings: vi.fn() }))
vi.mock('@/lib/asaas/sync', () => ({ findContact: h.findContact, syncAccount: vi.fn(), syncConnection: vi.fn() }))
vi.mock('@/lib/api/v1/contacts', () => ({ findOrCreateContact: h.findOrCreateContact }))
vi.mock('@/lib/collections/outreach', () => ({ resolveCollectionTargets: h.resolveCollectionTargets, WHATSAPP_PROVIDERS: [] }))
vi.mock('@/lib/asaas/collections', () => ({ AsaasApiError: class extends Error {} }))
// Pesados (fila, IA, envio, Asaas) — não participam.
vi.mock('@/lib/collections/engine', () => ({}))
vi.mock('@/lib/orchestration/validation', () => ({}))
vi.mock('@/lib/orchestration/policy', () => ({}))
vi.mock('@/lib/collections/emit', () => ({}))
vi.mock('@/lib/collections/connection-pick', () => ({}))
vi.mock('@/lib/collections/due-date', () => ({}))
vi.mock('@/lib/collections/reply-guard', () => ({}))
vi.mock('@/lib/ai/close-actions', () => ({}))
vi.mock('@/lib/whatsapp/number-exists', () => ({}))
vi.mock('@/lib/whatsapp/send-message', () => ({}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }))

import { asaasCharges, asaasCustomerLinks, contacts } from '@/db'
import { CREATE_AMBIGUOUS_ERROR, linkOutcomeTexts } from '@/lib/collections/upcoming-unmatched'

import {
  createContactForDebtor,
  createContactForUpcoming,
  getUpcomingUnmatched,
  linkUpcomingCustomer,
  unlinkRecentUpcomingCustomer,
  unlinkUpcomingCustomer,
} from './actions'

const CONN = '11111111-1111-4111-8111-111111111111'
const CONTACT = '22222222-2222-4222-8222-222222222222'
const NEW_CONTACT = '33333333-3333-4333-8333-333333333333'

const AMBIGUOUS = { contactId: null, matchedBy: null, ambiguous: true }
const NOBODY = { contactId: null, matchedBy: null, ambiguous: false }

beforeEach(() => {
  h.state.results = []
  h.state.calls = []
  h.state.tx = 0
  h.findContact.mockReset()
  h.findOrCreateContact.mockReset()
  h.resolveCollectionTargets.mockReset()
  h.getAccountSettings.mockReset()
  h.getAccountSettings.mockResolvedValue({ businessTimezone: 'America/Sao_Paulo', collections: { enabled: true, reminderDaysBefore: 3 } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const writes = (op: string, table: unknown) => h.state.calls.filter((c) => c.op === op && c.table === table)

describe('carteira: "Criar contato e ligar" com devedor ambíguo', () => {
  it('2 contatos com o telefone (com e sem o 9º dígito): recusa, não cria, não liga e não grava vínculo', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '5511999990000', email: 'fin@lojay.com', cpfCnpj: '12.345.678/0001-90' }])
    h.findContact.mockResolvedValue(AMBIGUOUS)

    const res = await createContactForDebtor('cus_Y')

    expect(res).toEqual({ ok: false, error: CREATE_AMBIGUOUS_ERROR })
    // O casamento é o da sincronização SEM vínculo, pela chave que a criação usa: o telefone.
    expect(h.findContact).toHaveBeenCalledWith('acc-1', '5511999990000', null, null)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(h.state.tx).toBe(0)
    expect(writes('insert', asaasCustomerLinks)).toHaveLength(0)
  })

  it('ninguém com os dados: cria, liga as cobranças e grava o vínculo com o nome do Asaas', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '5511999990000', email: null, cpfCnpj: null }])
    h.findContact.mockResolvedValue(NOBODY)
    h.findOrCreateContact.mockResolvedValue({ id: NEW_CONTACT, created: true })
    // UPDATE … RETURNING das cobranças abertas.
    h.state.results.push([{ id: 'ch-1', connectionId: CONN, asaasCustomerId: 'cus_Y', customerName: 'Loja Y' }])

    const res = await createContactForDebtor('cus_Y')

    expect(res).toEqual({ ok: true, data: { contactId: NEW_CONTACT, created: true, linked: 1 } })
    const link = writes('insert', asaasCustomerLinks)
    expect(link).toHaveLength(1)
    expect(link[0].values).toEqual([
      expect.objectContaining({ connectionId: CONN, asaasCustomerId: 'cus_Y', contactId: NEW_CONTACT, linkedBy: 'u-1', customerName: 'Loja Y' }),
    ])
  })

  it('não deu para conferir (banco caiu): recusa em vez de criar às cegas', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '5511999990000', email: null, cpfCnpj: null }])
    h.findContact.mockRejectedValue(new Error('connection terminated'))

    const res = await createContactForDebtor('cus_Y')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Tente de novo/)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('revisão 16/09 (a): celular que ninguém tem + e-mail do financeiro em 2 contatos: confere só o telefone e cria', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '(11) 99999-0000', email: 'financeiro@lojay.com', cpfCnpj: '12.345.678/0001-90' }])
    // Pelo telefone ninguém — o empate do e-mail/CNPJ não entra, a criação não procura por eles.
    h.findContact.mockImplementation(async (_acc: string, phone: string | null, email: string | null) => (phone && !email ? NOBODY : AMBIGUOUS))
    h.findOrCreateContact.mockResolvedValue({ id: NEW_CONTACT, created: true })
    h.state.results.push([{ id: 'ch-1', connectionId: CONN, asaasCustomerId: 'cus_Y', customerName: 'Loja Y' }])

    const res = await createContactForDebtor('cus_Y')

    expect(h.findContact).toHaveBeenCalledWith('acc-1', '5511999990000', null, null)
    expect(res).toEqual({ ok: true, data: { contactId: NEW_CONTACT, created: true, linked: 1 } })
  })

  it('revisão 16/09 (b): telefone que não serve para criar ("+1…") com e-mail em 2 contatos: confere pelo e-mail e recusa', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '+1 415 555 0123', email: ' Fin@LojaY.com ', cpfCnpj: null }])
    h.findContact.mockImplementation(async (_acc: string, phone: string | null) => (phone ? NOBODY : AMBIGUOUS))

    const res = await createContactForDebtor('cus_Y')

    expect(h.findContact).toHaveBeenCalledWith('acc-1', null, 'fin@lojay.com', null)
    expect(res).toEqual({ ok: false, error: CREATE_AMBIGUOUS_ERROR })
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(h.state.tx).toBe(0)
  })

  it('sem telefone nem e-mail: nem confere, diz o que fazer', async () => {
    h.state.results.push([{ name: 'Loja Y', phone: '+370 612 34567', email: null, cpfCnpj: null }])

    const res = await createContactForDebtor('cus_Y')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/não tem telefone válido nem e-mail/)
    expect(h.findContact).not.toHaveBeenCalled()
  })
})

describe('painel: "Criar contato" confere o casamento na hora', () => {
  const snap = { name: 'Veloz Gás e Água', phone: '12990001234', email: null, cpfCnpj: null, reason: 'no_contact' }

  it('retrato diz "sem contato", mas um duplicado apareceu depois da leitura: recusa', async () => {
    h.state.results.push([snap])
    h.findContact.mockResolvedValue(AMBIGUOUS)

    const res = await createContactForUpcoming(CONN, 'cus_veloz')

    expect(res).toEqual({ ok: false, error: CREATE_AMBIGUOUS_ERROR })
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(h.state.tx).toBe(0)
  })

  it('cria de verdade: vínculo com o nome do Asaas e o canal conferido como a fila confere', async () => {
    h.state.results.push([snap])
    h.findContact.mockResolvedValue(NOBODY)
    h.findOrCreateContact.mockResolvedValue({ id: NEW_CONTACT, created: true })
    h.state.results.push([], []) // vínculo atual, cobranças abertas
    h.state.results.push([{ name: 'Veloz Gás e Água', phone: '5512990001234', optedOut: false }]) // ficha
    h.resolveCollectionTargets.mockResolvedValue({ ok: true, whatsapp: { conversationId: '', created: false }, email: null, label: 'WhatsApp' })

    const res = await createContactForUpcoming(CONN, 'cus_veloz')

    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ contactId: NEW_CONTACT, created: true, contactHasPhone: true, phoneDiffers: false, deliveryLabel: 'WhatsApp' })
    expect(writes('insert', asaasCustomerLinks)[0].values).toEqual([expect.objectContaining({ customerName: 'Veloz Gás e Água', contactId: NEW_CONTACT })])
    expect(linkOutcomeTexts('Veloz Gás e Água', true, res.data!)).toEqual({ reminder: 'O lembrete sai por WhatsApp na próxima rodada da régua.', warning: null })
  })
})

describe('painel: aviso depois de ligar', () => {
  const snap = { name: 'R&S Vidros', phone: '1130004321', email: null, cpfCnpj: null, reason: 'no_contact' }

  it('ficha sem telefone e sem como mandar e-mail: o resultado diz que o lembrete NÃO sai (nada de "só por e-mail")', async () => {
    h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [snap]) // contato, conta do Asaas, retrato (lido ANTES de ligar)
    h.state.results.push([], []) // vínculo atual, cobranças abertas
    h.state.results.push([{ name: 'RS Vidros', phone: '', optedOut: false }]) // ficha
    h.resolveCollectionTargets.mockResolvedValue({ ok: false, error: 'A régua cobra só por WhatsApp e o contato não tem telefone válido.' })

    const res = await linkUpcomingCustomer(CONN, 'cus_lm', CONTACT)

    expect(res.ok).toBe(true)
    // Mesmo teste da fila do lembrete: dryRun, com o e-mail do Asaas de reserva.
    expect(h.resolveCollectionTargets).toHaveBeenCalledWith('acc-1', CONTACT, null, { dryRun: true, fallbackEmail: null })
    expect(res.data).toMatchObject({
      contactName: 'RS Vidros',
      contactHasPhone: false,
      deliveryLabel: null,
      deliveryError: 'A régua cobra só por WhatsApp e o contato não tem telefone válido.',
    })
    expect(linkOutcomeTexts('R&S Vidros', true, res.data!).warning).toMatch(/^O lembrete de R&S Vidros NÃO vai sair/)
    // O nome do Asaas vai no vínculo (lista "Ligados nos últimos dias").
    expect(writes('insert', asaasCustomerLinks)[0].values).toEqual([expect.objectContaining({ customerName: 'R&S Vidros', contactId: CONTACT })])
  })

  it('a conferência do canal falhar não desfaz a ligação nem inventa canal', async () => {
    h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [{ ...snap, phone: null, email: 'rs@x.com' }], [], [], [{ name: 'RS Vidros', phone: '', optedOut: false }])
    h.resolveCollectionTargets.mockRejectedValue(new Error('timeout'))

    const res = await linkUpcomingCustomer(CONN, 'cus_lm', CONTACT)

    expect(res.ok).toBe(true)
    expect(h.resolveCollectionTargets).toHaveBeenCalledWith('acc-1', CONTACT, null, { dryRun: true, fallbackEmail: 'rs@x.com' })
    expect(res.data).toMatchObject({ deliveryLabel: null, deliveryError: null })
    const t = linkOutcomeTexts('R&S Vidros', true, res.data!)
    expect(t.warning).toBe('A ficha de RS Vidros não tem telefone: o lembrete não sai por WhatsApp.')
    expect(t.reminder).toMatch(/^Não deu para conferir/)
  })
})

describe('painel: o aviso olha o freio da régua como a fila (revisão 16/09)', () => {
  const snap = { name: 'Centro Pisos', phone: '11999990000', email: null, cpfCnpj: null, reason: 'no_contact' }
  const ficha = { name: 'Centro Pisos Matriz', phone: '5511999990000', optedOut: false }
  const touch = { paused: false, pausedReason: null as string | null, touchCount: 0, lastTouchAt: null, snoozeUntil: null as string | null, snoozeReason: null as string | null }
  // contato, conta do Asaas, retrato, vínculo atual, cobranças abertas, ficha — e a régua do contato
  const linkWith = (st: typeof touch) => h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [snap], [], [], [ficha], [st])

  beforeEach(() => {
    h.resolveCollectionTargets.mockResolvedValue({ ok: true, whatsapp: { conversationId: '', created: false }, email: null, label: 'WhatsApp' })
  })

  it('ficha em "Régua parada" (pausa humana): NÃO vai sair e diz onde retomar — nem confere canal', async () => {
    linkWith({ ...touch, paused: true, pausedReason: 'pediu acordo' })

    const res = await linkUpcomingCustomer(CONN, 'cus_cp', CONTACT)

    expect(res.ok).toBe(true)
    expect(h.resolveCollectionTargets).not.toHaveBeenCalled()
    expect(res.data).toMatchObject({ deliveryLabel: null, deliveryError: expect.stringContaining('(pediu acordo)') })
    const t = linkOutcomeTexts('Centro Pisos', true, res.data!)
    expect(t.reminder).toBe('')
    expect(t.warning).toMatch(/^O lembrete de Centro Pisos NÃO vai sair: A régua está parada neste cliente \(pediu acordo\)/)
    expect(t.warning).toContain('Retomar cobrança')
  })

  it('promessa com data no futuro segura; promessa vencida não', async () => {
    linkWith({ ...touch, snoozeUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(), snoozeReason: 'prometeu pagar' })
    const held = await linkUpcomingCustomer(CONN, 'cus_cp', CONTACT)
    expect(linkOutcomeTexts('Centro Pisos', true, held.data!).warning).toMatch(
      /NÃO vai sair: A régua está parada neste cliente até \d{2}\/\d{2} \(prometeu pagar\)/,
    )
    expect(h.resolveCollectionTargets).not.toHaveBeenCalled()

    linkWith({ ...touch, snoozeUntil: new Date(Date.now() - 86_400_000).toISOString(), snoozeReason: 'prometeu pagar' })
    const free = await linkUpcomingCustomer(CONN, 'cus_cp', CONTACT)
    expect(free.data).toMatchObject({ deliveryLabel: 'WhatsApp', deliveryError: null })
    expect(linkOutcomeTexts('Centro Pisos', true, free.data!)).toEqual({ reminder: 'O lembrete sai por WhatsApp na próxima rodada da régua.', warning: null })
  })

  it('limite de toques pelas settings da conta (maxTouches 3): NÃO vai sair', async () => {
    h.getAccountSettings.mockResolvedValue({ businessTimezone: 'America/Sao_Paulo', collections: { enabled: true, reminderDaysBefore: 3, maxTouches: 3 } })
    linkWith({ ...touch, touchCount: 3 })

    const res = await linkUpcomingCustomer(CONN, 'cus_cp', CONTACT)

    const t = linkOutcomeTexts('Centro Pisos', true, res.data!)
    expect(t.reminder).toBe('')
    expect(t.warning).toMatch(/NÃO vai sair: Chegou no limite de cobranças/)
  })

  it('não deu para ler o freio: não promete canal nem que sai', async () => {
    h.getAccountSettings.mockRejectedValue(new Error('timeout'))
    h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [snap], [], [], [ficha])

    const res = await linkUpcomingCustomer(CONN, 'cus_cp', CONTACT)

    expect(res.ok).toBe(true)
    expect(h.resolveCollectionTargets).not.toHaveBeenCalled()
    expect(res.data).toMatchObject({ deliveryLabel: null, deliveryError: null })
    expect(linkOutcomeTexts('Centro Pisos', true, res.data!).reminder).toMatch(/^Não deu para conferir/)
  })
})

describe('painel: ligar não leva a cobrança emitida pelo CRM (revisão 16/09)', () => {
  const SOCIO = '44444444-4444-4444-8444-444444444444'

  it('a do sócio (origin ai) fica com ele; a espelhada sem contato vai para o contato escolhido', async () => {
    h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [{ name: 'Loja X', phone: null, email: null, cpfCnpj: null, reason: 'no_contact' }], [])
    h.state.results.push([
      { id: 'ch-crm', contactId: SOCIO, matchedBy: 'manual', origin: 'ai' },
      { id: 'ch-sync', contactId: null, matchedBy: null, origin: 'sync' },
    ])
    h.state.results.push([{ name: 'Financeiro', phone: '5511999990000', optedOut: false }])
    h.resolveCollectionTargets.mockResolvedValue({ ok: true, whatsapp: { conversationId: '', created: false }, email: null, label: 'WhatsApp' })

    const res = await linkUpcomingCustomer(CONN, 'cus_X', CONTACT)

    expect(res.ok).toBe(true)
    expect(res.data?.restore).toEqual([{ id: 'ch-sync', contactId: null, matchedBy: null }])
    expect(writes('update', asaasCharges)).toHaveLength(1)
  })

  it('só cobrança do CRM com contato: nada muda na carteira', async () => {
    h.state.results.push([{ id: CONTACT }], [{ id: CONN }], [], [])
    h.state.results.push([{ id: 'ch-crm', contactId: SOCIO, matchedBy: 'manual', origin: 'manual' }])
    h.resolveCollectionTargets.mockResolvedValue({ ok: true, whatsapp: { conversationId: '', created: false }, email: null, label: 'WhatsApp' })

    const res = await linkUpcomingCustomer(CONN, 'cus_X', CONTACT)

    expect(res.ok).toBe(true)
    expect(res.data?.restore).toEqual([])
    expect(writes('update', asaasCharges)).toHaveLength(0)
  })
})

describe('Desfazer / Desligar', () => {
  const unused = {
    recent: true,
    createdByUser: true,
    conversations: false,
    deals: false,
    links: false,
    charges: false,
    actionRequests: false,
    notes: false,
    tags: false,
    schedule: false,
    history: false,
  }
  const undoOf = (createdContactId: string | null) => ({ contactId: NEW_CONTACT, previousContactId: null, restore: [], createdContactId })

  it('"Criar contato" desfeito: apaga o vínculo e o contato recém-criado sem uso', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [unused]) // conta, vínculo atual, uso do contato

    const res = await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(NEW_CONTACT))

    expect(res).toEqual({ ok: true, data: { contactRemoved: true } })
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(1)
    expect(writes('delete', contacts)).toHaveLength(1)
  })

  it('contato criado por OUTRA pessoa (id forjado no navegador) ou já com etiqueta: fica', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [{ ...unused, createdByUser: false }])
    expect(await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(NEW_CONTACT))).toEqual({ ok: true, data: { contactRemoved: false } })

    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [{ ...unused, tags: true }])
    expect(await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(NEW_CONTACT))).toEqual({ ok: true, data: { contactRemoved: false } })

    expect(writes('delete', contacts)).toHaveLength(0)
  })

  it('"Desligar" da lista (sem contato criado): só o vínculo sai', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }])

    const res = await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(null))

    expect(res).toEqual({ ok: true, data: { contactRemoved: false } })
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(1)
    expect(writes('delete', contacts)).toHaveLength(0)
  })

  it('"Desligar" da lista velha: a parcela venceu e já está na carteira — recusa e não apaga o vínculo', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [{ id: 'ch-overdue' }]) // conta, vínculo, cobrança aberta

    const res = await unlinkRecentUpcomingCustomer(CONN, 'cus_veloz', NEW_CONTACT)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cobrança aberta na carteira/)
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(0)
  })

  it('"Desligar" da lista sem cobrança aberta: só o vínculo sai', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [])

    const res = await unlinkRecentUpcomingCustomer(CONN, 'cus_veloz', NEW_CONTACT)

    expect(res).toEqual({ ok: true, data: { contactRemoved: false } })
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(1)
    expect(writes('delete', contacts)).toHaveLength(0)
  })

  it('"Desfazer" de um clique não confere cobrança aberta (a que ele não mudou já era assim)', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: NEW_CONTACT }], [{ id: 'ch-ja-manual' }])

    const res = await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(null))

    expect(res).toEqual({ ok: true, data: { contactRemoved: false } })
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(1)
  })

  it('"Desfazer" do Desligar religa com o nome do Asaas que a lista tinha (o retrato já não existe)', async () => {
    h.state.results.push([{ id: NEW_CONTACT }], [{ id: CONN }], [], [], [], [{ name: 'Veloz Matriz', phone: '5512990001234', optedOut: false }])
    h.resolveCollectionTargets.mockResolvedValue({ ok: true, whatsapp: { conversationId: '', created: false }, email: null, label: 'WhatsApp' })

    const res = await linkUpcomingCustomer(CONN, 'cus_veloz', NEW_CONTACT, '  Veloz Gás e Água ')

    expect(res.ok).toBe(true)
    expect(writes('insert', asaasCustomerLinks)[0].values).toEqual([expect.objectContaining({ customerName: 'Veloz Gás e Água', contactId: NEW_CONTACT })])
  })

  it('vínculo trocado por outra pessoa depois: não desliga nada', async () => {
    h.state.results.push([{ id: CONN }], [{ contactId: CONTACT }])

    const res = await unlinkUpcomingCustomer(CONN, 'cus_veloz', undoOf(null))

    expect(res.ok).toBe(false)
    expect(writes('delete', asaasCustomerLinks)).toHaveLength(0)
  })
})

describe('getUpcomingUnmatched: "Ligados nos últimos dias"', () => {
  beforeEach(() => {
    h.getAccountSettings.mockResolvedValue({ businessTimezone: 'America/Sao_Paulo', collections: { enabled: true, reminderDaysBefore: 3 } })
  })

  it('cliente só com parcela a vencer ligado no painel aparece para poder ser desligado', async () => {
    h.state.results.push([
      {
        connectionId: CONN,
        connectionLabel: 'GoLink',
        customerId: 'cus_veloz',
        customerName: 'Veloz Gás e Água',
        contactId: CONTACT,
        contactName: ' ',
        contactPhone: '5512990001234',
        linkedByName: 'Joyce',
        linkedAt: '2026-09-16T14:02:00.000Z',
      },
    ])
    h.state.results.push([]) // cartões do retrato

    const res = await getUpcomingUnmatched()

    expect(res.ok).toBe(true)
    expect(res.data?.recentLinksFailed).toBe(false)
    expect(res.data?.recentLinks).toEqual([
      {
        connectionId: CONN,
        connectionLabel: 'GoLink',
        customerId: 'cus_veloz',
        customerName: 'Veloz Gás e Água',
        contactId: CONTACT,
        contactName: '5512990001234',
        contactHasPhone: true,
        linkedByName: 'Joyce',
        linkedAt: '2026-09-16T14:02:00.000Z',
      },
    ])
  })

  it('a lista falhar não esconde os cartões, e a tela sabe que falhou', async () => {
    h.state.results.push(h.fail(new Error('column "customer_name" does not exist')))
    h.state.results.push([]) // cartões do retrato

    const res = await getUpcomingUnmatched()

    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ enabled: true, recentLinks: [], recentLinksFailed: true })
  })

  it('lembrete desligado: nem consulta', async () => {
    h.getAccountSettings.mockResolvedValue({ collections: { enabled: true, reminderDaysBefore: 0 } })

    const res = await getUpcomingUnmatched()

    expect(res.data).toMatchObject({ enabled: false, recentLinks: [], recentLinksFailed: false })
    expect(h.state.calls).toHaveLength(0)
  })
})

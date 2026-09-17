import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 17/09 (aviso de cobrança nova): ligar "o CRM assume os avisos" zera a
// varredura da conta, mas o portão de 20 h olhava a última varredura da CONEXÃO.
// Com o selo clicado antes (ou desmarcar e remarcar numa conta com a varredura
// diária), nada varria por um dia, o aviso ficava em "aguardando_varredura" e as
// cobranças desse meio-tempo viravam "antiga" para sempre — com o cliente já
// calado, ninguém mandava o link. Banco e Asaas falsificados: interessa a DECISÃO
// da sincronização (varre todos? grava a varredura?), não o SQL nem o HTTP.

const h = vi.hoisted(() => ({
  conn: null as null | {
    id: string
    accountId: string
    label: string
    apiKeyEnc: string
    environment: string
    notificationsOffAt: string | null
  },
  collections: {} as Record<string, unknown>,
  everyone: [] as { id: string; notificationDisabled?: boolean }[],
  listFails: false,
  puts: [] as string[],
  connUpdates: [] as Record<string, unknown>[],
}))

vi.mock('@/db', () => {
  const table = (name: string) =>
    new Proxy({ __table: name } as Record<string, unknown>, {
      get: (t, p) => (p in t ? t[p as string] : { __col: `${name}.${String(p)}` }),
    })
  const select = () => {
    const q = { table: '' }
    const c: Record<string, unknown> = {}
    c.from = (t: { __table: string }) => ((q.table = t.__table), c)
    c.innerJoin = () => c
    c.where = () => c
    c.limit = () => c
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(q.table === 'asaasConnections' && h.conn ? [{ ...h.conn }] : []).then(res, rej)
    return c
  }
  const update = (t: { __table: string }) => ({
    set: (values: Record<string, unknown>) => {
      if (t.__table === 'asaasConnections') {
        h.connUpdates.push(values)
        // Como o banco: a próxima sincronização já lê a varredura gravada na conexão.
        if (h.conn && 'notificationsOffAt' in values) h.conn.notificationsOffAt = values.notificationsOffAt as string | null
      }
      return { where: () => Object.assign(Promise.resolve([]), { returning: async () => [] }) }
    },
  })
  return {
    db: { select, update, insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }) },
    asaasCharges: table('asaasCharges'),
    asaasConnections: table('asaasConnections'),
    asaasCustomerLinks: table('asaasCustomerLinks'),
    contacts: table('contacts'),
  }
})
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))
vi.mock('./collections', () => ({
  AsaasApiError: class AsaasApiError extends Error {},
  DEFAULT_OVERDUE_STATUSES: ['OVERDUE'],
  // Carteira vazia: o que importa aqui é a varredura de avisos.
  listCharges: vi.fn(async () => []),
  fetchCustomers: vi.fn(async () => new Map()),
  listAllCustomers: vi.fn(async () => {
    if (h.listFails) throw new Error('O Asaas não respondeu a tempo')
    return h.everyone.map((c) => ({ ...c }))
  }),
  setCustomerNotifications: vi.fn(async (_cred: unknown, id: string) => {
    h.puts.push(id)
  }),
}))
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: vi.fn(async () => ({ collections: h.collections })) }))
vi.mock('@/lib/collections/asaas-silenced', () => ({
  listChargesAtSilencing: vi.fn(async () => null),
  recordSilenced: vi.fn(async () => {}),
  markAsaasNotificationsSwept: vi.fn(async () => {}),
}))

import { markAsaasNotificationsSwept, recordSilenced } from '@/lib/collections/asaas-silenced'

import { listAllCustomers } from './collections'
import { syncConnection } from './sync'

const MIN = 60_000
const H = 60 * MIN
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const varreuTodos = () => vi.mocked(listAllCustomers).mock.calls.length

const silenciar = (metodo: 'log' | 'warn') => vi.spyOn(console, metodo).mockImplementation(() => {})
let log: ReturnType<typeof silenciar>
let warn: ReturnType<typeof silenciar>

beforeEach(() => {
  h.conn = { id: 'conn-1', accountId: 'acc-1', label: 'AsaasGoLink', apiKeyEnc: 'k', environment: 'production', notificationsOffAt: null }
  h.collections = { enabled: true, asaasNotificationsOff: true }
  h.everyone = [
    { id: 'cus_calado', notificationDisabled: true },
    { id: 'cus_novo', notificationDisabled: false },
  ]
  h.listFails = false
  h.puts = []
  h.connUpdates = []
  log = silenciar('log')
  warn = silenciar('warn')
})

afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
})

describe('syncConnection — ligar "o CRM assume os avisos" antecipa a varredura completa', () => {
  it('selo calou todo mundo há 1 h e a opção foi ligada depois: varre todos JÁ e grava a varredura (antes: 20 h)', async () => {
    h.conn!.notificationsOffAt = ago(60 * MIN)
    h.collections = { ...h.collections, asaasNotificationsOffAt: ago(55 * MIN), asaasNotificationsSweptAt: null }

    const r = await syncConnection('acc-1', 'conn-1')

    expect(r.ok).toBe(true)
    expect(varreuTodos()).toBe(1)
    // Só quem ainda estava com aviso ligado é calado — e deixa rastro.
    expect(h.puts).toEqual(['cus_novo'])
    expect(recordSilenced).toHaveBeenCalledWith('conn-1', ['cus_novo'], null)
    // A varredura vale como a 1ª depois do clique: o aviso de cobrança nova sai da espera.
    expect(markAsaasNotificationsSwept).toHaveBeenCalledTimes(1)
    const [conta, varridaEm] = vi.mocked(markAsaasNotificationsSwept).mock.calls[0]
    expect(conta).toBe('acc-1')
    expect(Date.parse(varridaEm)).toBeGreaterThanOrEqual(Date.parse(String(h.collections.asaasNotificationsOffAt)))
    expect(h.connUpdates.some((u) => 'notificationsOffAt' in u)).toBe(true)
    expect(log.mock.calls.flat().join(' ')).toContain('espera_varredura')
  })

  it('conta que ligou antes de existir o campo (GoLink hoje), varrida há 2 h: só a carteira, como antes', async () => {
    h.conn!.notificationsOffAt = ago(2 * H)

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(0)
    expect(h.puts).toEqual([])
    expect(markAsaasNotificationsSwept).not.toHaveBeenCalled()
    expect(h.connUpdates.some((u) => 'notificationsOffAt' in u)).toBe(false)
  })

  it('a rotina de 20 h continua: varrida há 21 h, varre de novo', async () => {
    h.conn!.notificationsOffAt = ago(21 * H)

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(1)
    expect(h.puts).toEqual(['cus_novo'])
    // Rotina não é novidade: não enche o log a cada dia.
    expect(log.mock.calls.flat().join(' ')).not.toContain('antecipada')
  })

  it('varredura já gravada depois do clique → volta à rotina (não varre todos a cada sincronização)', async () => {
    h.conn!.notificationsOffAt = ago(2 * H)
    h.collections = { ...h.collections, asaasNotificationsOffAt: ago(3 * H), asaasNotificationsSweptAt: ago(2 * H) }

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(0)
    expect(markAsaasNotificationsSwept).not.toHaveBeenCalled()
  })

  it('listagem falhou: vai para o log, não grava a varredura, e a sincronização seguinte tenta de novo', async () => {
    h.conn!.notificationsOffAt = ago(2 * H)
    h.collections = { ...h.collections, asaasNotificationsOffAt: ago(1 * H), asaasNotificationsSweptAt: null }
    h.listFails = true

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(1)
    expect(markAsaasNotificationsSwept).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('não deu para listar todos os clientes do Asaas')
    // A tentativa renovou a conexão (como sempre fez): pelo portão de 20 h, só amanhã.
    expect(Date.parse(h.conn!.notificationsOffAt!)).toBeGreaterThan(Date.parse(String(h.collections.asaasNotificationsOffAt)))

    h.listFails = false
    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(2)
    expect(markAsaasNotificationsSwept).toHaveBeenCalledTimes(1)
  })

  it('duas contas do Asaas: a outra já gravou a varredura; esta, varrida antes do clique, também varre já', async () => {
    h.conn!.notificationsOffAt = ago(3 * H)
    h.collections = { ...h.collections, asaasNotificationsOffAt: ago(2 * H), asaasNotificationsSweptAt: ago(1 * H) }

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(1)
    expect(h.puts).toEqual(['cus_novo'])
    expect(log.mock.calls.flat().join(' ')).toContain('conexao_antes_do_clique')
  })

  it('opção desligada: não mexe nos avisos de ninguém', async () => {
    h.collections = { enabled: true, asaasNotificationsOff: false, asaasNotificationsOffAt: ago(1 * H), asaasNotificationsSweptAt: null }

    await syncConnection('acc-1', 'conn-1')

    expect(varreuTodos()).toBe(0)
    expect(h.puts).toEqual([])
  })
})

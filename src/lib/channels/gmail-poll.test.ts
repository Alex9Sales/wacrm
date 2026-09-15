import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeRedis, redisStore } from '@/lib/__mocks__/fake-redis'

// 15/09 (GoLink): o Google revogou a senha de app. O login recusado deixava o
// socket do imapflow aberto e, 5 min depois, o timeout virava 'error' sem
// ouvinte e derrubava o worker inteiro — a cada tick.

const imap = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    usable: boolean
  }>,
  connectError: null as unknown,
}))

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = false
    connect = vi.fn(async () => {
      if (imap.connectError) throw imap.connectError
      this.usable = true
    })
    close = vi.fn(() => {
      this.usable = false
    })
    logout = vi.fn(async () => {})
    on = vi.fn(() => this)
    mailbox = false
    getMailboxLock = vi.fn(async () => ({ release: () => {} }))
    constructor() {
      imap.instances.push(this)
    }
  },
}))
vi.mock('ioredis', () => ({ Redis: FakeRedis }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))
vi.mock('@/db', () => {
  const rows = [{ id: 'canal-golink' }]
  const chain = { from: () => chain, where: async () => rows }
  return { db: { select: () => chain, update: vi.fn() }, channels: {} }
})
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: async (id: string) => ({ id, providerMeta: { gmailLastUid: 129, gmailUidValidity: '1' } }),
}))
vi.mock('@/lib/channels/registry', () => ({ getProvider: () => ({ parseWebhook: () => ({ messages: [] }) }) }))
vi.mock('@/lib/channels/inbound', () => ({ dispatchInboundMessage: vi.fn() }))
vi.mock('@/lib/channels/providers/gmail', () => ({
  gmailAddressOf: () => 'golinkoficial@gmail.com',
  appPasswordOf: () => 'abcdabcdabcdabcd',
}))

import { runGmailPollSweep } from './gmail-poll'

const authError = Object.assign(new Error('Command failed'), {
  authenticationFailed: true,
  responseStatus: 'NO',
  serverResponseCode: 'AUTHENTICATIONFAILED',
  responseText: 'Invalid credentials (Failure)',
  executedCommand: '3 AUTHENTICATE PLAIN',
})

describe('runGmailPollSweep com senha de app recusada', () => {
  beforeEach(() => {
    imap.instances.length = 0
    imap.connectError = null
    redisStore.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('fecha a conexão e ouve "error" (o socket vazado derrubava o worker)', async () => {
    imap.connectError = authError
    await expect(runGmailPollSweep()).resolves.toEqual({ channels: 1, messages: 0 })
    const [client] = imap.instances
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(client.close).toHaveBeenCalled()
  })

  it('não tenta logar de novo a cada minuto: espera 30 min', async () => {
    vi.useFakeTimers()
    imap.connectError = authError
    await runGmailPollSweep()
    await runGmailPollSweep()
    await runGmailPollSweep()
    expect(imap.instances).toHaveLength(1)

    vi.advanceTimersByTime(30 * 60_000 + 1)
    await runGmailPollSweep()
    expect(imap.instances).toHaveLength(2)
  })

  it('o log mostra o que o Gmail respondeu, não só "Command failed"', async () => {
    imap.connectError = authError
    await runGmailPollSweep()
    const linha = vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n')
    expect(linha).toContain('AUTHENTICATIONFAILED')
    expect(linha).toContain('Invalid credentials')
    expect(linha).not.toContain('abcdabcdabcdabcd')
  })

  it('outro erro (rede) não entra na espera de 30 min', async () => {
    imap.connectError = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    await runGmailPollSweep()
    await runGmailPollSweep()
    expect(imap.instances).toHaveLength(2)
    expect(imap.instances[0].close).toHaveBeenCalled()
  })

  it('login ok: sai com logout', async () => {
    await runGmailPollSweep()
    const [client] = imap.instances
    expect(client.logout).toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
  })
})

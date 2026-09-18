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
  mailbox: false as false | { uidValidity: number; uidNext: number },
  messages: [] as Array<{ uid: number; source: Buffer }>,
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
    get mailbox() {
      return imap.mailbox
    }
    getMailboxLock = vi.fn(async () => ({ release: () => {} }))
    async *fetch() {
      for (const m of imap.messages) yield m
    }
    constructor() {
      imap.instances.push(this)
    }
  },
}))
vi.mock('ioredis', () => ({ Redis: FakeRedis }))
const health = vi.hoisted(() => ({ fail: vi.fn(async () => {}), ok: vi.fn(async () => {}) }))
vi.mock('./gmail-health', () => ({ recordGmailFailure: health.fail, recordGmailImapLoginOk: health.ok }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))
vi.mock('@/db', () => {
  const rows = [{ id: 'canal-golink' }]
  const chain = { from: () => chain, where: () => Object.assign(Promise.resolve(rows), { limit: async () => [] }) }
  const upd = { set: () => upd, where: async () => [] }
  return { db: { select: () => chain, update: () => upd }, channels: {} }
})
const bounce = vi.hoisted(() => ({ apply: vi.fn(async () => 'matched') }))
vi.mock('./email-bounce-apply', () => ({ applyEmailBounce: bounce.apply }))
const inbound = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }))
const autoFilter = vi.hoisted(() => ({ ignore: vi.fn(async () => null as string | null) }))
vi.mock('./email-automated-filter', () => ({ shouldIgnoreAutomatedEmail: autoFilter.ignore }))
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: async (id: string) => ({ id, providerMeta: { gmailLastUid: 129, gmailUidValidity: '1' } }),
}))
vi.mock('@/lib/channels/registry', () => ({ getProvider: () => ({ parseWebhook: () => ({ messages: [{ id: 'm1' }] }) }) }))
vi.mock('@/lib/channels/inbound', () => ({ dispatchInboundMessage: inbound.dispatch }))
vi.mock('@/lib/channels/providers/gmail', () => ({
  gmailAddressOf: () => 'cobranca@exemplo.com.br',
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
    health.fail.mockClear()
    health.ok.mockClear()
    imap.mailbox = false
    imap.messages = []
    bounce.apply.mockReset()
    bounce.apply.mockResolvedValue('matched')
    inbound.dispatch.mockClear()
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

  it('registra a saúde da leitura: falha com o erro, sucesso zera', async () => {
    imap.connectError = authError
    await runGmailPollSweep()
    expect(health.fail).toHaveBeenCalledWith('canal-golink', 'imap', authError)
    expect(health.ok).not.toHaveBeenCalled()

    vi.useFakeTimers()
    vi.advanceTimersByTime(30 * 60_000 + 1)
    imap.connectError = null
    await runGmailPollSweep()
    expect(health.ok).toHaveBeenCalledWith('canal-golink', expect.any(Number))
  })
})

describe('runGmailPollSweep com aviso de devolução', () => {
  const dsn = Buffer.from(
    [
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      'To: cobranca@exemplo.com.br',
      'Subject: Delivery Status Notification (Failure)',
      'Content-Type: multipart/report; boundary="b1"; report-type=delivery-status',
      '',
      '--b1',
      'Content-Type: message/delivery-status',
      '',
      'X-Original-Message-ID: <00000000-0000-4000-8000-000000000001@gmail.com>',
      '',
      'Final-Recipient: rfc822; financeiro@empresa-exemplo.com.br',
      'Action: failed',
      'Status: 5.1.10',
      '',
      '--b1--',
      '',
    ].join('\r\n'),
  )
  const cliente = Buffer.from(['From: Cliente <cliente@empresa-exemplo.com.br>', 'To: cobranca@exemplo.com.br', 'Subject: Oi', 'Content-Type: text/plain', '', 'Já paguei.'].join('\r\n'))

  beforeEach(() => {
    imap.instances.length = 0
    imap.connectError = null
    imap.mailbox = { uidValidity: 1, uidNext: 132 }
    redisStore.clear()
    bounce.apply.mockReset()
    bounce.apply.mockResolvedValue('matched')
    inbound.dispatch.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('devolução vai pra applyEmailBounce e NUNCA vira contato; e-mail de cliente segue normal', async () => {
    imap.messages = [
      { uid: 130, source: dsn },
      { uid: 131, source: cliente },
    ]
    await runGmailPollSweep()
    expect(bounce.apply).toHaveBeenCalledTimes(1)
    expect(inbound.dispatch).toHaveBeenCalledTimes(1)
  })

  it('e-mail automático com o filtro ligado não vira contato', async () => {
    autoFilter.ignore.mockResolvedValueOnce('remetente no-reply@')
    imap.messages = [{ uid: 131, source: cliente }]
    await runGmailPollSweep()
    expect(inbound.dispatch).not.toHaveBeenCalled()
  })

  it('mesmo se aplicar a devolução der erro, ela não cai no inbox', async () => {
    bounce.apply.mockRejectedValue(new Error('banco fora'))
    imap.messages = [{ uid: 130, source: dsn }]
    await runGmailPollSweep()
    expect(inbound.dispatch).not.toHaveBeenCalled()
  })
})

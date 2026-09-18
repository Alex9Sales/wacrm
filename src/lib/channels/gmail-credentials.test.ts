import { beforeEach, describe, expect, it, vi } from 'vitest'
import { is, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

import { FakeRedis, redisStore } from '@/lib/__mocks__/fake-redis'

// 15/09 (GoLink): o Google revogou a senha de app do Gmail do canal de cobrança.
// Trocar a senha não pode apagar o canal, mexer no ponto de leitura, nem
// gravar uma senha que o Google recusa.

vi.mock('ioredis', () => ({ Redis: FakeRedis }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))

const dbm = vi.hoisted(() => ({
  set: vi.fn(),
  where: vi.fn(),
  returningRows: [{ id: 'canal-golink' }] as Array<{ id: string }>,
}))
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema')
  const chain = {
    set: (arg: unknown) => {
      dbm.set(arg)
      return chain
    },
    where: (arg: unknown) => {
      dbm.where(arg)
      return chain
    },
    returning: async () => dbm.returningRows,
  }
  return { db: { update: vi.fn(() => chain) }, channels: schema.channels }
})

const loadChannelByAccount = vi.hoisted(() => vi.fn())
vi.mock('@/lib/channels/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/channels')>()),
  loadChannelByAccount,
}))

const verify = vi.hoisted(() => ({ smtp: vi.fn(), imap: vi.fn() }))
vi.mock('./gmail-verify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gmail-verify')>()),
  verifyGmailSmtp: verify.smtp,
  verifyGmailImap: verify.imap,
}))

const publishEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/events/publish', () => ({ publishEvent }))

import { db } from '@/db'
import { decryptCredentials } from '@/lib/channels/channels'
import { GmailVerifyError } from './gmail-verify'
import { GMAIL_MSG, replaceGmailAppPassword } from './gmail-credentials'

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHANNEL = 'bbbbbbbb-0000-4000-8000-000000000002'
const NEW_PW = 'novasenhadeappok'

function golinkChannel(meta: Record<string, unknown> = {}) {
  return {
    id: CHANNEL,
    accountId: ACCOUNT,
    provider: 'gmail',
    name: 'GoLinkAsaas',
    phoneNumber: null,
    credentials: { address: 'cobranca.exemplo@gmail.com', appPassword: 'senhavelharevoga', fromName: 'GoLink' },
    providerMeta: {
      address: 'cobranca.exemplo@gmail.com',
      gmailUidValidity: '1',
      gmailLastUid: 129,
      health: { imap: { verdict: 'auth_failed', error: 'x', strikes: 3, first_fail_at: '2026-09-15T02:13:00Z', last_at: '2026-09-15T03:00:00Z' } },
      ...meta,
    },
    settings: {},
    webhookSecret: 'w',
  }
}

beforeEach(() => {
  redisStore.clear()
  dbm.set.mockClear()
  dbm.where.mockClear()
  dbm.returningRows = [{ id: CHANNEL }]
  vi.mocked(db.update).mockClear()
  loadChannelByAccount.mockReset()
  loadChannelByAccount.mockResolvedValue(golinkChannel())
  verify.smtp.mockReset()
  verify.smtp.mockResolvedValue(undefined)
  verify.imap.mockReset()
  verify.imap.mockResolvedValue({ uidValidity: '1', uidNext: 142 })
  publishEvent.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('replaceGmailAppPassword', () => {
  it('SMTP recusado: não grava nada e explica como gerar outra', async () => {
    verify.smtp.mockRejectedValue(new GmailVerifyError('auth', 'smtp', 'EAUTH'))
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toEqual({
      ok: false,
      httpStatus: 400,
      error: GMAIL_MSG.refused,
    })
    expect(verify.imap).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('SMTP ok mas IMAP recusado: não grava e diz que a leitura foi recusada', async () => {
    verify.imap.mockRejectedValue(new GmailVerifyError('auth', 'imap', 'AUTHENTICATIONFAILED'))
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toEqual({
      ok: false,
      httpStatus: 400,
      error: GMAIL_MSG.imapRefused,
    })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('Gmail fora do ar: 502 e não grava', async () => {
    verify.imap.mockRejectedValue(new GmailVerifyError('network', 'imap', 'ETIMEDOUT'))
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: false,
      httpStatus: 502,
      error: GMAIL_MSG.unreachable,
    })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('recusa canal que não é Gmail e canal de outra conta', async () => {
    loadChannelByAccount.mockResolvedValueOnce({ ...golinkChannel(), provider: 'waha' })
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: false,
      httpStatus: 400,
    })
    loadChannelByAccount.mockResolvedValueOnce(null)
    await expect(replaceGmailAppPassword('outra-conta', CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: false,
      httpStatus: 404,
    })
    expect(verify.smtp).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it.each(['minhaSenhaNormal123', 'abcd efgh ijkl', 'abcd efgh ijkl mnop q', 'abcd-efgh-ijkl-mnop'])(
    'recusa senha que não tem 16 letras: %s',
    async (raw) => {
      await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, raw)).resolves.toEqual({
        ok: false,
        httpStatus: 400,
        error: GMAIL_MSG.badFormat,
      })
      expect(verify.smtp).not.toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    },
  )

  it('grava a senha nova com o endereço SALVO, provider_meta por SQL e sem mexer no ponto de leitura', async () => {
    const res = await replaceGmailAppPassword(ACCOUNT, CHANNEL, 'nova senh adea ppok')
    expect(res).toMatchObject({ ok: true })

    // Testou no Google com o endereço salvo e a senha sem espaços.
    expect(verify.smtp).toHaveBeenCalledWith('cobranca.exemplo@gmail.com', NEW_PW)
    expect(verify.imap).toHaveBeenCalledWith('cobranca.exemplo@gmail.com', NEW_PW)

    expect(dbm.set).toHaveBeenCalledTimes(1)
    const patch = dbm.set.mock.calls[0][0] as Record<string, unknown>
    expect(patch.status).toBe('connected')

    const creds = decryptCredentials(patch.credentials as string)
    expect(creds).toEqual({ address: 'cobranca.exemplo@gmail.com', appPassword: NEW_PW, fromName: 'GoLink' })

    // Nunca o objeto lido no começo (o worker grava o mesmo campo).
    expect(is(patch.providerMeta, SQL)).toBe(true)
    const q = new PgDialect().sqlToQuery(patch.providerMeta as SQL)
    expect(q.sql).toContain(`- 'health'`)
    expect(q.sql).not.toContain('gmailLastUid')
    expect(q.sql).not.toContain('gmailUidValidity')
    expect(JSON.stringify(q.params)).not.toContain(NEW_PW)
  })

  it('apaga a espera de 30 min do poll e avisa as abas abertas', async () => {
    await new FakeRedis().set(`gmail:authfail:${CHANNEL}`, 'x', 'PX', 30 * 60_000)
    const res = await replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)
    expect(res).toMatchObject({ ok: true, pollResumesNow: true })
    expect(redisStore.has(`gmail:authfail:${CHANNEL}`)).toBe(false)
    expect(publishEvent).toHaveBeenCalledWith(ACCOUNT, {
      type: 'channel_status',
      channelId: CHANNEL,
      name: 'GoLinkAsaas',
      status: 'connected',
    })
  })

  it('estima os e-mails que chegaram enquanto estava parado (mesma caixa)', async () => {
    // Último lido 129, próximo UID 142 → 130..141 = 12 atrasados.
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toEqual({
      ok: true,
      pollResumesNow: true,
      mailboxMatches: true,
      backlogEstimate: 12,
    })
  })

  it('caixa com outra época de UIDs: mailboxMatches false e sem estimativa', async () => {
    verify.imap.mockResolvedValue({ uidValidity: '99', uidNext: 5 })
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: true,
      mailboxMatches: false,
      backlogEstimate: null,
    })
  })

  it('canal que nunca leu a caixa: mailboxMatches null', async () => {
    loadChannelByAccount.mockResolvedValue(
      golinkChannel({ gmailUidValidity: undefined, gmailLastUid: undefined }),
    )
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: true,
      mailboxMatches: null,
      backlogEstimate: null,
    })
  })

  it('canal apagado entre a leitura e a gravação: 404, sem limpar a espera', async () => {
    dbm.returningRows = []
    await new FakeRedis().set(`gmail:authfail:${CHANNEL}`, 'x', 'PX', 30 * 60_000)
    await expect(replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)).resolves.toMatchObject({
      ok: false,
      httpStatus: 404,
    })
    expect(redisStore.has(`gmail:authfail:${CHANNEL}`)).toBe(true)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('não loga a senha', async () => {
    await replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)
    verify.smtp.mockRejectedValue(new GmailVerifyError('auth', 'smtp', 'EAUTH'))
    await replaceGmailAppPassword(ACCOUNT, CHANNEL, NEW_PW)
    const logs = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]
      .map((c) => c.join(' '))
      .join('\n')
    expect(logs).toContain(CHANNEL)
    expect(logs).not.toContain(NEW_PW)
  })
})

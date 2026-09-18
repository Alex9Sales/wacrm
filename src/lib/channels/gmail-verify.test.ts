import { beforeEach, describe, expect, it, vi } from 'vitest'

// 15/09 (GoLink): a troca de senha testa a senha nova no Google. O login IMAP
// recusado deixava o socket aberto e derrubava o processo depois — a
// verificação tem que ouvir 'error' e fechar a conexão.

const imap = vi.hoisted(() => ({
  instances: [] as Array<{
    opts: { auth: { user: string; pass: string } }
    connect: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    usable: boolean
  }>,
  connectError: null as unknown,
  statusResult: { path: 'INBOX', uidValidity: BigInt(1), uidNext: 131 } as Record<string, unknown>,
}))

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = false
    opts: unknown
    connect = vi.fn(async () => {
      if (imap.connectError) throw imap.connectError
      this.usable = true
    })
    close = vi.fn(() => {
      this.usable = false
    })
    logout = vi.fn(async () => {
      this.usable = false
    })
    status = vi.fn(async () => imap.statusResult)
    on = vi.fn(() => this)
    constructor(opts: unknown) {
      this.opts = opts
      imap.instances.push(this as never)
    }
  },
}))

const smtp = vi.hoisted(() => ({
  verifyError: null as unknown,
  created: [] as Array<{ auth: { user: string; pass: string } }>,
  close: vi.fn(),
}))

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: { auth: { user: string; pass: string } }) => {
      smtp.created.push(opts)
      return {
        verify: async () => {
          if (smtp.verifyError) throw smtp.verifyError
          return true
        },
        close: smtp.close,
      }
    },
  },
}))

import { GmailVerifyError, verifyGmailImap, verifyGmailSmtp } from './gmail-verify'

const imapAuthError = Object.assign(new Error('Command failed'), {
  authenticationFailed: true,
  responseStatus: 'NO',
  serverResponseCode: 'AUTHENTICATIONFAILED',
  responseText: 'Invalid credentials (Failure)',
  executedCommand: '3 LOGIN "cobranca.exemplo@gmail.com" "abcdabcdabcdabcd"',
})

beforeEach(() => {
  imap.instances.length = 0
  imap.connectError = null
  imap.statusResult = { path: 'INBOX', uidValidity: BigInt(1), uidNext: 131 }
  smtp.verifyError = null
  smtp.created.length = 0
  smtp.close.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('verifyGmailImap', () => {
  it('login recusado: fecha a conexão, ouve "error" e devolve kind auth', async () => {
    imap.connectError = imapAuthError
    const err = await verifyGmailImap('cobranca.exemplo@gmail.com', 'abcd abcd abcd abcd').catch((e) => e)
    expect(err).toBeInstanceOf(GmailVerifyError)
    expect(err).toMatchObject({ kind: 'auth', step: 'imap', code: 'AUTHENTICATIONFAILED' })
    const [client] = imap.instances
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(client.close).toHaveBeenCalled()
    expect(client.status).not.toHaveBeenCalled()
  })

  it('o erro não carrega a senha nem o comando de login', async () => {
    imap.connectError = imapAuthError
    const err = (await verifyGmailImap('cobranca.exemplo@gmail.com', 'abcdabcdabcdabcd').catch(
      (e) => e,
    )) as GmailVerifyError
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('abcdabcdabcdabcd')
  })

  it('falha de rede: kind network (e também fecha)', async () => {
    imap.connectError = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    await expect(verifyGmailImap('a@gmail.com', 'abcdabcdabcdabcd')).rejects.toMatchObject({
      kind: 'network',
      step: 'imap',
    })
    expect(imap.instances[0].close).toHaveBeenCalled()
  })

  it('ok: STATUS da INBOX sem SELECT, normaliza login e sai com logout', async () => {
    await expect(verifyGmailImap('  Cobranca.Exemplo@Gmail.com ', 'abcd efgh ijkl mnop')).resolves.toEqual({
      uidValidity: '1',
      uidNext: 131,
    })
    const [client] = imap.instances
    expect(client.opts.auth).toEqual({ user: 'cobranca.exemplo@gmail.com', pass: 'abcdefghijklmnop' })
    expect(client.status).toHaveBeenCalledWith('INBOX', { uidValidity: true, uidNext: true })
    expect(client.logout).toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('STATUS sem UIDVALIDITY conta como falha de rede (não grava ponto errado)', async () => {
    imap.statusResult = { path: 'INBOX', uidNext: 131 }
    await expect(verifyGmailImap('a@gmail.com', 'abcdabcdabcdabcd')).rejects.toMatchObject({
      kind: 'network',
      step: 'imap',
    })
    expect(imap.instances[0].logout).toHaveBeenCalled()
  })
})

describe('verifyGmailSmtp', () => {
  it('535 / EAUTH → kind auth, e fecha o transporte', async () => {
    smtp.verifyError = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
      code: 'EAUTH',
      responseCode: 535,
    })
    await expect(verifyGmailSmtp('a@gmail.com', 'abcdabcdabcdabcd')).rejects.toMatchObject({
      kind: 'auth',
      step: 'smtp',
    })
    expect(smtp.close).toHaveBeenCalled()
  })

  it('timeout → kind network', async () => {
    smtp.verifyError = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })
    await expect(verifyGmailSmtp('a@gmail.com', 'abcdabcdabcdabcd')).rejects.toMatchObject({
      kind: 'network',
      step: 'smtp',
    })
  })

  it('ok: normaliza endereço e senha como na criação do canal', async () => {
    await expect(verifyGmailSmtp(' A@Gmail.com', 'abcd abcd abcd abcd')).resolves.toBeUndefined()
    expect(smtp.created[0].auth).toEqual({ user: 'a@gmail.com', pass: 'abcdabcdabcdabcd' })
    expect(smtp.close).toHaveBeenCalled()
  })
})

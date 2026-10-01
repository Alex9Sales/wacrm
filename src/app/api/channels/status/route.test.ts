import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// GET /api/channels/status — o banner global lê daqui. 01/10: canal de TOKEN
// (Instagram/Messenger/WhatsApp oficial) derrubado pela Meta agora vem com
// `problem` em PT curto; e nada do provider_meta (motivo cru, ids) vaza.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(h.rows),
      }),
    })),
  }
  return { ...actual, db }
})

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(async () => ({ accountId: 'acct-1', userId: 'user-1', role: 'agent' })),
  toErrorResponse: vi.fn(() => new Response('erro', { status: 500 })),
}))

// Canais de token não têm getState: o reconcile não toca neles. O de QR aqui
// também não é consultado (o provider do teste não tem getState).
vi.mock('@/lib/channels/registry', () => ({
  getProvider: vi.fn(() => ({})),
}))
vi.mock('@/lib/channels/channels', () => ({
  loadChannelByAccount: vi.fn(async () => null),
  updateChannelStatus: vi.fn(async () => {}),
}))

import { GET } from './route'

const SESSION_INVALIDATED =
  'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons. [code=190 subcode=460 fbtrace_id=AbCdEf123]'

describe('GET /api/channels/status', () => {
  it('Instagram marcado pelo monitor vem com a frase traduzida, sem o texto cru', async () => {
    h.rows = [
      {
        id: 'ig-1',
        provider: 'instagram',
        name: 'Instagram @loja',
        status: 'disconnected',
        phoneNumber: null,
        providerMeta: {
          ig_id: '17841400000000000',
          health: { state: 'needs_reconnect', reason: SESSION_INVALIDATED, at: '2026-10-01T18:30:00Z' },
        },
      },
      {
        id: 'meta-1',
        provider: 'meta',
        name: 'WhatsApp (Meta)',
        status: 'connected',
        phoneNumber: '5500000000000',
        providerMeta: { phone_number_id: 'PNID-1', health: { last_verdict: 'ok' } },
      },
    ]
    const res = await GET()
    const json = (await res.json()) as { channels: Array<Record<string, unknown>> }

    const ig = json.channels.find((c) => c.id === 'ig-1')!
    expect(ig.problem).toBe('a senha foi trocada ou o Facebook encerrou a sessão por segurança')
    expect(ig.status).toBe('disconnected')
    expect(json.channels.find((c) => c.id === 'meta-1')!.problem).toBeNull()

    const body = JSON.stringify(json)
    expect(body).not.toMatch(/fbtrace|17841400000000000|provider_?meta|PNID-1/i)
  })

  it('canal de QR continua sem problem (o banner usa o status) e Gmail segue pela saúde dele', async () => {
    h.rows = [
      { id: 'w1', provider: 'waha', name: 'Comercial', status: 'error', phoneNumber: null, providerMeta: {} },
      { id: 'g1', provider: 'gmail', name: 'Gmail', status: 'connected', phoneNumber: null, providerMeta: {} },
    ]
    const res = await GET()
    const json = (await res.json()) as { channels: Array<Record<string, unknown>> }
    expect(json.channels.map((c) => c.problem)).toEqual([null, null])
  })
})

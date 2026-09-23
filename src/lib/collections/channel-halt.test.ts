import { describe, expect, it, vi } from 'vitest'

// Só interessa a DECISÃO (a parte pura). Banco, provedores e Redis ficam de fora.
vi.mock('@/db', () => ({ db: {}, channels: {} }))
vi.mock('@/lib/channels/channels', () => ({ listChannels: vi.fn(), updateChannelStatus: vi.fn() }))
vi.mock('@/lib/channels/registry', () => ({ getProvider: vi.fn() }))
vi.mock('@/lib/ai/self-message', () => ({ markSelfMessage: vi.fn() }))
vi.mock('@/lib/ai/reply-marker', () => ({ bumpCounter: vi.fn() }))
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: vi.fn() }))

import { collectionChannelHalt } from './channel-halt'

const conectado = { id: 'a', name: 'Cobranças', status: 'connected' }
const caido = { id: 'b', name: 'Cobranças', status: 'error' }

describe('collectionChannelHalt — a régua não cobra por um número fora do ar (GoLink 22/09)', () => {
  it('número escolhido conectado: pode cobrar', () => {
    expect(collectionChannelHalt({ channel: 'whatsapp', chosen: conectado, whatsapp: [conectado] })).toEqual({ ok: true })
  })

  it('número escolhido caído: para, dizendo qual número e o que fazer', () => {
    const r = collectionChannelHalt({ channel: 'whatsapp', chosen: caido, whatsapp: [caido, conectado] })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('era para ter parado')
    expect(r.reason).toContain('Cobranças')
    expect(r.reason).toContain('sessão caiu')
    expect(r.reason).toContain('Canais')
  })

  it('sem número escolhido: basta um conectado', () => {
    expect(collectionChannelHalt({ channel: 'whatsapp', chosen: null, whatsapp: [caido, conectado] })).toEqual({ ok: true })
    expect(collectionChannelHalt({ channel: 'whatsapp', chosen: null, whatsapp: [caido] }).ok).toBe(false)
  })

  it('conta sem nenhum número de WhatsApp: para quando o canal é WhatsApp…', () => {
    expect(collectionChannelHalt({ channel: 'whatsapp', chosen: null, whatsapp: [] }).ok).toBe(false)
  })

  it('…mas no automático (padrão) quem só tem e-mail segue cobrando', () => {
    expect(collectionChannelHalt({ channel: 'auto', chosen: null, whatsapp: [] })).toEqual({ ok: true })
    // Com número cadastrado e caído, aí sim para.
    expect(collectionChannelHalt({ channel: 'auto', chosen: null, whatsapp: [caido] }).ok).toBe(false)
  })

  it('conta que cobra por e-mail não depende de WhatsApp nenhum', () => {
    expect(collectionChannelHalt({ channel: 'email', chosen: caido, whatsapp: [caido] })).toEqual({ ok: true })
  })

  it('"os dois" (WhatsApp + e-mail) segue a regra do WhatsApp', () => {
    expect(collectionChannelHalt({ channel: 'both', chosen: caido, whatsapp: [caido] }).ok).toBe(false)
    expect(collectionChannelHalt({ channel: 'both', chosen: conectado, whatsapp: [conectado] }).ok).toBe(true)
  })
})

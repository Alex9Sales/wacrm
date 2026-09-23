import { describe, expect, it, vi } from 'vitest'

// O que importa aqui é o RECONHECIMENTO do erro de canal. Banco, provedores e
// Redis ficam de fora.
vi.mock('@/db', () => ({ db: {}, channels: {}, conversations: {} }))
vi.mock('@/db/helpers', () => ({ firstOrNull: (r: unknown[]) => r[0] ?? null }))
vi.mock('@/lib/channels/channels', () => ({ listChannels: vi.fn(), updateChannelStatus: vi.fn() }))
vi.mock('@/lib/channels/registry', () => ({ getProvider: vi.fn() }))
vi.mock('@/lib/ai/self-message', () => ({ markSelfMessage: vi.fn() }))
vi.mock('@/lib/ai/reply-marker', () => ({ bumpCounter: vi.fn() }))
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: vi.fn() }))

import { channelHaltReason } from './channel-halt'

describe('erro que é do NÚMERO, não do devedor (GoLink 22/09)', () => {
  it('a sessão caída do dia 22 é reconhecida', () => {
    // Mensagem como ela chegou nos 142 envios falhados daquele dia.
    expect(channelHaltReason('Request failed with status code 422: Session status is not as expected')).toBe('session_down')
    expect(channelHaltReason('session not found')).toBe('session_down')
    expect(channelHaltReason('device removed')).toBe('session_down')
    expect(channelHaltReason('you are logged out')).toBe('session_down')
    expect(channelHaltReason('SCAN_QR')).toBe('session_down')
  })

  it('reputação (463) é o sinal de que insistir queima o número', () => {
    expect(channelHaltReason('server returned error 463')).toBe('reputation')
    expect(channelHaltReason('error 462')).toBe('reputation')
  })

  it('problema DO DEVEDOR não para nada: é falha daquele envio só', () => {
    expect(channelHaltReason('número não tem WhatsApp')).toBeNull()
    expect(channelHaltReason('Sem texto pra enviar.')).toBeNull()
    expect(channelHaltReason('recipient not found')).toBeNull()
    expect(channelHaltReason('')).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {}, channels: {} }))

import { igTokenDaysLeft, igTokenExpiresAt, looksLikeAppScopedId } from './instagram-health'
import { isInstagramAuthError } from './providers/instagram'
import type { ChannelCtx } from './provider'

// 24/09 (Isabele/Zelo): a automação de comentário "não deu". Três causas
// empilhadas — token vencido no dia anterior, canal ainda escrito "Conectado",
// e o ig_id guardado era o app-scoped (28…) em vez do id da conta
// profissional (17841…), que é o único que o webhook e o subscribed_apps usam.

const canal = (meta: Record<string, unknown>): ChannelCtx => ({
  id: 'ch1',
  accountId: 'acc1',
  provider: 'instagram',
  name: 'Instagram Direct',
  phoneNumber: null,
  credentials: { accessToken: 'IGAA…' },
  providerMeta: meta,
  settings: {},
  webhookSecret: '',
})

describe('looksLikeAppScopedId — o id que não serve pra nada', () => {
  it('o id da conta profissional (17841…) passa', () => {
    expect(looksLikeAppScopedId('17841400841612810')).toBe(false)
    expect(looksLikeAppScopedId('17841438988720012')).toBe(false)
  })

  it('o app-scoped que o OAuth devolve (28…) é recusado — foi o caso da Zelo', () => {
    expect(looksLikeAppScopedId('28342455615434984')).toBe(true)
  })

  it('id vazio não é "app-scoped": é ausência, e quem chama trata separado', () => {
    expect(looksLikeAppScopedId(null)).toBe(false)
    expect(looksLikeAppScopedId('')).toBe(false)
  })
})

describe('isInstagramAuthError — token morto x qualquer outro erro', () => {
  it('reconhece o 190 e a mensagem de sessão vencida', () => {
    expect(isInstagramAuthError({ code: 190 })).toBe(true)
    expect(
      isInstagramAuthError({ message: 'Error validating access token: Session has expired on Wednesday, 23-Sep-26' }),
    ).toBe(true)
  })

  it('o 400 do id errado NÃO é token vencido — senão mandaríamos reconectar à toa', () => {
    expect(isInstagramAuthError({ code: 100, message: 'Unsupported request - method type: post' })).toBe(false)
    expect(isInstagramAuthError(null)).toBe(false)
  })
})

describe('validade do token', () => {
  const agora = new Date('2026-09-24T12:00:00Z')

  it('conta os dias que faltam', () => {
    const ch = canal({ token_expires_at: '2026-10-14T12:00:00Z' })
    expect(igTokenDaysLeft(ch, agora)).toBe(20)
  })

  it('token já vencido dá dias negativos (não zero)', () => {
    const ch = canal({ token_expires_at: '2026-09-23T20:00:00Z' })
    expect(igTokenDaysLeft(ch, agora)).toBeLessThan(0)
  })

  it('sem data guardada, não inventamos uma — null quer dizer "não sei"', () => {
    expect(igTokenExpiresAt(canal({}))).toBeNull()
    expect(igTokenDaysLeft(canal({}), agora)).toBeNull()
    expect(igTokenDaysLeft(canal({ token_expires_at: 'qualquer coisa' }), agora)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { classifyMetaHealth } from './meta-health'

describe('classifyMetaHealth — veredito a partir da resposta da Graph', () => {
  it('número conectado e liberado → ok', () => {
    const v = classifyMetaHealth({
      httpStatus: 200,
      body: { status: 'CONNECTED', platform_type: 'CLOUD_API', health_status: { can_send_message: 'AVAILABLE' } },
    })
    expect(v.verdict).toBe('ok')
  })

  it('objeto não existe / sem permissão (caso 4092) → dead', () => {
    const v = classifyMetaHealth({
      httpStatus: 400,
      body: { error: { code: 100, message: "Unsupported get request. Object with ID '123' does not exist, cannot be loaded due to missing permissions" } },
    })
    expect(v.verdict).toBe('dead')
    expect(v.reason).toMatch(/não existe|permiss/i)
  })

  it('token inválido/expirado (190) → dead', () => {
    const v = classifyMetaHealth({ httpStatus: 401, body: { error: { code: 190, message: 'Error validating access token' } } })
    expect(v.verdict).toBe('dead')
  })

  it('status DISCONNECTED ou can_send BLOCKED → dead', () => {
    expect(classifyMetaHealth({ httpStatus: 200, body: { status: 'DISCONNECTED' } }).verdict).toBe('dead')
    expect(
      classifyMetaHealth({ httpStatus: 200, body: { status: 'CONNECTED', health_status: { can_send_message: 'BLOCKED' } } }).verdict,
    ).toBe('dead')
  })

  it('FLAGGED / LIMITED → warn (não derruba)', () => {
    expect(classifyMetaHealth({ httpStatus: 200, body: { status: 'FLAGGED' } }).verdict).toBe('warn')
    expect(
      classifyMetaHealth({ httpStatus: 200, body: { status: 'CONNECTED', health_status: { can_send_message: 'LIMITED' } } }).verdict,
    ).toBe('warn')
  })

  it('rede fora, 5xx, 429 e rate-limit da Graph → transient (não mexe no status)', () => {
    expect(classifyMetaHealth({ networkError: 'fetch failed' }).verdict).toBe('transient')
    expect(classifyMetaHealth({ httpStatus: 503, body: {} }).verdict).toBe('transient')
    expect(classifyMetaHealth({ httpStatus: 429, body: { error: { code: 4, message: 'rate' } } }).verdict).toBe('transient')
    expect(classifyMetaHealth({ httpStatus: 400, body: { error: { code: 613, message: 'Calls to this api have exceeded the rate limit' } } }).verdict).toBe('transient')
  })

  it('erro desconhecido da Graph → transient (nunca derruba por palpite)', () => {
    expect(classifyMetaHealth({ httpStatus: 400, body: { error: { code: 999, message: 'weird' } } }).verdict).toBe('transient')
  })
})

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

  it('status DISCONNECTED ou can_send BLOCKED (sem detalhe de entidade) → dead', () => {
    expect(classifyMetaHealth({ httpStatus: 200, body: { status: 'DISCONNECTED' } }).verdict).toBe('dead')
    expect(
      classifyMetaHealth({ httpStatus: 200, body: { status: 'CONNECTED', health_status: { can_send_message: 'BLOCKED' } } }).verdict,
    ).toBe('dead')
  })

  it('WABA bloqueada SÓ por pagamento (141006) → warn, não derruba (caso Fluxia 07/09)', () => {
    const v = classifyMetaHealth({
      httpStatus: 200,
      body: {
        status: 'CONNECTED',
        is_on_biz_app: true,
        health_status: {
          can_send_message: 'BLOCKED',
          entities: [
            { entity_type: 'PHONE_NUMBER', id: '1', can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet.'] },
            { entity_type: 'WABA', id: '2', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'There is an error with the payment method. This will block business initiated conversations.' }] },
            { entity_type: 'BUSINESS', id: '3', can_send_message: 'AVAILABLE' },
            { entity_type: 'APP', id: '4', can_send_message: 'AVAILABLE' },
          ],
        },
      },
    })
    expect(v.verdict).toBe('warn')
    expect(v.reason).toMatch(/pagamento/i)
    expect(v.reason).toMatch(/responder em 24h seguem/i)
  })

  it('NÚMERO bloqueado, ou WABA bloqueada por outro motivo → dead (com o motivo da Meta)', () => {
    const numero = classifyMetaHealth({
      httpStatus: 200,
      body: { status: 'CONNECTED', health_status: { can_send_message: 'BLOCKED', entities: [{ entity_type: 'PHONE_NUMBER', id: '1', can_send_message: 'BLOCKED', errors: [{ error_code: 131000, error_description: 'Phone number is restricted' }] }] } },
    })
    expect(numero.verdict).toBe('dead')
    expect(numero.reason).toMatch(/restricted/i)
    const waba = classifyMetaHealth({
      httpStatus: 200,
      body: { status: 'CONNECTED', health_status: { can_send_message: 'BLOCKED', entities: [{ entity_type: 'WABA', id: '2', can_send_message: 'BLOCKED', errors: [{ error_code: 141002, error_description: 'WABA is banned' }] }] } },
    })
    expect(waba.verdict).toBe('dead')
  })

  it('LIMITED por nome de exibição pendente → warn explicando', () => {
    const v = classifyMetaHealth({
      httpStatus: 200,
      body: { status: 'CONNECTED', health_status: { can_send_message: 'LIMITED', entities: [{ entity_type: 'PHONE_NUMBER', id: '1', can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet. Your message limit will increase after the display name is approved.'] }] } },
    })
    expect(v.verdict).toBe('warn')
    expect(v.reason).toMatch(/nome de exibição/i)
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

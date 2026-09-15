import { describe, expect, it } from 'vitest'

import {
  defaultStageChannelId,
  hasSendableEmail,
  stageBroadcastNote,
  stageChannelKind,
  validateStageBroadcastBasics,
  type StageChannelOption,
} from './stage-broadcast'

// 15/09 (GoLink): disparo pela etapa com os tipos dos Disparos.
const VITOR = 'u-vitor'
const LEONARDO = 'u-leonardo'

describe('stageChannelKind', () => {
  it('o tipo segue o canal', () => {
    expect(stageChannelKind('waha')).toBe('text')
    expect(stageChannelKind('evogo')).toBe('text')
    expect(stageChannelKind('gmail')).toBe('email')
    expect(stageChannelKind('email')).toBe('email')
    expect(stageChannelKind('meta')).toBe('template')
    expect(stageChannelKind('instagram')).toBeNull()
  })
})

describe('defaultStageChannelId', () => {
  const golink: StageChannelOption[] = [
    { id: 'atendimento', kind: 'text', dedicated_user_id: LEONARDO, dedicated_user_name: 'Leonardo', status: 'connected' },
    { id: 'oficial', kind: 'template', dedicated_user_id: null, status: 'connected' },
    { id: 'gmail-vitor', kind: 'email', dedicated_user_id: VITOR, status: 'connected' },
    { id: 'vitor', kind: 'text', dedicated_user_id: VITOR, status: 'connected' },
  ]

  it('WhatsApp de quem dispara vem antes do Gmail dele e da API oficial', () => {
    expect(defaultStageChannelId(golink, VITOR)).toBe('vitor')
  })

  it('sem WhatsApp próprio nem livre: API oficial livre, não o número do Leonardo', () => {
    expect(defaultStageChannelId(golink, 'u-wilian')).toBe('oficial')
  })

  it('número próprio desconectado não é padrão', () => {
    const list: StageChannelOption[] = [
      { id: 'vitor', kind: 'text', dedicated_user_id: VITOR, status: 'disconnected' },
      { id: 'empresa', kind: 'text', dedicated_user_id: null, status: 'connected' },
    ]
    expect(defaultStageChannelId(list, VITOR)).toBe('empresa')
  })

  it('nada conectado e de ninguém: regra de Disparos (meu → sem dono → o primeiro)', () => {
    const list: StageChannelOption[] = [
      { id: 'gmail-leo', kind: 'email', dedicated_user_id: LEONARDO, status: 'connected' },
      { id: 'atendimento', kind: 'text', dedicated_user_id: LEONARDO, status: 'connected' },
    ]
    expect(defaultStageChannelId(list, VITOR)).toBe('atendimento')
    expect(defaultStageChannelId([], VITOR)).toBe('')
  })
})

describe('validateStageBroadcastBasics', () => {
  it('canal e tipo', () => {
    expect(validateStageBroadcastBasics({ kind: 'text', text: 'oi' }, 'text')).toBe('Escolha o canal.')
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'text', text: 'oi' }, null)).toMatch(/não faz disparo/)
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'text', text: 'oi' }, 'email')).toBe(
      'Este canal é de E-mail. Abra o disparo de novo e escolha o canal.',
    )
  })

  it('WhatsApp: texto ou anexo', () => {
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'text', text: ' ' }, 'text')).toBe(
      'Escreva a mensagem ou anexe um arquivo.',
    )
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'text', media: [{}] }, 'text')).toBeNull()
    expect(
      validateStageBroadcastBasics({ channelId: 'c', kind: 'text', text: 'oi', media: Array(11).fill({}) }, 'text'),
    ).toBe('Máximo de 10 anexos por disparo.')
  })

  it('e-mail: assunto obrigatório', () => {
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'email', text: 'oi' }, 'email')).toBe(
      'Informe o assunto do e-mail.',
    )
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'email', subject: 'Dia do cliente', text: 'oi' }, 'email')).toBeNull()
  })

  it('template: escolher o template', () => {
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'template' }, 'template')).toBe(
      'Escolha o template aprovado.',
    )
    expect(validateStageBroadcastBasics({ channelId: 'c', kind: 'template', templateName: 'promo' }, 'template')).toBeNull()
  })
})

describe('hasSendableEmail', () => {
  it('mesmo teste do motor', () => {
    expect(hasSendableEmail('andressa@clinica.com.br')).toBe(true)
    expect(hasSendableEmail(' andressa@clinica ')).toBe(false)
    expect(hasSendableEmail(null)).toBe(false)
  })
})

describe('stageBroadcastNote', () => {
  it('uma nota por tipo', () => {
    expect(stageBroadcastNote('text', { text: 'Oi {{primeiro_nome}}' })).toBe(
      '📣 Disparo enviado (etapa, WhatsApp): Oi {{primeiro_nome}}',
    )
    expect(stageBroadcastNote('text', { text: 'Oi', mediaCount: 2 })).toBe('📣 Disparo enviado (etapa, WhatsApp): Oi (+ 2 anexos)')
    expect(stageBroadcastNote('text', { mediaCount: 1 })).toBe('📣 Disparo enviado (etapa, WhatsApp): 1 anexo')
    expect(stageBroadcastNote('email', { subject: 'Dia do cliente' })).toBe('📣 Disparo enviado (etapa, E-mail): Dia do cliente')
    expect(stageBroadcastNote('template', { templateName: 'dia_do_cliente' })).toBe(
      '📣 Disparo enviado (etapa, Template dia_do_cliente)',
    )
  })

  it('texto longo é cortado em 80', () => {
    expect(stageBroadcastNote('text', { text: 'a'.repeat(100) })).toBe(`📣 Disparo enviado (etapa, WhatsApp): ${'a'.repeat(80)}…`)
  })
})

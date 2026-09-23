import { describe, expect, it } from 'vitest'

import {
  bareAddress,
  isResendReceivedEvent,
  isResendWebhookEvent,
  resendEmailDeliveredTo,
  resendEmailToInboundJson,
  resendRecipientCandidates,
} from './email-resend-inbound'

const evento = {
  type: 'email.received' as const,
  created_at: '2026-09-23T02:17:00.000Z',
  data: {
    email_id: '01a0cc44-443f-74f1-8c15-7cc2da1854f5',
    from: 'Fulano <fulano@exemplo.com>',
    to: ['financeiro@empresa.com'],
    cc: ['Contato <contato@empresa.com>'],
    bcc: [],
    received_for: ['financeiro@empresa.com'],
    subject: 'Atendimento',
    message_id: '<abc@exemplo.com>',
    attachments: [],
  },
}

describe('evento email.received do Resend', () => {
  it('reconhece o evento de recebimento e ignora os outros tipos', () => {
    expect(isResendReceivedEvent(evento)).toBe(true)
    expect(isResendWebhookEvent({ type: 'email.delivered', data: {} })).toBe(true)
    expect(isResendReceivedEvent({ type: 'email.delivered', data: { email_id: 'x' } })).toBe(false)
    expect(isResendReceivedEvent({ type: 'email.received', data: {} })).toBe(false)
  })

  it('o JSON do Cloudflare Worker NÃO é evento do Resend', () => {
    expect(isResendWebhookEvent({ to: 'a@b.com', from: 'c@d.com', text: 'oi' })).toBe(false)
    expect(isResendReceivedEvent(null)).toBe(false)
  })

  it('candidatos a canal: a caixa que recebeu primeiro, depois To/Cc/Cco, sem repetir e sem nome', () => {
    expect(resendRecipientCandidates(evento)).toEqual(['financeiro@empresa.com', 'contato@empresa.com'])
  })

  it('bareAddress tira o nome e baixa a caixa', () => {
    expect(bareAddress('Fulano <Fulano@Exemplo.com>')).toBe('fulano@exemplo.com')
    expect(bareAddress(' x@y.com ')).toBe('x@y.com')
    expect(bareAddress(null)).toBe('')
  })
})

describe('e-mail buscado na API → JSON da rota', () => {
  const email = {
    id: '01a0cc44',
    from: 'Fulano <fulano@exemplo.com>',
    to: ['financeiro@empresa.com'],
    received_for: ['financeiro@empresa.com'],
    subject: 'Atendimento',
    html: '<p>oi</p>',
    text: 'oi',
    message_id: '<abc@exemplo.com>',
    attachments: [],
  }

  it('to = endereço do canal; remetente sem nome; messageId = Message-ID do e-mail', () => {
    const j = resendEmailToInboundJson(email, 'financeiro@empresa.com', [])
    expect(j).toMatchObject({ to: 'financeiro@empresa.com', from: 'fulano@exemplo.com', fromName: 'Fulano', subject: 'Atendimento', text: 'oi', messageId: '<abc@exemplo.com>' })
  })

  it('sem Message-ID cai no id do Resend (dedupe continua valendo)', () => {
    expect(resendEmailToInboundJson({ ...email, message_id: '' }, 'financeiro@empresa.com', []).messageId).toBe('resend:01a0cc44')
  })

  it('conferência final: o e-mail buscado tem que ter chegado no endereço do canal', () => {
    expect(resendEmailDeliveredTo(email, 'Financeiro@Empresa.com')).toBe(true)
    expect(resendEmailDeliveredTo(email, 'outro@empresa.com')).toBe(false)
    expect(resendEmailDeliveredTo({ ...email, to: ['x@y.com'], cc: ['Contato <financeiro@empresa.com>'] }, 'financeiro@empresa.com')).toBe(true)
  })
})

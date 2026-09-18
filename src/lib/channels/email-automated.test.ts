import { describe, expect, it } from 'vitest'

import { automatedSenderReason, ignoredAutomatedOf, ignoresAutomatedEmail } from './email-automated'

// 15/09 (GoLink): remetentes REAIS que entraram no inbox quando a leitura do
// Gmail voltou — todos têm que ser reconhecidos como automáticos.
describe('automatedSenderReason', () => {
  it.each([
    'no-reply@accounts.google.com',
    'noreply-accounts@google.com',
    'no-reply-abc123exemplo-7xyz@mail.anthropic.com',
    'noreply@tm.openai.com',
    'notifications@link.com',
    'no-reply@email.claude.com',
    'noreply@email.openai.com',
    'no-reply@google.com',
    'no-reply@asana.com',
    'news@insideapple.apple.com',
    'nao-responda@asaas.com.br',
    'mailer-daemon@googlemail.com',
    'bounces+123@mail.exemplo.com',
  ])('%s é robô', (from) => {
    expect(automatedSenderReason({ from })).not.toBeNull()
  })

  it('cabeçalhos de envio automático valem mesmo com endereço comum', () => {
    expect(automatedSenderReason({ from: 'invoice+statements@mail.anthropic.com', headers: [{ key: 'auto-submitted', value: 'auto-generated' }] })).toContain('auto-submitted')
    expect(automatedSenderReason({ from: 'learn@email1.asana.com', headers: [{ key: 'list-unsubscribe', value: '<https://x/unsub>' }] })).toContain('lista')
    expect(automatedSenderReason({ from: 'avisos@loja.com', headers: [{ key: 'precedence', value: 'bulk' }] })).toContain('precedence')
  })

  it.each([
    'financeiro@empresa-exemplo.com.br',
    'joao.silva@gmail.com',
    'contato@loja.com',
    'noreplyer@gmail.com',
    'paulo@oficina-modelo.com.br',
  ])('%s é pessoa', (from) => {
    expect(automatedSenderReason({ from })).toBeNull()
  })

  it('Auto-Submitted: no é pessoa', () => {
    expect(automatedSenderReason({ from: 'cliente@x.com', headers: [{ key: 'auto-submitted', value: 'no' }] })).toBeNull()
  })

  it('a opção do canal só liga com true explícito', () => {
    expect(ignoresAutomatedEmail({ ignoreAutomated: true })).toBe(true)
    expect(ignoresAutomatedEmail({ ignoreAutomated: 'true' })).toBe(false)
    expect(ignoresAutomatedEmail({})).toBe(false)
    expect(ignoresAutomatedEmail(null)).toBe(false)
  })
})

// Revisão 15/09: e-mail de gente que chega por Grupo do Google, formulário.
describe('automatedSenderReason — casos de gente', () => {
  it('cliente escrevendo pro Grupo do Google da empresa (financeiro@) é pessoa', () => {
    expect(
      automatedSenderReason({
        from: 'joao@devedor.com.br',
        channelAddress: 'vendedor@empresa-exemplo.com.br',
        headers: [
          { key: 'precedence', value: 'list' },
          { key: 'list-id', value: '<cobranca.empresa-exemplo.com.br>' },
          { key: 'x-google-group-id', value: '123' },
          { key: 'list-unsubscribe', value: '<mailto:cobranca+unsubscribe@empresa-exemplo.com.br>' },
        ],
      }),
    ).toBeNull()
  })

  it('newsletter de fora continua sendo robô', () => {
    expect(automatedSenderReason({ from: 'learn@email1.asana.com', channelAddress: 'cobranca.exemplo@gmail.com', headers: [{ key: 'list-unsubscribe', value: '<https://x>' }] })).not.toBeNull()
  })

  it('aviso de formulário: From de robô com Reply-To do lead é pessoa', () => {
    expect(automatedSenderReason({ from: 'no-reply@crm.wix.com', replyTo: 'joao@gmail.com' })).toBeNull()
  })

  it('recibo com Reply-To de suporte e lista continua robô', () => {
    expect(automatedSenderReason({ from: 'invoice+statements@mail.anthropic.com', replyTo: 'support@anthropic.com', headers: [{ key: 'list-unsubscribe', value: '<https://x>' }] })).not.toBeNull()
    expect(automatedSenderReason({ from: 'no-reply@accounts.google.com', replyTo: 'support@google.com' })).not.toBeNull()
  })
})

describe('ignoredAutomatedOf', () => {
  it('lê o rastro gravado no canal', () => {
    const r = ignoredAutomatedOf({ ignoredAutomatedCount: 3, ignoredAutomated: [{ from: 'no-reply@google.com', reason: 'x', at: '2026-09-15' }, 'lixo'] })
    expect(r.count).toBe(3)
    expect(r.recent).toEqual([{ from: 'no-reply@google.com', reason: 'x', at: '2026-09-15' }])
  })
})

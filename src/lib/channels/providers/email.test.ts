import { describe, it, expect } from 'vitest'

import { emailProvider } from '@/lib/channels/providers/email'

describe('email provider — parseWebhook', () => {
  it('extrai remetente (email), nome, assunto e corpo', () => {
    const { messages } = emailProvider.parseWebhook({
      from: 'Maria Silva <maria@cliente.com>',
      fromName: 'Maria Silva',
      to: 'contato@atendimento.salestecnologia.com.br',
      subject: 'Dúvida sobre o plano',
      text: 'Olá, quero saber os preços.',
      messageId: '<abc123@cliente.com>',
    })
    expect(messages).toHaveLength(1)
    const m = messages[0]
    expect(m.senderExternalId).toBe('maria@cliente.com') // identidade = e-mail
    expect(m.fromPhoneE164).toBe('')
    expect(m.senderName).toBe('Maria Silva')
    expect(m.fromMe).toBe(false)
    expect(m.contentType).toBe('text')
    expect(m.contentText).toContain('Dúvida sobre o plano') // assunto
    expect(m.contentText).toContain('quero saber os preços') // corpo
    expect(m.externalMessageId).toBe('<abc123@cliente.com>')
  })

  it('cai pro HTML quando não há texto (tira as tags)', () => {
    const { messages } = emailProvider.parseWebhook({
      from: 'joao@x.com',
      subject: '',
      html: '<p>Oi <b>tudo</b> bem?</p><br><p>Abraço</p>',
    })
    expect(messages[0].contentText).toContain('Oi tudo bem?')
    expect(messages[0].contentText).not.toContain('<')
  })

  it('sem remetente → sem mensagens', () => {
    expect(emailProvider.parseWebhook({ subject: 'x' }).messages).toHaveLength(0)
  })

  it('anexo vira mensagem de mídia separada (imagem)', () => {
    const { messages } = emailProvider.parseWebhook({
      from: 'ana@cliente.com',
      subject: 'Nota fiscal',
      text: 'Segue em anexo.',
      attachments: [
        {
          filename: 'nota.png',
          mimeType: 'image/png',
          disposition: 'attachment',
          base64: 'aGVsbG8=',
        },
      ],
    })
    // 1 texto + 1 mídia
    expect(messages).toHaveLength(2)
    expect(messages[0].contentType).toBe('text')
    const media = messages[1]
    expect(media.contentType).toBe('image')
    expect(media.media?.base64).toBe('aGVsbG8=')
    expect(media.media?.filename).toBe('nota.png')
    expect(media.externalMessageId).not.toBe(messages[0].externalMessageId) // id único
  })

  it('ignora anexo inline (logo de assinatura)', () => {
    const { messages } = emailProvider.parseWebhook({
      from: 'ana@cliente.com',
      text: 'Oi',
      attachments: [
        { filename: 'logo.png', mimeType: 'image/png', disposition: 'inline', base64: 'aGVsbG8=' },
      ],
    })
    expect(messages).toHaveLength(1) // só o texto
    expect(messages[0].contentType).toBe('text')
  })
})

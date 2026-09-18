import { describe, expect, it } from 'vitest'

import { mapsLink } from '@/lib/whatsapp/location'

import { detectLocationMessage } from './location-message'

const PIN = 'https://www.google.com/maps?q=-20.1234567,-54.7654321'

describe('detectLocationMessage — vira cartão (é uma localização)', () => {
  it('WAHA simples', () => {
    expect(detectLocationMessage(`📍 Localização\n${PIN}`)).toEqual({ header: '📍 Localização', url: PIN })
  })

  it('WAHA em tempo real', () => {
    expect(detectLocationMessage(`📍 Localização em tempo real\n${PIN}`)?.header).toBe('📍 Localização em tempo real')
  })

  it('WAHA com nome do lugar e com endereço em duas linhas', () => {
    expect(detectLocationMessage(`📍 Localização\nFamília do Gás\n${PIN}`)?.place).toBe('Família do Gás')
    expect(detectLocationMessage(`📍 Localização\nR. X, 123\nCentro\n${PIN}`)?.place).toBe('R. X, 123 · Centro')
  })

  it('CRLF e linhas vazias sobrando', () => {
    expect(detectLocationMessage(`  📍 Localização\r\n\r\n${PIN}\n `)?.url).toBe(PIN)
  })

  it('pino enviado pelo CRM (mapsLink) — trava o contrato com location.ts', () => {
    const sent = mapsLink({ lat: -20.4512, lng: -54.6034 })
    expect(detectLocationMessage(sent)).toEqual({ header: '📍 Localização', url: sent })
    expect(detectLocationMessage('https://maps.google.com/maps?q=-20,-54&z=17&hl=pt-BR')).not.toBeNull()
  })

  it('hosts do Google aceitos', () => {
    expect(detectLocationMessage('https://www.google.com.br/maps?q=-20.1,-54.2')).not.toBeNull()
    expect(detectLocationMessage('https://maps.google.com/?q=-20.1,-54.2')).not.toBeNull()
    expect(detectLocationMessage('https://www.google.com/maps?hl=pt-BR&q=-20.1,-54.2')).not.toBeNull()
  })

  it('autor de grupo com ":" no nome', () => {
    expect(detectLocationMessage(`Maria :): 📍 Localização\n${PIN}`)?.header).toBe('Maria :): 📍 Localização')
  })

  it('grupo, e grupo encaminhado para conversa 1:1', () => {
    expect(detectLocationMessage(`João: 📍 Localização\n${PIN}`)).toEqual({ header: 'João: 📍 Localização', url: PIN })
    expect(detectLocationMessage(`Ana Paula: 📍 Localização\nPadaria\n${PIN}`)).toEqual({
      header: 'Ana Paula: 📍 Localização',
      place: 'Padaria',
      url: PIN,
    })
  })
})

describe('detectLocationMessage — continua TEXTO (só contém um link)', () => {
  it('16/09: o aviso de transferência com o pino da cliente no resumo', () => {
    const aviso =
      '🔁 *IA TRANSFERIU PRA HUMANO*\n\n👤 . · 556790001234\n🏷️ Motivo: A IA pediu um humano nesta conversa\n\n' +
      `📋 Resumo: Cliente disse: Rua Exemplo 123 · 📍 Localização\n${PIN} · É esse endereço, mas o número é 123 · Quase em frente à escola do bairro\n\n` +
      'Entre na conversa pelo FluxiaCRM pra continuar o atendimento.'
    expect(detectLocationMessage(aviso)).toBeNull()
  })

  it('cliente escreve junto com o link', () => {
    expect(detectLocationMessage('minha casa é aqui https://maps.google.com/?q=-20.1,-54.2, portão azul')).toBeNull()
    expect(detectLocationMessage(`minha casa é aqui ${PIN}`)).toBeNull()
    expect(detectLocationMessage(`segue a localização\n${PIN}`)).toBeNull()
    expect(detectLocationMessage(`${PIN}\nportão azul`)).toBeNull()
    expect(detectLocationMessage(`📍 Localização\n${PIN}\nobrigado`)).toBeNull()
  })

  it('assinatura do atendente, aviso de agendamento, autor de grupo com só o link', () => {
    expect(detectLocationMessage(`*Leonardo:*\n${PIN}`)).toBeNull()
    expect(detectLocationMessage(`📅 *NOVO AGENDAMENTO*\n\n👤 Ana · 5567\n📍 ${PIN}\n\nMarcado pela página pública.`)).toBeNull()
    expect(detectLocationMessage(`João: ${PIN}`)).toBeNull()
  })

  it('cabeçalho + texto demais', () => {
    expect(detectLocationMessage(`📍 Localização\nfica perto da escola\ne do mercado\ne da igreja\n${PIN}`)).toBeNull()
    expect(detectLocationMessage(`📍 Localização\n${'x'.repeat(220)}\n${PIN}`)).toBeNull()
  })

  it('host que não é do Google', () => {
    expect(detectLocationMessage('https://google.com.evil.io/maps?q=-20.1,-54.2')).toBeNull()
    expect(detectLocationMessage('https://www.google.xyz/maps?q=-20.1,-54.2')).toBeNull()
    expect(detectLocationMessage('https://www.google.com@evil.com/maps?q=-20.1,-54.2')).toBeNull()
    expect(detectLocationMessage(`https://evil.io/?u=${PIN}`)).toBeNull()
  })

  it('sem coordenada, só o cabeçalho, vazio', () => {
    expect(detectLocationMessage('https://www.google.com/maps/@-23.5505,-46.6333,17z')).toBeNull()
    expect(detectLocationMessage('https://maps.app.goo.gl/abc123')).toBeNull()
    expect(detectLocationMessage('📍 Localização')).toBeNull()
    expect(detectLocationMessage('')).toBeNull()
    expect(detectLocationMessage(null)).toBeNull()
  })
})

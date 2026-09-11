import { describe, expect, it } from 'vitest'

import { newChargesMessage } from './emit-rules'

// Espaço fino / NBSP do toLocaleString atrapalha a leitura do teste.
const norm = (s: string) => s.replace(/ | /g, ' ')

describe('newChargesMessage — o aviso de cobrança NOVA (11/09, caso Sérgio Lemes)', () => {
  const uma = { value: 10, dueDate: '2026-09-10', description: 'Teste Asaas', url: 'https://asaas.com/i/abc' }

  it('uma cobrança sai igual ao link mandado à mão: entrega o link, não cobra', () => {
    const m = norm(newChargesMessage('Sérgio Lemes', [uma]))
    expect(m).toContain('Oi, Sérgio Lemes!')
    expect(m).toContain('R$ 10,00')
    expect(m).toContain('(Teste Asaas)')
    expect(m).toContain('vencimento em 10/09/2026')
    expect(m).toContain('https://asaas.com/i/abc')
    // É aviso, não cobrança: nada de atraso nem pressão.
    expect(m.toLowerCase()).not.toContain('atraso')
    expect(m.toLowerCase()).not.toContain('vencid')
    expect(m.toLowerCase()).not.toContain('regulariz')
  })

  it('sem nome não inventa saudação', () => {
    expect(norm(newChargesMessage(null, [uma])).startsWith('Oi! ')).toBe(true)
  })

  it('mais de uma vira uma lista só, com um link por linha', () => {
    const m = norm(
      newChargesMessage('Drogaria Imaculada', [
        uma,
        { value: 250.5, dueDate: '2026-10-01', description: '', url: 'https://asaas.com/i/def' },
      ]),
    )
    expect(m).toContain('Seguem os links para pagamento')
    expect(m).toContain('R$ 10,00 (Teste Asaas), vence 10/09/2026')
    expect(m).toContain('R$ 250,50, vence 01/10/2026')
    expect(m).toContain('https://asaas.com/i/abc')
    expect(m).toContain('https://asaas.com/i/def')
    // Uma mensagem só — não duas.
    expect(m.split('Seguem os links').length).toBe(2)
  })
})

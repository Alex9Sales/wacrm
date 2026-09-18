import { describe, expect, it } from 'vitest'

import { normalizePtBrForTts } from './tts'

// 15/09 (Alex, Família do Gás): no áudio de um pedido a voz enrolou o número da
// rua e a hora ("17h"). Só moeda e sequências de 7+ dígitos eram
// tratadas — e a regra de soletrar ainda destruía datas.
// Identificador (CPF, CNPJ, Pix, telefone, CEP) = soletrado, porque quem ouve
// anota; número comum (endereço, quantidade) = por extenso, como se fala.

describe('normalizePtBrForTts — o caso que gerou a correção', () => {
  it('endereço e hora saem falados, não enrolados', () => {
    const out = normalizePtBrForTts(
      'Fechou, Paulo! Já deixei separado um Ultragaz P-13 por R$ 125,00, para entregar na Rua Exemplo, 123. Você pode fazer o Pix às 17h, tranquilo 😊',
    )
    expect(out).toContain('pê treze')
    expect(out).toContain('cento e vinte e cinco reais')
    expect(out).toContain('Exemplo, cento e vinte e três')
    expect(out).toContain('às dezessete horas')
    expect(out).not.toMatch(/\d/)
    expect(out).not.toContain('😊')
  })
})

describe('normalizePtBrForTts — identificadores (soletrados)', () => {
  it('telefone leva o DDD junto', () => {
    expect(normalizePtBrForTts('Telefone (67) 99999-1234.')).toBe(
      'Telefone seis, sete, nove, nove, nove, nove, nove, um, dois, três, quatro.',
    )
  })

  it('CEP sai em dois blocos', () => {
    expect(normalizePtBrForTts('CEP 41770-235')).toBe('CEP quatro, um, sete, sete, zero, dois, três, cinco')
  })

  it('CNPJ e chave Pix continuam soletrados', () => {
    expect(normalizePtBrForTts('CNPJ 11.222.333/0001-81')).toContain('um, um, dois, dois, dois')
    expect(normalizePtBrForTts('Chave 11222333000181')).toContain('um, um, dois, dois, dois')
  })
})

describe('normalizePtBrForTts — data e hora', () => {
  it('data vira mês por extenso (antes era soletrada dígito a dígito)', () => {
    expect(normalizePtBrForTts('Vence dia 15/09/2026.')).toBe(
      'Vence dia quinze de setembro de dois mil e vinte e seis.',
    )
    expect(normalizePtBrForTts('Vence 05/12.')).toBe('Vence cinco de dezembro.')
  })

  it('hora em todos os formatos que a IA escreve', () => {
    expect(normalizePtBrForTts('às 17h')).toBe('às dezessete horas')
    expect(normalizePtBrForTts('às 17h30')).toBe('às dezessete e meia')
    expect(normalizePtBrForTts('às 14:30')).toBe('às quatorze e meia')
    expect(normalizePtBrForTts('às 9 horas')).toBe('às nove horas')
    expect(normalizePtBrForTts('às 8h15')).toBe('às oito e quinze')
  })

  it('meio-dia e meia-noite', () => {
    expect(normalizePtBrForTts('Chega 12h')).toBe('Chega meio-dia')
    expect(normalizePtBrForTts('Fecha 0h')).toBe('Fecha meia-noite')
  })

  it('número impossível de hora fica como está', () => {
    expect(normalizePtBrForTts('code 99h99')).toContain('99h99')
  })
})

describe('normalizePtBrForTts — números do dia a dia do gás', () => {
  it('moeda, botijão, peso, porcentagem, distância e ordinal', () => {
    const out = normalizePtBrForTts('P-13 de 13kg por R$ 130,00, 10% off, 5,5 km, nº 340, 1º andar')
    expect(out).toBe(
      'pê treze de treze quilos por cento e trinta reais, dez por cento off, cinco vírgula cinco quilômetros, número trezentos e quarenta, primeiro andar',
    )
  })

  it('centavos', () => {
    expect(normalizePtBrForTts('R$ 1.350,50')).toBe('mil trezentos e cinquenta reais e cinquenta centavos')
    expect(normalizePtBrForTts('R$ 1,00')).toBe('um real')
  })

  it('número de casa, apartamento e nome de rua com número', () => {
    const out = normalizePtBrForTts('Rua 21 de Exemplo, 1234, casa 45, apto 12')
    expect(out).toBe('Rua vinte e um de Exemplo, mil duzentos e trinta e quatro, casa quarenta e cinco, apto doze')
  })

  it('não mexe em código colado a letra ou barra', () => {
    expect(normalizePtBrForTts('modelo gpt-5.6 e 1/2 do total')).toContain('gpt-5.6')
  })
})

describe('normalizePtBrForTts — segurança', () => {
  it('tira marcação do WhatsApp e emoji', () => {
    expect(normalizePtBrForTts('*Pedido* _confirmado_ 🎉')).toBe('Pedido confirmado')
  })

  it('texto sem número passa igual', () => {
    expect(normalizePtBrForTts('Bom dia! Como posso ajudar?')).toBe('Bom dia! Como posso ajudar?')
  })

  it('nunca devolve vazio quando havia texto', () => {
    expect(normalizePtBrForTts('😊').length).toBe(0)
    expect(normalizePtBrForTts('oi 😊')).toBe('oi')
  })
})

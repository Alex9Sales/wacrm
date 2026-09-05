import { describe, expect, it } from 'vitest'

import { EMIT_DEFAULTS, findDuplicateCharge, parseDueDate, parseValue, validateEmit } from './emit-rules'

const hoje = new Date(2026, 8, 5) // 05/09/2026

describe('parseValue — a IA escreve valor de todo jeito', () => {
  it('aceita os formatos que aparecem em conversa', () => {
    expect(parseValue('125')).toBe(125)
    expect(parseValue('125,00')).toBe(125)
    expect(parseValue('R$ 1.250,50')).toBe(1250.5)
    expect(parseValue('1250.5')).toBe(1250.5)
  })

  it('recusa zero, negativo e lixo', () => {
    expect(parseValue('0')).toBeNull()
    expect(parseValue('-10')).toBeNull()
    expect(parseValue('abc')).toBeNull()
    expect(parseValue(null)).toBeNull()
  })
})

describe('parseDueDate — vencimento nos formatos que a IA e o cliente usam', () => {
  it('dias à frente', () => {
    expect(parseDueDate('+7', hoje)).toBe('2026-09-12')
    expect(parseDueDate('7', hoje)).toBe('2026-09-12')
  })

  it('data completa', () => {
    expect(parseDueDate('2026-09-30', hoje)).toBe('2026-09-30')
    expect(parseDueDate('30/09/2026', hoje)).toBe('2026-09-30')
    expect(parseDueDate('30/09/26', hoje)).toBe('2026-09-30')
  })

  it('"30/09" sem ano = este ano; "30/01" dito em setembro = ano que vem', () => {
    expect(parseDueDate('30/09', hoje)).toBe('2026-09-30')
    expect(parseDueDate('30/01', hoje)).toBe('2027-01-30')
  })

  it('recusa data impossível', () => {
    expect(parseDueDate('31/02', hoje)).toBeNull()
    expect(parseDueDate('2026-13-01', hoje)).toBeNull()
    expect(parseDueDate('amanhã', hoje)).toBeNull()
  })
})

describe('validateEmit — as travas que não ficam no prompt', () => {
  const ok = { value: 125, dueDate: '2026-09-12', description: 'Ultragaz P-13' }

  it('emite quando está tudo dentro', () => {
    expect(validateEmit(ok, EMIT_DEFAULTS, hoje)).toEqual({ ok: true })
  })

  it('NÃO emite acima do valor máximo — vira gente', () => {
    const v = validateEmit({ ...ok, value: 900 }, EMIT_DEFAULTS, hoje)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('acima do máximo')
  })

  it('o máximo é configuração da conta, não constante', () => {
    expect(validateEmit({ ...ok, value: 900 }, { ...EMIT_DEFAULTS, maxValue: 1000 }, hoje)).toEqual({ ok: true })
  })

  it('recusa vencimento no passado e longe demais', () => {
    expect(validateEmit({ ...ok, dueDate: '2026-09-01' }, EMIT_DEFAULTS, hoje).ok).toBe(false)
    expect(validateEmit({ ...ok, dueDate: '2027-01-15' }, EMIT_DEFAULTS, hoje).ok).toBe(false)
  })

  it('vence HOJE ainda vale', () => {
    expect(validateEmit({ ...ok, dueDate: '2026-09-05' }, EMIT_DEFAULTS, hoje)).toEqual({ ok: true })
  })

  it('recusa sem descrição — cobrança sem dizer do quê não vai pro cliente', () => {
    expect(validateEmit({ ...ok, description: '' }, EMIT_DEFAULTS, hoje).ok).toBe(false)
  })

  it('sempre explica o não', () => {
    const v = validateEmit({ ...ok, value: null }, EMIT_DEFAULTS, hoje)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(3)
  })
})

describe('findDuplicateCharge — a lição do pedido triplicado', () => {
  const agora = new Date('2026-09-05T15:00:00-03:00')
  const recente = { value: 125, createdAt: '2026-09-05T14:30:00-03:00', open: true, invoiceUrl: 'https://x/1' }

  it('mesma cobrança aberta, criada há pouco → reaproveita', () => {
    expect(findDuplicateCharge([recente], 125, agora)).toBe(recente)
  })

  it('valor diferente não é duplicata', () => {
    expect(findDuplicateCharge([recente], 130, agora)).toBeNull()
  })

  it('cobrança já fechada (paga) não bloqueia uma nova', () => {
    expect(findDuplicateCharge([{ ...recente, open: false }], 125, agora)).toBeNull()
  })

  it('fora da janela de 6h é compra nova', () => {
    expect(findDuplicateCharge([{ ...recente, createdAt: '2026-09-05T08:00:00-03:00' }], 125, agora)).toBeNull()
  })
})

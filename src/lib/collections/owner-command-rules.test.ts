import { describe, expect, it } from 'vitest'

import { formatCandidates, formatProposal, looksLikeCancel, looksLikeChargeCommand, looksLikeConfirmation, normalizeParsedCommand, pickCandidateIndex } from './owner-command-rules'

const hoje = new Date(2026, 8, 6)

describe('comando do dono — reconhecer', () => {
  it('pedido de cobrança precisa de verbo + palavra de cobrança', () => {
    expect(looksLikeChargeCommand('cria uma cobrança de 150 pro João vencendo dia 10')).toBe(true)
    expect(looksLikeChargeCommand('gera um boleto de R$ 80 pra Maria')).toBe(true)
    expect(looksLikeChargeCommand('manda o pix de 125 pro 67 99999-1234')).toBe(true)
    expect(looksLikeChargeCommand('quanto tá o gás?')).toBe(false)
    expect(looksLikeChargeCommand('a cobrança do João já foi paga?')).toBe(false)
  })

  it('confirmação e cancelamento', () => {
    for (const t of ['sim', 'SIM', 'ok', 'pode', 'isso mesmo', 'confirma', '👍']) expect(looksLikeConfirmation(t)).toBe(true)
    for (const t of ['não', 'cancela', 'deixa pra lá', 'errado']) expect(looksLikeCancel(t)).toBe(true)
    expect(looksLikeConfirmation('simão da silva')).toBe(false)
    expect(looksLikeCancel('não sei se ele paga')).toBe(true)
  })

  it('escolha entre candidatos: número ou ordinal', () => {
    expect(pickCandidateIndex('2', 3)).toBe(1)
    expect(pickCandidateIndex('o 3', 3)).toBe(2)
    expect(pickCandidateIndex('primeiro', 3)).toBe(0)
    expect(pickCandidateIndex('5', 3)).toBeNull()
    expect(pickCandidateIndex('sim', 3)).toBeNull()
  })
})

describe('comando do dono — normalizar o que o modelo extraiu', () => {
  it('valor e data pelas mesmas regras da emissão; vencimento padrão +3 dias; telefone vence o nome', () => {
    const p = normalizeParsedCommand({ customer: 'João Silva', value: 'R$ 150,00', dueDate: '10/09' }, hoje)
    expect(p).toEqual({ customerQuery: 'João Silva', value: 150, dueDate: '2026-09-10', description: 'Cobrança' })
    expect(normalizeParsedCommand({ customer: 'Maria', value: 80 }, hoje).dueDate).toBe('2026-09-09')
    expect(normalizeParsedCommand({ customer: 'Maria', phone: '67 99999-1234', value: 80 }, hoje).customerQuery).toBe('67 99999-1234')
    expect(normalizeParsedCommand({ customer: 'Maria', value: 'abc' }, hoje).value).toBeNull()
  })

  it('textos para o dono: proposta com SIM/NÃO, lista numerada', () => {
    const t = formatProposal({ name: 'João Silva', phone: '5567999991234', value: 150, dueDate: '2026-09-10', description: 'Serviço' }).replace(/\u00a0/g, ' ')
    expect(t).toContain('R$ 150,00')
    expect(t).toContain('10/09/2026')
    expect(t).toContain('SIM')
    const c = formatCandidates([{ name: 'João A', phone: '1' }, { name: null, phone: '2' }])
    expect(c).toContain('1) João A')
    expect(c).toContain('2) Sem nome')
  })
})

import { describe, expect, it } from 'vitest'

import { fallbackMessage, formatDebtSummary, formatDebtTotal, formatUpcomingSummary, normalizeSettings } from './rules'

const base = { dueDate: '2026-07-30', daysLate: 43, connectionLabel: 'Asaas', invoiceUrl: 'https://x/1' }
// toLocaleString põe espaço duro (U+00A0) depois de "R$"; normaliza pra comparar.
const norm = (t: string) => t.replace(/\u00a0/g, ' ')

describe('formatDebtSummary — juros, dois cadastros e "sem valores" (João 10/09)', () => {
  it('mostra o valor com juros e multa quando o Asaas informou', () => {
    const s = formatDebtSummary([{ ...base, value: 100, interestValue: 6.79 }])
    expect(norm(s.lines[0])).toBe('R$ 100,00 (R$ 106,79 com juros e multa) · venceu em 30/07/2026 (43 dias de atraso)')
    expect(s.total).toBe(100)
    expect(s.totalWithInterest).toBeCloseTo(106.79, 2)
    expect(norm(formatDebtTotal(s))).toBe('R$ 100,00 (R$ 106,79 com juros e multa)')
  })

  it('sem juros informado a linha e o total ficam como antes', () => {
    const s = formatDebtSummary([{ ...base, value: 100, interestValue: null }])
    expect(norm(s.lines[0])).toBe('R$ 100,00 · venceu em 30/07/2026 (43 dias de atraso)')
    expect(norm(formatDebtTotal(s))).toBe('R$ 100,00')
  })

  it('mesma pessoa com dois cadastros: cada parcela diz de qual empresa é', () => {
    const s = formatDebtSummary([
      { ...base, value: 100, customerId: 'cus_1', customerName: 'ByOnGreen' },
      { ...base, value: 200, dueDate: '2026-08-30', daysLate: 12, customerId: 'cus_2', customerName: 'Dra. Anne Cozendey' },
    ])
    expect(s.lines[0]).toContain('· ByOnGreen')
    expect(s.lines[1]).toContain('· Dra. Anne Cozendey')
  })

  it('um cadastro só: o nome não aparece na linha', () => {
    const s = formatDebtSummary([
      { ...base, value: 100, customerId: 'cus_1', customerName: 'ByOnGreen' },
      { ...base, value: 200, customerId: 'cus_1', customerName: 'ByOnGreen' },
    ])
    expect(s.lines.join('\n')).not.toContain('ByOnGreen')
  })

  it('showValues=false: só vencimento, atraso e link — sem R$ e sem Total', () => {
    const s = formatDebtSummary(
      [
        { ...base, value: 100, interestValue: 6.79 },
        { ...base, value: 100, dueDate: '2026-08-30', daysLate: 12, invoiceUrl: 'https://x/2' },
      ],
      { showValues: false },
    )
    expect(s.lines[0]).toBe('Venceu em 30/07/2026 (43 dias de atraso)')
    expect(s.lines.join('\n')).not.toContain('R$')
    const msg = fallbackMessage('Alipé', s, 0, 0, { offerDate: false })
    expect(msg).not.toContain('R$')
    expect(msg).not.toContain('Total')
    expect(msg).toContain('https://x/1')
    expect(msg).toContain('https://x/2')
  })

  it('lembrete também obedece showValues', () => {
    const s = formatUpcomingSummary([{ value: 250, dueDate: '2026-09-15', daysUntil: 5, connectionLabel: 'Asaas', invoiceUrl: 'https://x/9' }], { showValues: false })
    expect(s.lines[0]).toBe('Vence em 15/09/2026 (em 5 dias)')
  })

  it('normalizeSettings: showValues nasce ligado e só desliga com false explícito', () => {
    expect(normalizeSettings({}).showValues).toBe(true)
    expect(normalizeSettings({ showValues: false }).showValues).toBe(false)
  })
})

describe('dias de atraso pela DATA, não pelo instante (João 11/09)', () => {
  // A régua calcula com o mesmo par de chaves YYYY-MM-DD que o engine usa.
  const diasDeAtraso = (venceu: string, hojeKey: string) =>
    Math.round((Date.parse(`${hojeKey}T00:00:00Z`) - Date.parse(`${venceu}T00:00:00Z`)) / 86_400_000)

  it('venceu ontem = 1 dia, não 2', () => {
    expect(diasDeAtraso('2026-09-10', '2026-09-11')).toBe(1)
  })

  it('vence hoje = 0', () => {
    expect(diasDeAtraso('2026-09-11', '2026-09-11')).toBe(0)
  })

  it('não muda com a hora do dia (o servidor roda em UTC)', () => {
    expect(diasDeAtraso('2026-09-10', '2026-09-11')).toBe(1)
    expect(diasDeAtraso('2026-08-15', '2026-09-11')).toBe(27)
  })
})

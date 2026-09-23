import { describe, expect, it } from 'vitest'

import { debtPromptText, type DebtPromptRow } from './reply'

const parcela: DebtPromptRow = {
  value: '90.00',
  dueDate: '2026-08-20',
  description: 'Mensalidade agosto',
  invoiceUrl: 'https://cobranca.exemplo/abc',
  asaasId: 'pay_000111',
  asaasCustomerId: 'cus_000222',
}

describe('o resumo da dívida que a IA lê', () => {
  it('sem parcela em aberto, não existe resumo', () => {
    expect(debtPromptText([], false)).toBeNull()
  })

  it('valor, vencimento, descrição e link de cada parcela', () => {
    const t = debtPromptText([parcela], false) ?? ''
    expect(t).toContain('R$')
    expect(t).toContain('90,00')
    expect(t).toContain('20/08/2026')
    expect(t).toContain('Mensalidade agosto')
    expect(t).toContain('https://cobranca.exemplo/abc')
  })

  it('sem link, diz que não tem — a IA não pode inventar um', () => {
    const t = debtPromptText([{ ...parcela, invoiceUrl: null }], false) ?? ''
    expect(t).toContain('sem link de pagamento disponível')
  })

  it('agente SEM as ferramentas do Asaas não vê código nenhum', () => {
    const t = debtPromptText([parcela], false) ?? ''
    expect(t).not.toContain('pay_000111')
    expect(t).not.toContain('cus_000222')
  })

  it('agente COM as ferramentas recebe os códigos e a ordem de não falar deles', () => {
    const t = debtPromptText([parcela], true) ?? ''
    expect(t).toContain('[id da cobrança: pay_000111]')
    expect(t).toContain('Id do cliente no Asaas: cus_000222')
    expect(t).toContain('nunca diga nenhum deles ao cliente')
  })

  it('várias parcelas somam o total; acima de 10 o resto vira uma linha só', () => {
    const duas = debtPromptText([parcela, { ...parcela, value: '10.00' }], false) ?? ''
    expect(duas).toContain('Total: ')
    expect(duas).toContain('100,00')
    const doze = debtPromptText(Array.from({ length: 12 }, () => parcela), false) ?? ''
    expect(doze).toContain('e mais 2 parcelas em aberto')
    expect(doze.split('\n').filter((l) => l.startsWith('- ')).length).toBe(11)
  })

  it('uma parcela só não mostra total (seria repetir o mesmo número)', () => {
    expect(debtPromptText([parcela], false)).not.toContain('Total:')
  })
})

import { describe, expect, it } from 'vitest'
import {
  chargeForCycle,
  contractTotal,
  cycleLabel,
  monthlyPriceForCycle,
  nextChargeDate,
  parseBillingCycle,
} from './cycle'

// 26/09 — tabela aprovada com o Rafael, sobre os preços de dezembro.
describe('a tabela que foi aprovada', () => {
  it('Start R$ 297 → 237 semestral, 207 anual', () => {
    expect(monthlyPriceForCycle(297, 'monthly')).toBe(297)
    expect(monthlyPriceForCycle(297, 'semiannual')).toBe(237)
    expect(monthlyPriceForCycle(297, 'annual')).toBe(207)
  })

  it('Growth R$ 697 → 557 e 487', () => {
    expect(monthlyPriceForCycle(697, 'semiannual')).toBe(557)
    expect(monthlyPriceForCycle(697, 'annual')).toBe(487)
  })

  it('Scale R$ 1.297 → 1.037 e 907', () => {
    expect(monthlyPriceForCycle(1297, 'semiannual')).toBe(1037)
    expect(monthlyPriceForCycle(1297, 'annual')).toBe(907)
  })

  it('Enterprise R$ 2.990 → 2.392 e 2.093', () => {
    expect(monthlyPriceForCycle(2990, 'semiannual')).toBe(2392)
    expect(monthlyPriceForCycle(2990, 'annual')).toBe(2093)
  })

  it('o total do contrato é mês × meses', () => {
    expect(contractTotal(297, 'semiannual')).toBe(1422)
    expect(contractTotal(297, 'annual')).toBe(2484)
    expect(contractTotal(697, 'annual')).toBe(5844)
    expect(contractTotal(1297, 'annual')).toBe(10884)
  })
})

describe('não inventa ciclo', () => {
  it('valor desconhecido vira null, não "mensal"', () => {
    // Contrato antigo não declarou ciclo. Assumir mensal inventaria um
    // compromisso que ninguém combinou.
    expect(parseBillingCycle(null)).toBeNull()
    expect(parseBillingCycle('')).toBeNull()
    expect(parseBillingCycle('trimestral')).toBeNull()
    expect(cycleLabel(undefined)).toBeNull()
  })

  it('reconhece os três válidos', () => {
    expect(cycleLabel('monthly')).toBe('Mensal')
    expect(cycleLabel('semiannual')).toBe('Semestral')
    expect(cycleLabel('annual')).toBe('Anual')
  })

  it('preço inválido não vira número torto', () => {
    expect(monthlyPriceForCycle(0, 'annual')).toBe(0)
    expect(monthlyPriceForCycle(-5, 'annual')).toBe(0)
    expect(monthlyPriceForCycle(NaN, 'annual')).toBe(0)
  })
})

describe('próxima cobrança', () => {
  it('semestral soma 6 meses no mesmo dia', () => {
    const d = nextChargeDate(new Date(2026, 8, 26), 'semiannual') // 26/09/2026
    expect(d.getMonth()).toBe(2) // março
    expect(d.getDate()).toBe(26)
    expect(d.getFullYear()).toBe(2027)
  })

  it('dia que não existe no mês de destino cai no último dia', () => {
    // 31/08 + 6 meses seria 31/02 — tem que virar 28/02, não 03/03.
    const d = nextChargeDate(new Date(2026, 7, 31), 'semiannual')
    expect(d.getMonth()).toBe(1) // fevereiro
    expect(d.getDate()).toBe(28)
  })

  it('anual soma 12 meses', () => {
    const d = nextChargeDate(new Date(2026, 8, 26), 'annual')
    expect(d.getFullYear()).toBe(2027)
    expect(d.getMonth()).toBe(8)
    expect(d.getDate()).toBe(26)
  })
})

/**
 * `chargeForCycle` decide o número que sai na cobrança de um cliente real, e
 * aparece em dois lugares: a tela mostra antes do clique, a rota manda ao Asaas.
 * O que precisa de teste não é a multiplicação — é que o semestral NÃO seja
 * tratado como mensalidade, que o desconto de tabela NÃO entre por cima de um
 * valor já negociado, e que a tela e a rota nunca cheguem a números diferentes.
 * Cobrança emitida não tem desfazer.
 */
describe('o que vai ser cobrado (a regra do contrato longo)', () => {
  it('semestral cobra o total dos 6 meses de uma vez, não 6 mensalidades', () => {
    const c = chargeForCycle(130, 'semiannual')
    expect(c.total).toBe(780)
    expect(c.oneOff).toBe(true)
    // O valor por mês continua intacto: é o que vira MRR no painel.
    expect(c.monthly).toBe(130)
  })

  it('o caso real da Appia: R$ 130/mês fechados fora da tabela', () => {
    // A venda saiu por uma revendedora sem o −20% do semestral. Se o desconto
    // entrasse aqui, cobraria R$ 624 de um contrato de R$ 780.
    expect(chargeForCycle(130, 'semiannual').total).toBe(780)
    expect(contractTotal(130, 'semiannual')).toBe(624) // ← o que NÃO deve ser cobrado
  })

  it('anual segue a mesma regra — 12 meses numa cobrança', () => {
    const c = chargeForCycle(130, 'annual')
    expect(c.total).toBe(1560)
    expect(c.oneOff).toBe(true)
  })

  it('mensal cobra UM mês e não é cobrança única (é assinatura que repete)', () => {
    const c = chargeForCycle(497, 'monthly')
    expect(c.total).toBe(497)
    expect(c.oneOff).toBe(false)
  })

  it('centavo não vaza em ponto flutuante', () => {
    // 130,50 × 6 dá 782,9999999999999 em float — e centavo a mais ou a menos
    // numa cobrança é divergência com o cliente.
    expect(chargeForCycle(130.5, 'semiannual').total).toBe(783)
    expect(chargeForCycle(99.99, 'annual').total).toBe(1199.88)
  })

  it('campo em branco não vira cobrança de R$ 0 escondida', () => {
    // A tela chama isto a cada tecla digitada: enquanto o campo está vazio o
    // total tem de ser 0, para o botão não anunciar um valor que não existe.
    expect(chargeForCycle(0, 'semiannual').total).toBe(0)
    expect(chargeForCycle(NaN, 'semiannual').total).toBe(0)
    expect(chargeForCycle(-50, 'annual').total).toBe(0)
  })
})

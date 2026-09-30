import { describe, expect, it } from 'vitest'
import { nextDueForCycle } from './webhook'

/**
 * 29/09: a Appia fechou SEMESTRAL e pagou R$ 780 de uma vez. O webhook somava
 * um mês fixo, então marcaria o próximo vencimento para outubro e o lembrete
 * cobraria de novo um contrato pago até março. Cobrar quem já pagou é o tipo de
 * erro que custa o cliente, não só a fatura.
 */
describe('próximo vencimento respeita o ciclo', () => {
  it('semestral volta a vencer em SEIS meses', () => {
    expect(nextDueForCycle('2026-09-29', 'semiannual').slice(0, 10)).toBe('2027-03-29')
  })

  it('anual, em doze', () => {
    expect(nextDueForCycle('2026-09-29', 'annual').slice(0, 10)).toBe('2027-09-29')
  })

  it('mensal segue como sempre foi', () => {
    expect(nextDueForCycle('2026-09-29', 'monthly').slice(0, 10)).toBe('2026-10-29')
  })

  it('ciclo desconhecido ou ausente cai em mensal', () => {
    // Errar para menos só antecipa uma conversa; errar para mais cobra alguém
    // indevidamente.
    for (const c of [null, undefined, '', 'trimestral', 42]) {
      expect(nextDueForCycle('2026-09-29', c).slice(0, 10)).toBe('2026-10-29')
    }
  })

  it('31 de agosto + 6 meses não vaza para março', () => {
    // Fevereiro não tem 31 — cai no último dia, que é como se lê um contrato.
    expect(nextDueForCycle('2026-08-31', 'semiannual').slice(0, 10)).toBe('2027-02-28')
  })
})

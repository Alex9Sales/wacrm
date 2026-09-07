import { describe, expect, it } from 'vitest'

import { fallbackReminderMessage, formatUpcomingSummary, normalizeSettings } from './rules'

describe('configurações novas da régua (07/09)', () => {
  it('agradecer pagamento nasce ligado; lembrete e mover vencimento nascem desligados', () => {
    const s = normalizeSettings({})
    expect(s.thankOnPayment).toBe(true)
    expect(s.reminderDaysBefore).toBe(0)
    expect(s.promiseUpdatesDueDate).toBe(false)
  })
  it('lembrete aceita 0–15 dias e ignora lixo', () => {
    expect(normalizeSettings({ reminderDaysBefore: 3 }).reminderDaysBefore).toBe(3)
    expect(normalizeSettings({ reminderDaysBefore: 99 }).reminderDaysBefore).toBe(15)
    expect(normalizeSettings({ reminderDaysBefore: 'x' as unknown as number }).reminderDaysBefore).toBe(0)
    expect(normalizeSettings({ thankOnPayment: false }).thankOnPayment).toBe(false)
    expect(normalizeSettings({ promiseUpdatesDueDate: true }).promiseUpdatesDueDate).toBe(true)
  })
})

describe('formatUpcomingSummary / fallbackReminderMessage', () => {
  const summary = formatUpcomingSummary([
    { value: 150, dueDate: '2026-09-12', daysUntil: 5, connectionLabel: 'Conta', invoiceUrl: 'https://asaas/x' },
    { value: 80, dueDate: '2026-09-08', daysUntil: 1, connectionLabel: 'Conta', invoiceUrl: 'https://asaas/x' },
  ])
  it('ordena pelo que vence antes, fala "vence em", soma e deixa um link só', () => {
    expect(summary.lines[0]).toMatch(/80,00 · vence em 08\/09\/2026 \(amanhã\)/)
    expect(summary.lines[1]).toMatch(/150,00 · vence em 12\/09\/2026 \(em 5 dias\)/)
    expect(summary.total).toBe(230)
    expect(summary.links).toEqual(['https://asaas/x'])
    expect(summary.minDays).toBe(1)
    expect(summary.lines.join(' ')).not.toMatch(/atraso|venceu/)
  })
  it('texto de segurança varia pela semente e nunca fala em atraso', () => {
    const a = fallbackReminderMessage('Ana', summary, 0)
    const b = fallbackReminderMessage('Ana', summary, 1)
    expect(a).not.toBe(b)
    expect(a).toMatch(/Oi, Ana!/)
    expect(a).toMatch(/Para pagar: https:\/\/asaas\/x/)
    expect(a).not.toMatch(/atraso|vencid/i)
  })
})

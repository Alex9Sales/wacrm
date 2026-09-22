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

// 22/09 (João/GoLink): aviso no DIA do vencimento e a conta de dias pela data.
import { daysBetweenDayKeys, fallbackDueTodayMessage, reminderKindFor } from './rules'

describe('remindOnDueDate — nasce desligado e só liga com true', () => {
  it('padrão false; qualquer coisa que não seja true é false', () => {
    expect(normalizeSettings({}).remindOnDueDate).toBe(false)
    expect(normalizeSettings({ remindOnDueDate: true }).remindOnDueDate).toBe(true)
    expect(normalizeSettings({ remindOnDueDate: 'sim' as unknown as boolean }).remindOnDueDate).toBe(false)
  })
})

describe('daysBetweenDayKeys — dias pela DATA, sem hora nem fuso', () => {
  it('hoje → hoje = 0; amanhã = 1; ontem = -1', () => {
    expect(daysBetweenDayKeys('2026-09-22', '2026-09-22')).toBe(0)
    expect(daysBetweenDayKeys('2026-09-22', '2026-09-23')).toBe(1)
    expect(daysBetweenDayKeys('2026-09-22', '2026-09-21')).toBe(-1)
    expect(daysBetweenDayKeys('2026-09-22', '2026-10-22')).toBe(30)
  })
  it('inválida → null', () => {
    expect(daysBetweenDayKeys('x', '2026-09-22')).toBeNull()
    expect(daysBetweenDayKeys(null, '2026-09-22')).toBeNull()
    expect(daysBetweenDayKeys('2026-09-22', undefined)).toBeNull()
  })
})

describe('reminderKindFor — qual toque cada parcela recebe', () => {
  it('só lembrete (N=5): hoje..5 dias é reminder; 6 é nada; ontem é nada', () => {
    const s = { reminderDaysBefore: 5, remindOnDueDate: false }
    expect(reminderKindFor(0, s)).toBe('reminder')
    expect(reminderKindFor(5, s)).toBe('reminder')
    expect(reminderKindFor(6, s)).toBeNull()
    expect(reminderKindFor(-1, s)).toBeNull()
    expect(reminderKindFor(null, s)).toBeNull()
  })
  it('aviso do dia ligado: hoje é SEMPRE due_today, mesmo com lembrete ligado', () => {
    const s = { reminderDaysBefore: 5, remindOnDueDate: true }
    expect(reminderKindFor(0, s)).toBe('due_today')
    expect(reminderKindFor(1, s)).toBe('reminder')
  })
  it('só o aviso do dia (N=0): hoje é due_today, amanhã é nada', () => {
    const s = { reminderDaysBefore: 0, remindOnDueDate: true }
    expect(reminderKindFor(0, s)).toBe('due_today')
    expect(reminderKindFor(1, s)).toBeNull()
  })
  it('tudo desligado: nada', () => {
    expect(reminderKindFor(0, { reminderDaysBefore: 0, remindOnDueDate: false })).toBeNull()
  })
})

describe('fallbackDueTodayMessage — texto de segurança do aviso do dia', () => {
  const summary = formatUpcomingSummary(
    [{ value: 350, dueDate: '2026-09-22', daysUntil: 0, connectionLabel: 'Asaas', invoiceUrl: 'https://asaas.com/i/abc' }],
    { showValues: true },
  )
  it('diz que vence HOJE, traz o link e nunca fala em atraso', () => {
    const t = fallbackDueTodayMessage('Ana', summary, 0)
    expect(t).toMatch(/hoje/i)
    expect(t).toContain('Oi, Ana!')
    expect(t).toContain('https://asaas.com/i/abc')
    expect(t.toLowerCase()).not.toContain('atraso')
    expect(t.toLowerCase()).not.toContain('pendente')
  })
  it('varia pela semente e sem nome cumprimenta genérico', () => {
    const a = fallbackDueTodayMessage(null, summary, 0)
    const b = fallbackDueTodayMessage(null, summary, 1)
    expect(a).toContain('Oi!')
    expect(a).not.toBe(b)
  })
  it('sem oferecer data quando a conta não quer', () => {
    const t = fallbackDueTodayMessage('Ana', summary, 2, { offerDate: false })
    expect(t).not.toMatch(/outra data/i)
  })
})

import { describe, expect, it } from 'vitest'

import {
  COLLECTIONS_DEFAULTS,
  deliveryPlan,
  eligibility,
  fallbackMessage,
  formatDebtSummary,
  normalizeSettings,
  withinWindow,
  type CollectionsSettings,
  type TouchState,
} from './rules'

const s: CollectionsSettings = { ...COLLECTIONS_DEFAULTS, enabled: true }
const agora = new Date('2026-09-10T12:00:00-03:00')

function state(p: Partial<TouchState> = {}): TouchState {
  return { lastTouchAt: null, touchCount: 0, snoozeUntil: null, paused: false, ...p }
}

describe('normalizeSettings', () => {
  it('número que envia: só uuid válido, senão automático (null)', () => {
    expect(normalizeSettings({}).channelId).toBeNull()
    expect(normalizeSettings({ channelId: 'qualquer coisa' }).channelId).toBeNull()
    expect(normalizeSettings({ channelId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }).channelId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
  })

  it('nasce desligada — cobrar não é padrão, é decisão', () => {
    expect(normalizeSettings({}).enabled).toBe(false)
    expect(normalizeSettings({ enabled: 'sim' }).enabled).toBe(false)
  })

  it('mantém o ciclo de 3 dias como padrão', () => {
    expect(normalizeSettings({}).intervalDays).toBe(3)
  })

  it('prende valores absurdos em vez de aceitar', () => {
    expect(normalizeSettings({ intervalDays: 0 }).intervalDays).toBe(1)
    expect(normalizeSettings({ dailyCap: 99999 }).dailyCap).toBe(500)
    expect(normalizeSettings({ startHour: -5 }).startHour).toBe(0)
  })

  it('lista de status vazia volta pro conservador (só OVERDUE)', () => {
    expect(normalizeSettings({ overdueStatuses: [] }).overdueStatuses).toEqual(['OVERDUE'])
    expect(normalizeSettings({ overdueStatuses: ['OVERDUE', 'PENDING'] }).overdueStatuses).toEqual(['OVERDUE', 'PENDING'])
  })
})

describe('eligibility — a régua só cobra quem pode ser cobrado', () => {
  const base = { contactId: 'c1', optedOut: false, maxDaysLate: 10, state: state() }

  it('cobra quem está atrasado e nunca foi tocado', () => {
    expect(eligibility(base, s, agora)).toBe('ok')
  })

  it('nunca cobra sem contato casado', () => {
    expect(eligibility({ ...base, contactId: null }, s, agora)).toBe('no_contact')
  })

  it('nunca cobra quem pediu para não receber', () => {
    expect(eligibility({ ...base, optedOut: true }, s, agora)).toBe('opted_out')
  })

  it('respeita o intervalo de 3 dias', () => {
    const ontem = new Date(agora.getTime() - 24 * 3600_000).toISOString()
    expect(eligibility({ ...base, state: state({ lastTouchAt: ontem }) }, s, agora)).toBe('too_soon')

    const quatroDias = new Date(agora.getTime() - 4 * 24 * 3600_000).toISOString()
    expect(eligibility({ ...base, state: state({ lastTouchAt: quatroDias }) }, s, agora)).toBe('ok')
  })

  it('dorme até a data que o cliente prometeu', () => {
    const dia30 = new Date('2026-09-30T12:00:00-03:00').toISOString()
    expect(eligibility({ ...base, state: state({ snoozeUntil: dia30 }) }, s, agora)).toBe('snoozed')
  })

  it('acorda depois que a data prometida passa', () => {
    const ontem = new Date(agora.getTime() - 24 * 3600_000).toISOString()
    expect(eligibility({ ...base, state: state({ snoozeUntil: ontem }) }, s, agora)).toBe('ok')
  })

  it('para depois do limite de toques em vez de cobrar para sempre', () => {
    expect(eligibility({ ...base, state: state({ touchCount: 8 }) }, s, agora)).toBe('max_touches')
  })

  it('não cobra quem ainda não passou do atraso mínimo', () => {
    expect(eligibility({ ...base, maxDaysLate: 0 }, s, agora)).toBe('not_due')
    expect(eligibility({ ...base, maxDaysLate: null }, s, agora)).toBe('not_due')
  })

  it('pausa do devedor manda em tudo, até no atraso grande', () => {
    expect(eligibility({ ...base, maxDaysLate: 300, state: state({ paused: true }) }, s, agora)).toBe('paused')
  })

  it('opt-out vence até a pausa e o atraso — ninguém contorna um "não me mande mais"', () => {
    const d = eligibility({ ...base, optedOut: true, maxDaysLate: 300, state: state({ paused: true }) }, s, agora)
    expect(d).toBe('opted_out')
  })
})

describe('withinWindow', () => {
  it('respeita o horário comercial configurado', () => {
    expect(withinWindow(9, 3, s)).toBe(true)
    expect(withinWindow(8, 3, s)).toBe(false)
    expect(withinWindow(18, 3, s)).toBe(false) // 18 é o fim, já fechou
  })

  it('não cobra no fim de semana quando é só dia útil', () => {
    expect(withinWindow(12, 0, s)).toBe(false)
    expect(withinWindow(12, 6, s)).toBe(false)
    expect(withinWindow(12, 6, { ...s, weekdaysOnly: false })).toBe(true)
  })
})

describe('formatDebtSummary — os números vêm prontos, a IA não soma', () => {
  const charges = [
    { value: 150, dueDate: '2026-08-01', daysLate: 40, connectionLabel: 'Minha conta', invoiceUrl: 'https://x/1' },
    { value: 200.5, dueDate: '2026-09-01', daysLate: 9, connectionLabel: 'Minha conta', invoiceUrl: 'https://x/2' },
  ]

  it('soma o total e ordena do mais atrasado para o menos', () => {
    const r = formatDebtSummary(charges)
    expect(r.total).toBeCloseTo(350.5)
    expect(r.lines[0]).toContain('40 dias de atraso')
    expect(r.lines[1]).toContain('9 dias de atraso')
  })

  it('não mostra a conta de origem quando só existe uma', () => {
    expect(formatDebtSummary(charges).lines.join()).not.toContain('Minha conta')
  })

  it('mostra a conta de origem quando a dívida vem de duas', () => {
    const r = formatDebtSummary([...charges, { value: 90, dueDate: '2026-09-05', daysLate: 5, connectionLabel: 'Conta do pai', invoiceUrl: null }])
    expect(r.lines.join()).toContain('Conta do pai')
    expect(r.lines.join()).toContain('Minha conta')
  })

  it('não repete o mesmo link de pagamento', () => {
    const r = formatDebtSummary([
      { ...charges[0], invoiceUrl: 'https://x/1' },
      { ...charges[1], invoiceUrl: 'https://x/1' },
    ])
    expect(r.links).toEqual(['https://x/1'])
  })
})

describe('fallbackMessage', () => {
  const summary = formatDebtSummary([
    { value: 150, dueDate: '2026-08-01', daysLate: 40, connectionLabel: 'Minha conta', invoiceUrl: 'https://x/1' },
  ])

  it('usa o primeiro nome e abre diferente no primeiro toque', () => {
    expect(fallbackMessage('Ana', summary, 0)).toContain('Oi, Ana!')
    expect(fallbackMessage('Ana', summary, 0)).toContain('lembrar')
    expect(fallbackMessage('Ana', summary, 2)).toContain('Voltando')
  })

  it('sempre abre a porta para o cliente responder — é o que pausa a régua', () => {
    expect(fallbackMessage(null, summary, 1)).toContain('combinar uma data')
  })

  it('funciona sem nome', () => {
    expect(fallbackMessage(null, summary, 0).startsWith('Oi!')).toBe(true)
  })

  it('varia com a semente sem mexer em valor nem link — dois devedores no mesmo dia não recebem a mesma frase', () => {
    const textos = [0, 1, 2, 3, 4, 5, 6, 7].map((seed) => fallbackMessage('Ana', summary, 0, seed))
    expect(new Set(textos).size).toBeGreaterThanOrEqual(4)
    for (const t of textos) {
      expect(t.replace(/\u00a0/g, ' ')).toContain('R$ 150,00')
      expect(t).toContain('https://x/1')
      expect(t).toContain('combinar uma data')
      expect(t.startsWith('Oi, Ana!')).toBe(true)
    }
  })
})

describe('deliveryPlan — por onde a cobrança sai', () => {
  const tudo = { hasPhone: true, hasEmail: true, whatsappError: null, emailError: null }

  it('auto: WhatsApp quando tem telefone; e-mail quando não tem', () => {
    expect(deliveryPlan({ channel: 'auto', ...tudo })).toEqual({ ok: true, whatsapp: true, email: false, label: 'WhatsApp' })
    expect(deliveryPlan({ channel: 'auto', ...tudo, hasPhone: false })).toEqual({ ok: true, whatsapp: false, email: true, label: 'e-mail' })
  })

  it('auto sem nada: explica os dois motivos', () => {
    const r = deliveryPlan({ channel: 'auto', hasPhone: false, hasEmail: false, whatsappError: null, emailError: null })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('telefone')
      expect(r.error).toContain('e-mail')
    }
  })

  it('só WhatsApp com mais de um número: devolve o motivo do número, que é o acionável', () => {
    const r = deliveryPlan({ channel: 'whatsapp', ...tudo, whatsappError: 'escolha em Cobranças → Ajustar qual deles envia' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Ajustar')
  })

  it('só e-mail sem canal de e-mail: diz que falta o canal', () => {
    const r = deliveryPlan({ channel: 'email', ...tudo, emailError: 'nenhum canal de e-mail conectado' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('canal de e-mail')
  })

  it('os dois: manda pelos dois quando dá, e por um só quando só um dá', () => {
    expect(deliveryPlan({ channel: 'both', ...tudo })).toEqual({ ok: true, whatsapp: true, email: true, label: 'WhatsApp e e-mail' })
    expect(deliveryPlan({ channel: 'both', ...tudo, hasPhone: false })).toEqual({ ok: true, whatsapp: false, email: true, label: 'e-mail' })
  })

  it('normalizeSettings aceita both e devolve auto para lixo', () => {
    expect(normalizeSettings({ channel: 'both' }).channel).toBe('both')
    expect(normalizeSettings({ channel: 'pombo-correio' }).channel).toBe('auto')
  })
})

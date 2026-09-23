import { describe, expect, it } from 'vitest'

import {
  COLLECTIONS_DEFAULTS,
  debtorHold,
  eligibility,
  MAX_COLLECTION_STEPS,
  normalizeSettings,
  normalizeSteps,
  renderStepText,
  stepForTouch,
  stepGapDays,
  type CollectionsSettings,
} from './rules'

/** A escada que o Rafael desenhou (23/09): 3, 7, 10, 15 e 30 dias de atraso. */
const ESCADA_RAFAEL = [
  { daysLate: 3 },
  { daysLate: 7 },
  { daysLate: 10 },
  { daysLate: 15 },
  { daysLate: 30, text: 'Olá {nome}, o valor de {valor} segue em aberto há {dias} dias. Sem retorno, o débito será encaminhado para negativação.' },
]

const comEscada = (steps = ESCADA_RAFAEL): CollectionsSettings =>
  normalizeSettings({ ...COLLECTIONS_DEFAULTS, minDaysOverdue: 1, steps })

const devedor = (maxDaysLate: number, touchCount = 0, lastTouchAt: string | null = null) => ({
  contactId: 'c1',
  optedOut: false,
  maxDaysLate,
  state: { touchCount, lastTouchAt, paused: false, snoozeUntil: null },
})

const HOJE = new Date('2026-09-23T12:00:00-03:00')
const diasAtras = (n: number) => new Date(HOJE.getTime() - n * 86_400_000).toISOString()

describe('normalizeSteps — a escada que veio da tela', () => {
  it('ordena, arredonda e tira o dia repetido', () => {
    expect(normalizeSteps([{ daysLate: 7 }, { daysLate: 3.4 }, { daysLate: 7 }])).toEqual([
      { daysLate: 3 },
      { daysLate: 7 },
    ])
  })

  it('guarda o texto do degrau e corta o que não é degrau', () => {
    expect(normalizeSteps([{ daysLate: 30, text: '  negativação  ' }, null, 'x', { text: 'sem dia' }])).toEqual([
      { daysLate: 30, text: 'negativação' },
    ])
  })

  it('lista inválida vira vazia — e vazia é a régua de sempre, não "nunca cobre"', () => {
    expect(normalizeSteps(undefined)).toEqual([])
    expect(normalizeSteps('3,7,10')).toEqual([])
    expect(normalizeSettings({}).steps).toEqual([])
  })

  it('respeita o teto de degraus', () => {
    const muitos = Array.from({ length: 30 }, (_, i) => ({ daysLate: i + 1 }))
    expect(normalizeSteps(muitos)).toHaveLength(MAX_COLLECTION_STEPS)
  })
})

describe('a régua anda pela escada (caso Rafael, 23/09)', () => {
  const s = comEscada()

  it('o primeiro toque espera o primeiro degrau', () => {
    expect(eligibility(devedor(2), s, HOJE)).toBe('too_soon')
    expect(eligibility(devedor(3), s, HOJE)).toBe('ok')
  })

  it('cada toque seguinte espera o SEU degrau', () => {
    // Já levou 1 toque: o próximo é o de 7 dias.
    expect(eligibility(devedor(5, 1, diasAtras(2)), s, HOJE)).toBe('too_soon')
    expect(eligibility(devedor(7, 1, diasAtras(4)), s, HOJE)).toBe('ok')
    // Três toques dados: o próximo é o de 15.
    expect(eligibility(devedor(12, 3, diasAtras(5)), s, HOJE)).toBe('too_soon')
    expect(eligibility(devedor(15, 3, diasAtras(5)), s, HOJE)).toBe('ok')
  })

  it('quem entra na régua muito atrasado NÃO leva a escada inteira de uma vez', () => {
    const atrasadao = devedor(45, 1, diasAtras(1))
    // O degrau de 7 dias já "venceu", mas o ritmo desenhado tem 4 dias entre
    // o primeiro e o segundo toque — só um toque por vez.
    expect(eligibility(atrasadao, s, HOJE)).toBe('too_soon')
    expect(eligibility(devedor(45, 1, diasAtras(4)), s, HOJE)).toBe('ok')
  })

  it('a escada TEM fim: depois do último degrau a régua para nele', () => {
    expect(eligibility(devedor(90, 5, diasAtras(30)), s, HOJE)).toBe('max_touches')
    expect(debtorHold({ touchCount: 5, lastTouchAt: null, paused: false, snoozeUntil: null }, s, HOJE)).toBe('max_touches')
    // Com escada, o fim é o tamanho dela — não o teto antigo de 8 toques.
    expect(s.steps.length).toBe(5)
  })

  it('sem escada, a régua de sempre continua igual', () => {
    const antiga = normalizeSettings({ ...COLLECTIONS_DEFAULTS, minDaysOverdue: 1, intervalDays: 3 })
    expect(eligibility(devedor(10, 1, diasAtras(2)), antiga, HOJE)).toBe('too_soon')
    expect(eligibility(devedor(10, 1, diasAtras(3)), antiga, HOJE)).toBe('ok')
  })

  it('pausa e promessa continuam mandando mais que a escada', () => {
    const pausado = { ...devedor(30, 0), state: { touchCount: 0, lastTouchAt: null, paused: true, snoozeUntil: null } }
    expect(eligibility(pausado, s, HOJE)).toBe('paused')
  })
})

describe('stepForTouch / stepGapDays', () => {
  it('o degrau da vez é o do próximo toque', () => {
    expect(stepForTouch(ESCADA_RAFAEL, 0)?.daysLate).toBe(3)
    expect(stepForTouch(ESCADA_RAFAEL, 4)?.daysLate).toBe(30)
    expect(stepForTouch(ESCADA_RAFAEL, 5)).toBeNull()
    expect(stepForTouch([], 0)).toBeNull()
  })

  it('a distância entre degraus vira o intervalo mínimo', () => {
    expect(stepGapDays(ESCADA_RAFAEL, 0)).toBe(1)
    expect(stepGapDays(ESCADA_RAFAEL, 1)).toBe(4)
    expect(stepGapDays(ESCADA_RAFAEL, 4)).toBe(15)
  })
})

describe('texto do degrau', () => {
  it('sai como o cliente escreveu, com as chaves preenchidas', () => {
    const t = renderStepText(ESCADA_RAFAEL[4].text!, {
      nome: 'Marcelo',
      valor: 'R$ 250,00',
      dias: '30',
      link: 'https://x',
      vencimento: '20/08/2026',
      descricao: '',
      parcelas: '1',
    })
    expect(t).toContain('Olá Marcelo')
    expect(t).toContain('R$ 250,00')
    expect(t).toContain('30 dias')
    expect(t).toContain('negativação')
    expect(t).not.toContain('{')
  })

  it('chave sem dado vira vazio — nunca "{valor}" na cara do devedor', () => {
    expect(renderStepText('Deve {valor} desde {vencimento}.', { nome: '' })).toBe('Deve  desde .')
  })
})

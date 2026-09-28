import { describe, expect, it } from 'vitest'
import { readFunnel, type StepMetric } from './metrics'

/**
 * `readFunnel` é a regra que decide se a tela diz "corte aqui". Ela sugere
 * apagar degraus de uma régua que fala com cliente de verdade — então o que
 * precisa de teste não é o cálculo, é a PRUDÊNCIA: não concluir com amostra
 * pequena, não mandar cortar o que ainda responde, e não chamar de "concentra
 * no início" uma cadência que não teve resposta nenhuma.
 */
const step = (
  degree: number,
  sent: number,
  replied: number,
  advanced = 0,
): StepMetric => ({
  degree,
  label: `degrau ${degree}`,
  sent,
  replied,
  advanced,
  replyRate: sent > 0 ? replied / sent : 0,
})

describe('o caso real que motivou a tela (Exocad V1)', () => {
  // 97 · 63 · 59 · 46 · 62 enviadas; respostas só no 1º (16) e no 3º (3).
  const exocad = [
    step(1, 97, 16, 63),
    step(2, 63, 0, 59),
    step(3, 59, 3, 46),
    step(4, 46, 0, 62),
    step(5, 62, 0),
  ]

  it('aponta a cauda morta e diz de onde cortar', () => {
    const r = readFunnel(exocad)
    expect(r?.kind).toBe('dead_tail')
    expect(r?.cutFrom).toBe(4)
    expect(r?.headline).toContain('4º degrau em diante')
  })

  it('conta quantas mensagens saíram à toa — é o que convence', () => {
    // 46 + 62 = 108 envios sem uma resposta.
    expect(readFunnel(exocad)?.detail).toContain('108')
  })

  it('sugere manter até o degrau anterior, não apagar a cadência', () => {
    expect(readFunnel(exocad)?.detail).toContain('3º degrau')
  })
})

describe('não conclui o que os números não sustentam', () => {
  it('amostra pequena vira "ainda é cedo", nunca um corte', () => {
    const r = readFunnel([step(1, 6, 1), step(2, 4, 0), step(3, 3, 0)])
    expect(r?.kind).toBe('too_early')
    expect(r?.cutFrom).toBeUndefined()
  })

  it('cadência sem envio nenhum não gera leitura', () => {
    expect(readFunnel([step(1, 0, 0), step(2, 0, 0)])).toBeNull()
  })

  it('zero respostas manda revisar o primeiro toque, não cortar o fim', () => {
    const r = readFunnel([step(1, 19, 0), step(2, 14, 0), step(3, 9, 0)])
    expect(r?.kind).toBe('no_replies')
    expect(r?.cutFrom).toBeUndefined()
  })

  it('degrau que ainda responde NÃO entra na cauda morta', () => {
    // O último degrau responde: não há cauda a cortar.
    const r = readFunnel([step(1, 60, 10), step(2, 40, 0), step(3, 30, 5)])
    expect(r?.kind).not.toBe('dead_tail')
  })
})

describe('concentração no primeiro toque', () => {
  it('avisa quando a entrada domina as respostas', () => {
    const r = readFunnel([step(1, 80, 12), step(2, 60, 3), step(3, 40, 2)])
    expect(r?.kind).toBe('front_loaded')
    expect(r?.headline).toContain('71%') // 12 de 17
  })

  it('respostas espalhadas não viram alarme', () => {
    expect(readFunnel([step(1, 60, 5), step(2, 50, 6), step(3, 40, 5)])).toBeNull()
  })

  it('degrau único não é "concentração" — não há com o que comparar', () => {
    expect(readFunnel([step(1, 50, 9)])).toBeNull()
  })
})

describe('degrau sem envio no meio não quebra a leitura', () => {
  it('ignora o degrau que nunca saiu ao procurar a cauda', () => {
    const r = readFunnel([step(1, 50, 8), step(2, 0, 0), step(3, 30, 0)])
    expect(r?.kind).toBe('dead_tail')
    expect(r?.cutFrom).toBe(3)
  })
})

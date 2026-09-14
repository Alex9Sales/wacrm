import { describe, expect, it } from 'vitest'

import { byNearestDue, fixedCollectionRoute } from './rules'

const cand = (nome: string, ...dias: (number | null)[]) => ({ nome, lines: dias.map((daysUntil) => ({ daysUntil })) })

describe('byNearestDue — lembrete que vence antes sai antes', () => {
  it('ordena pelo vencimento mais próximo de cada devedor', () => {
    const ordem = byNearestDue([cand('cinco dias', 5), cand('amanhã', 1), cand('hoje', 0), cand('três', 3)])
    expect(ordem.map((c) => c.nome)).toEqual(['hoje', 'amanhã', 'três', 'cinco dias'])
  })

  it('devedor com duas parcelas conta pela que vence antes', () => {
    const ordem = byNearestDue([cand('só em 4', 4), cand('uma em 5 e outra amanhã', 5, 1)])
    expect(ordem[0].nome).toBe('uma em 5 e outra amanhã')
  })

  it('sem data conhecida vai para o fim, sem quebrar a ordem', () => {
    const ordem = byNearestDue([cand('sem data', null), cand('em 2', 2), cand('vazio')])
    expect(ordem[0].nome).toBe('em 2')
  })

  it('não mexe na lista original', () => {
    const lista = [cand('b', 3), cand('a', 1)]
    byNearestDue(lista)
    expect(lista.map((c) => c.nome)).toEqual(['b', 'a'])
  })
})

describe('fixedCollectionRoute — o card mostra o número que envia de verdade', () => {
  it('WhatsApp ganha o nome do número fixo', () => {
    expect(fixedCollectionRoute('WhatsApp', 'Cobranças')).toBe('WhatsApp · Cobranças')
    expect(fixedCollectionRoute('WhatsApp e e-mail', 'Cobranças')).toBe('WhatsApp · Cobranças e e-mail')
  })

  it('só e-mail continua e-mail; plano ausente vira WhatsApp', () => {
    expect(fixedCollectionRoute('e-mail', 'Cobranças')).toBe('E-mail')
    expect(fixedCollectionRoute(undefined, 'Cobranças')).toBe('WhatsApp · Cobranças')
  })
})

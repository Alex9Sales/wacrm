import { describe, expect, it } from 'vitest'

import { byNearestDue, contactedTodaySet, fixedCollectionRoute, freshReminderItems, textHasUrl } from './rules'

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

// 15/09: UMA mensagem de cobrança por pessoa por dia — vale a primeira.
describe('contactedTodaySet — quem já tem mensagem de cobrança hoje', () => {
  it('pending, queued e sent entram; expired, failed e rejected não', () => {
    const set = contactedTodaySet([
      { contactId: 'fila', status: 'pending' },
      { contactId: 'aprovado', status: 'queued' },
      { contactId: 'enviado', status: 'sent' },
      { contactId: 'velho', status: 'expired' },
      { contactId: 'falhou', status: 'failed' },
      { contactId: 'recusado', status: 'rejected' },
    ])
    expect([...set].sort()).toEqual(['aprovado', 'enviado', 'fila'])
  })

  it('contato nulo é ignorado; o mesmo contato conta uma vez', () => {
    const set = contactedTodaySet([
      { contactId: null, status: 'sent' },
      { contactId: 'c1', status: 'sent' },
      { contactId: 'c1', status: 'expired' },
    ])
    expect([...set]).toEqual(['c1'])
  })
})

describe('freshReminderItems — a parcela que ainda merece lembrete', () => {
  const items = [
    { id: 'pay_1', invoiceUrl: 'https://www.asaas.com/i/111' },
    { id: 'pay_2', invoiceUrl: 'https://www.asaas.com/i/222' },
    { id: 'pay_3', invoiceUrl: null },
    { id: 'pay_4', invoiceUrl: 'https://www.asaas.com/i/444' },
  ]

  it('parcela já lembrada ou já avisada como cobrança nova sai', () => {
    const r = freshReminderItems(items, new Set(['pay_2']), new Set())
    expect(r.map((x) => x.id)).toEqual(['pay_1', 'pay_3', 'pay_4'])
  })

  it('parcela cujo link já saiu numa mensagem sai; sem link não é descartada pelo link', () => {
    const r = freshReminderItems(items, new Set(), new Set(['https://www.asaas.com/i/111', 'https://www.asaas.com/i/444']))
    expect(r.map((x) => x.id)).toEqual(['pay_2', 'pay_3'])
  })

  it('tudo filtrado vira lista vazia; a ordem original se mantém', () => {
    expect(freshReminderItems(items, new Set(['pay_1', 'pay_2', 'pay_3']), new Set(['https://www.asaas.com/i/444']))).toEqual([])
    const r = freshReminderItems(items, new Set(['pay_3']), new Set())
    expect(r.map((x) => x.id)).toEqual(['pay_1', 'pay_2', 'pay_4'])
    expect(items).toHaveLength(4)
  })
})

describe('textHasUrl — o link inteiro, não um maior que começa igual', () => {
  const url = 'https://www.asaas.com/i/123'

  it('acha o link no meio, no fim, com pontuação ou na linha de baixo', () => {
    expect(textHasUrl(`Oi! Para pagar: ${url}`, url)).toBe(true)
    expect(textHasUrl(`Segue o link (${url}). Obrigado`, url)).toBe(true)
    expect(textHasUrl(`*João:*\nParcela 1\n  ${url}\nParcela 2`, url)).toBe(true)
    expect(textHasUrl(`${url}?x=1`, url)).toBe(true)
  })

  it('link de outra parcela que começa igual não conta', () => {
    expect(textHasUrl('Para pagar: https://www.asaas.com/i/1234', url)).toBe(false)
    expect(textHasUrl('https://www.asaas.com/i/1234 e https://www.asaas.com/i/123', url)).toBe(true)
  })

  it('texto vazio ou sem o link', () => {
    expect(textHasUrl(null, url)).toBe(false)
    expect(textHasUrl('', url)).toBe(false)
    expect(textHasUrl('Bom dia!', url)).toBe(false)
  })
})

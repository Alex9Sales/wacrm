import { describe, expect, it } from 'vitest'

import {
  COLLECTIONS_DEFAULTS,
  autoSendDue,
  deliveryPlan,
  duplicateSuspects,
  eligibility,
  fallbackMessage,
  fallbackReminderMessage,
  formatDebtBody,
  formatDebtSummary,
  formatUpcomingSummary,
  dayBlockedReason,
  describeWeekdays,
  greetingName,
  normalizeWeekdays,
  phoneSearchDigits,
  thanksDayBlockedReason,
  linksInstruction,
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

describe('autoSend / cadência (09/09, GoLink "uma a cada N minutos")', () => {
  it('nasce desligado, com 5 minutos entre mensagens; prende o intervalo em 1–120', () => {
    const d = normalizeSettings({})
    expect(d.autoSend).toBe(false)
    expect(d.sendEveryMinutes).toBe(5)
    expect(normalizeSettings({ sendEveryMinutes: 0 }).sendEveryMinutes).toBe(1)
    expect(normalizeSettings({ sendEveryMinutes: 999 }).sendEveryMinutes).toBe(120)
    expect(normalizeSettings({ autoSend: 'sim' }).autoSend).toBe(false)
    expect(normalizeSettings({ autoSend: true }).autoSend).toBe(true)
  })

  it('autoSendDue: sem envio anterior pode; depois só quando passa o intervalo', () => {
    const now = Date.parse('2026-09-10T12:00:00Z')
    expect(autoSendDue(null, now, 5)).toBe(true)
    expect(autoSendDue(now - 4 * 60_000, now, 5)).toBe(false)
    expect(autoSendDue(now - 5 * 60_000, now, 5)).toBe(true)
    expect(autoSendDue(now - 30_000, now, 0)).toBe(false) // 0 vira 1 minuto
  })
})

describe('greetingName — nome como está no Asaas (10/09, GoLink)', () => {
  it('até 3 palavras vai inteiro: empresa curta e apelido não viram "primeiro nome"', () => {
    expect(greetingName('Drogaria Imaculada')).toBe('Drogaria Imaculada')
    expect(greetingName('Rack 95')).toBe('Rack 95')
    expect(greetingName('Alipé Podologia')).toBe('Alipé Podologia')
  })
  // 11/09 — os nomes reais da carteira da GoLink que cortar em duas estragaria.
  it('nome de 3 palavras não pode perder a terceira', () => {
    expect(greetingName('Canal da Pizza')).toBe('Canal da Pizza')
    expect(greetingName('UTI dos Fogões')).toBe('UTI dos Fogões')
    expect(greetingName('Marcenaria São José')).toBe('Marcenaria São José')
    expect(greetingName('Drogaria Faria Lima')).toBe('Drogaria Faria Lima')
    expect(greetingName('Depósito São Caetano')).toBe('Depósito São Caetano')
  })
  it('mais longo: duas primeiras, ou só a primeira quando a segunda é conector', () => {
    expect(greetingName('Ultra Visão e Regrava Vale Taubaté')).toBe('Ultra Visão')
    expect(greetingName('João da Silva Pereira')).toBe('João')
    expect(greetingName('CRIIS Mármores e Granitos')).toBe('CRIIS Mármores')
  })
  it('vazio vira null', () => {
    expect(greetingName('')).toBeNull()
    expect(greetingName(null)).toBeNull()
    expect(greetingName('   ')).toBeNull()
  })

  // 11/09 — os dois nomes que o João mandou depois de ver o "Oi, Dom!".
  it('artigo na frente leva mais uma palavra (senão vira "Oi, A!")', () => {
    expect(greetingName('A Pellogia Corretora E Administracao De Seguros Lt')).toBe('A Pellogia Corretora')
    expect(greetingName('O Boticário')).toBe('O Boticário')
  })
  it('separador solto não vira parte do nome', () => {
    expect(greetingName('Ecosistema - Gestão de Seguros')).toBe('Ecosistema')
  })
})

describe('phoneSearchDigits — por que "Center Pisos Raspadora" não era achado (11/09)', () => {
  it('busca por NOME não procura telefone (senão o ILIKE vira %% e casa com a conta toda)', () => {
    expect(phoneSearchDigits('Center Pisos Raspadora')).toBeNull()
    expect(phoneSearchDigits('')).toBeNull()
    expect(phoneSearchDigits(null)).toBeNull()
    expect(phoneSearchDigits('L&M Vidros')).toBeNull()
  })
  it('dígito solto do nome também não abre a busca por telefone', () => {
    expect(phoneSearchDigits('Rack 95')).toBeNull()
    expect(phoneSearchDigits('M&P 12')).toBeNull()
  })
  it('telefone de verdade procura pelos dígitos', () => {
    expect(phoneSearchDigits('(12) 99701-0439')).toBe('12997010439')
    expect(phoneSearchDigits('997010439')).toBe('997010439')
  })
  it('sufixo de razão social não é jeito de chamar ninguém', () => {
    expect(greetingName('Pellogia Ltda')).toBe('Pellogia')
    expect(greetingName('Vale Ouro ME')).toBe('Vale Ouro')
  })
})

describe('fallbackMessage sem "combinar uma data" (offerDate=false)', () => {
  const summary = formatDebtSummary([{ value: 150, dueDate: '2026-08-01', daysLate: 40, connectionLabel: 'Minha conta', invoiceUrl: 'https://x/1' }])
  it('nenhuma variação oferece data; a porta "já pagou? responde" continua aberta', () => {
    for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const t = fallbackMessage('Ana', summary, 0, seed, { offerDate: false })
      expect(t.toLowerCase()).not.toContain('combinar')
      expect(t.toLowerCase()).not.toContain('data')
      expect(t).toContain('https://x/1')
      expect(/pagou|respond/i.test(t)).toBe(true)
    }
  })
  it('padrão continua oferecendo data (compat)', () => {
    expect(fallbackMessage('Ana', summary, 0, 0)).toContain('combinar uma data')
    expect(normalizeSettings({}).offerDateNegotiation).toBe(true)
    expect(normalizeSettings({ offerDateNegotiation: false }).offerDateNegotiation).toBe(false)
    expect(normalizeSettings({ sectorId: 'x' }).sectorId).toBeNull()
  })
  it('lembrete também', () => {
    const up = formatUpcomingSummary([{ value: 50, dueDate: '2026-09-12', daysUntil: 2, connectionLabel: 'A', invoiceUrl: 'https://y/1' }])
    for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(fallbackReminderMessage('Ana', up, seed, { offerDate: false }).toLowerCase()).not.toContain('outra data')
    }
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
    expect(withinWindow(12, 6, { ...s, sendWeekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(true)
  })

  // 11/09 (Alex): "quem cobra no sábado deixa de segunda a sábado, quem não
  // cobra deixa de segunda a sexta" — e domingo/feriado nunca.
  it('cada conta escolhe os dias: segunda a sábado sem domingo', () => {
    const ate_sabado = { ...s, sendWeekdays: [1, 2, 3, 4, 5, 6] }
    expect(withinWindow(12, 6, ate_sabado)).toBe(true)
    expect(withinWindow(12, 0, ate_sabado)).toBe(false)
  })

  it('feriado nacional não dispara, e a data é obrigatória pra saber disso', () => {
    const sexta_santa = '2026-04-03' // Páscoa 2026 = 05/04
    expect(withinWindow(12, 5, s, sexta_santa)).toBe(false)
    expect(withinWindow(12, 5, s, '2026-04-10')).toBe(true)
    expect(withinWindow(12, 5, { ...s, skipHolidays: false }, sexta_santa)).toBe(true)
    // Sem a data, a régua não inventa feriado — só o dia da semana manda.
    expect(withinWindow(12, 5, s)).toBe(true)
  })

  it('diz POR QUE o dia está bloqueado, em português', () => {
    expect(dayBlockedReason(0, s)).toBe('Domingo não está nos dias de cobrança')
    expect(dayBlockedReason(5, s, '2026-12-25')).toBe('Feriado nacional (Natal)')
    expect(dayBlockedReason(3, s, '2026-09-16')).toBeNull()
  })
})

describe('thanksDayBlockedReason — agradecer não é cobrar (11/09)', () => {
  it('sai no SÁBADO mesmo com a régua em segunda a sexta', () => {
    expect(s.sendWeekdays).toEqual([1, 2, 3, 4, 5])
    expect(dayBlockedReason(6, s)).toBe('Sábado não está nos dias de cobrança')
    expect(thanksDayBlockedReason(6, s)).toBeNull()
  })
  it('nunca no domingo nem em feriado', () => {
    expect(thanksDayBlockedReason(0, s)).toBe('Domingo')
    expect(thanksDayBlockedReason(5, s, '2026-12-25')).toBe('Feriado nacional (Natal)')
    expect(thanksDayBlockedReason(5, { ...s, skipHolidays: false }, '2026-12-25')).toBeNull()
  })
})

describe('normalizeWeekdays — lista vazia nunca vira "cobra todo dia"', () => {
  it('conta antiga herda o que já valia para ela', () => {
    expect(normalizeWeekdays(undefined, true)).toEqual([1, 2, 3, 4, 5])
    expect(normalizeWeekdays([], true)).toEqual([1, 2, 3, 4, 5])
    expect(normalizeWeekdays(undefined, false)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it('joga fora o que não é dia da semana, sem repetir e em ordem', () => {
    expect(normalizeWeekdays([6, 1, 1, 99, -2, 'seg'])).toEqual([1, 6])
  })
})

describe('describeWeekdays — como a tela conta isso pro dono', () => {
  it('sequência vira intervalo', () => {
    expect(describeWeekdays([1, 2, 3, 4, 5])).toBe('segunda a sexta')
    expect(describeWeekdays([1, 2, 3, 4, 5, 6])).toBe('segunda a sábado')
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('todos os dias')
  })
  it('dias soltos viram lista', () => {
    expect(describeWeekdays([1, 3, 5])).toBe('seg, qua e sex')
    expect(describeWeekdays([2])).toBe('ter')
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

  // 09/09 (João/GoLink): "com 3 boletos vencidos o sistema manda os 3 links?"
  // Antes, com mais de um link a mensagem saía SEM link nenhum.
  it('com várias parcelas, cada linha carrega o próprio link', () => {
    const r = formatDebtSummary(charges)
    expect(r.items.map((i) => i.url)).toEqual(['https://x/1', 'https://x/2'])
    const corpo = formatDebtBody(r)
    expect(corpo).toContain('https://x/1')
    expect(corpo).toContain('https://x/2')
    // o link fica logo abaixo da parcela dele, na ordem do atraso
    expect(corpo.indexOf('40 dias')).toBeLessThan(corpo.indexOf('https://x/1'))
    expect(corpo.indexOf('https://x/1')).toBeLessThan(corpo.indexOf('9 dias'))
  })

  it('com um link só, o corpo não repete o link (ele vai no fim da mensagem)', () => {
    const r = formatDebtSummary([charges[0]])
    expect(formatDebtBody(r)).not.toContain('https://x/1')
    expect(linksInstruction(r)).toContain('no final: https://x/1')
  })

  it('instrução pra IA lista todos os links quando há mais de um', () => {
    const inst = linksInstruction(formatDebtSummary(charges))
    expect(inst).toContain('2 parcelas')
    expect(inst).toContain('https://x/1')
    expect(inst).toContain('https://x/2')
    expect(linksInstruction(formatDebtSummary([{ ...charges[0], invoiceUrl: null }]))).toBe('')
  })
})

describe('fallbackMessage com 3 parcelas vencidas — todos os links saem', () => {
  const tres = formatDebtSummary([
    { value: 100, dueDate: '2026-07-01', daysLate: 70, connectionLabel: 'Asaas', invoiceUrl: 'https://x/a' },
    { value: 100, dueDate: '2026-08-01', daysLate: 40, connectionLabel: 'Asaas', invoiceUrl: 'https://x/b' },
    { value: 100, dueDate: '2026-09-01', daysLate: 9, connectionLabel: 'Asaas', invoiceUrl: 'https://x/c' },
  ])
  it('a mensagem de segurança traz os 3 links, um por parcela', () => {
    const t = fallbackMessage('Ana', tres, 0)
    for (const u of ['https://x/a', 'https://x/b', 'https://x/c']) expect(t).toContain(u)
  })
  it('lembrete antes de vencer também', () => {
    const up = formatUpcomingSummary([
      { value: 50, dueDate: '2026-09-12', daysUntil: 2, connectionLabel: 'Asaas', invoiceUrl: 'https://y/1' },
      { value: 60, dueDate: '2026-09-13', daysUntil: 3, connectionLabel: 'Asaas', invoiceUrl: 'https://y/2' },
    ])
    const t = fallbackReminderMessage('Ana', up, 1)
    expect(t).toContain('https://y/1')
    expect(t).toContain('https://y/2')
    expect(t).not.toContain('Para pagar:')
    const um = formatUpcomingSummary([{ value: 50, dueDate: '2026-09-12', daysUntil: 2, connectionLabel: 'Asaas', invoiceUrl: 'https://y/1' }])
    expect(fallbackReminderMessage('Ana', um, 1)).toContain('Para pagar: https://y/1')
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

describe('duplicateSuspects — o caso Renato ×3', () => {
  it('mesmo valor e vencimento em dois cadastros = suspeito', () => {
    expect(
      duplicateSuspects([
        { customerId: 'cus_a', value: 1298.5, dueDate: '2026-10-04' },
        { customerId: 'cus_b', value: 1298.5, dueDate: '2026-10-04' },
      ]),
    ).toBe(true)
  })

  it('parcelas diferentes do mesmo cadastro, ou iguais no MESMO cadastro, não são suspeitas', () => {
    expect(
      duplicateSuspects([
        { customerId: 'cus_a', value: 1298.5, dueDate: '2026-10-04' },
        { customerId: 'cus_a', value: 1298.5, dueDate: '2026-11-04' },
        { customerId: 'cus_a', value: 1298.5, dueDate: '2026-10-04' },
      ]),
    ).toBe(false)
  })

  it('sem cadastro ou sem vencimento não conta', () => {
    expect(duplicateSuspects([{ customerId: null, value: 10, dueDate: '2026-10-04' }, { customerId: 'x', value: 10, dueDate: null }])).toBe(false)
  })

  it('a configuração "o CRM assume os avisos" nasce desligada', () => {
    expect(normalizeSettings({}).asaasNotificationsOff).toBe(false)
    expect(normalizeSettings({ asaasNotificationsOff: true }).asaasNotificationsOff).toBe(true)
    expect(normalizeSettings({ asaasNotificationsOff: 'sim' }).asaasNotificationsOff).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import {
  NEW_CHARGE_GRACE_MIN,
  NEW_CHARGE_HORIZON_DAYS,
  addDaysYmd,
  asaasNotifies,
  asaasReachesCustomer,
  classifyNewCharge,
  fullSweepReason,
  isUuidRef,
  ligaAvisosFloor,
  newChargeGraceCutoffIso,
  newChargeSince,
  remindedFilter,
  shortChargeDescription,
  silencedBeforeCharge,
  weekdayOfYmd,
  type NewChargeContext,
  type NewChargePayment,
  type PaymentCreatedFlags,
  type SilencedRecord,
} from './new-charge-rules'
import { COLLECTIONS_DEFAULTS, dayBlockedReason, type CollectionsSettings } from './rules'

// 17/09 (GoLink): o aviso de cobrança nova nunca disparou — lia a carteira, que
// só espelha vencidas. Os casos abaixo são os reais de 10 a 17/09.

const diaDeEnvio = (s: CollectionsSettings) => (ymd: string) => !dayBlockedReason(weekdayOfYmd(ymd), s, ymd)
const golink: CollectionsSettings = { ...COLLECTIONS_DEFAULTS, enabled: true, asaasNotificationsOff: true }

describe('newChargeSince — janela em dias de ENVIO, não corridos', () => {
  it('segunda 21/09 volta até quinta 17/09: a de sexta 17h30 entra, a de quarta fica de fora', () => {
    expect(weekdayOfYmd('2026-09-21')).toBe(1)
    expect(newChargeSince('2026-09-21', [], diaDeEnvio(golink))).toBe('2026-09-17')
  })

  it('quinta 17/09 (dia da correção) → terça 15/09: as do painel do João entram', () => {
    expect(newChargeSince('2026-09-17', [], diaDeEnvio(golink))).toBe('2026-09-15')
  })

  it('feriado não conta como dia de envio (12/10); sem "pular feriado" conta', () => {
    expect(newChargeSince('2026-10-13', [], diaDeEnvio(golink))).toBe('2026-10-08')
    expect(newChargeSince('2026-10-13', [], diaDeEnvio({ ...golink, skipHolidays: false }))).toBe('2026-10-09')
  })

  it('nunca antes do dia em que a conexão foi ligada', () => {
    expect(newChargeSince('2026-09-18', ['2026-09-16'], diaDeEnvio(golink))).toBe('2026-09-16')
    expect(newChargeSince('2026-09-18', ['2026-09-17'], diaDeEnvio(golink))).toBe('2026-09-17')
  })

  it('liga-avisos em 16/09 → piso no dia seguinte (o Asaas avisou as de 16/09)', () => {
    expect(newChargeSince('2026-09-18', [null, addDaysYmd('2026-09-16', 1)], diaDeEnvio(golink))).toBe('2026-09-17')
  })

  it('piso inválido é ignorado', () => {
    expect(newChargeSince('2026-09-17', ['lixo', undefined], diaDeEnvio(golink))).toBe('2026-09-15')
  })

  // Revisão 17/09: trazer o piso de amanhã para hoje punha na janela a cobrança
  // das 08:00 que o Asaas avisou antes de a varredura das 10:30 calar o cliente.
  it('piso no futuro volta como está (quem chama pula a conexão: sem janela até lá)', () => {
    expect(newChargeSince('2026-09-17', ['2026-09-18'], diaDeEnvio(golink))).toBe('2026-09-18')
    expect(newChargeSince('2026-09-17', ['2026-09-30'], diaDeEnvio(golink))).toBe('2026-09-30')
  })

  it('conta que só cobra às segundas volta duas semanas (três, com o 7 de Setembro no caminho)', () => {
    expect(newChargeSince('2026-09-21', [], diaDeEnvio({ ...golink, sendWeekdays: [1], skipHolidays: false }))).toBe('2026-09-07')
    expect(newChargeSince('2026-09-21', [], diaDeEnvio({ ...golink, sendWeekdays: [1] }))).toBe('2026-08-31')
  })
})

// Dia local em Brasília (UTC-3, sem horário de verão desde 2019).
const diaBrasilia = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10)

describe('ligaAvisosFloor — o piso conta da 1ª varredura DEPOIS de ligar, não do clique', () => {
  it('conta que ligou antes de existir o campo (GoLink) → sem piso, como antes', () => {
    expect(ligaAvisosFloor(null, null, diaBrasilia)).toEqual({ wait: false, floor: null })
    expect(ligaAvisosFloor(null, '2026-09-17T12:00:00Z', diaBrasilia)).toEqual({ wait: false, floor: null })
  })

  it('ligou e a varredura ainda não rodou → espera (o Asaas segue avisando)', () => {
    expect(ligaAvisosFloor('2026-09-18T20:30:00Z', null, diaBrasilia)).toEqual({ wait: true })
    // Varredura de antes do clique (desligou e religou) não vale.
    expect(ligaAvisosFloor('2026-09-18T20:30:00Z', '2026-09-18T12:00:00Z', diaBrasilia)).toEqual({ wait: true })
  })

  it('ligada sexta 17h30, 1ª varredura segunda 9h → piso terça: as de sábado e domingo o Asaas avisou', () => {
    const r = ligaAvisosFloor('2026-09-18T20:30:00Z', '2026-09-21T12:00:00Z', diaBrasilia)
    expect(r).toEqual({ wait: false, floor: '2026-09-22' })
    const piso = (r as { floor: string }).floor
    // Segunda: o piso está no futuro → sem janela (antes o piso era sábado e a de sábado saía de novo).
    expect(newChargeSince('2026-09-21', [piso], diaDeEnvio(golink))).toBe('2026-09-22')
    // Terça: só o que nasceu de terça em diante.
    expect(newChargeSince('2026-09-22', [piso], diaDeEnvio(golink))).toBe('2026-09-22')
  })

  it('ligada 10:00 e varrida 10:30 do mesmo dia → nada de hoje entra hoje (a das 08:00 o Asaas avisou)', () => {
    const r = ligaAvisosFloor('2026-09-17T13:00:00Z', '2026-09-17T13:30:00Z', diaBrasilia)
    expect(r).toEqual({ wait: false, floor: '2026-09-18' })
    expect(newChargeSince('2026-09-17', [(r as { floor: string }).floor], diaDeEnvio(golink))).toBe('2026-09-18')
  })

  it('varredura às 22h de Brasília (já é outro dia em UTC) conta pelo dia local', () => {
    expect(ligaAvisosFloor('2026-09-17T13:00:00Z', '2026-09-18T01:00:00Z', diaBrasilia)).toEqual({ wait: false, floor: '2026-09-18' })
  })
})

// Revisão 17/09: ligar a opção zerava a varredura, mas o portão de 20 h olhava a
// CONEXÃO — com o selo clicado antes, nada varria por um dia e as cobranças
// desse meio-tempo viravam "antiga" para sempre (cliente calado, ninguém avisava).
describe('fullSweepReason — ligar "o CRM assume os avisos" antecipa a varredura completa', () => {
  const H = 3_600_000
  const everyMs = 20 * H
  // Segunda 21/09/2026, horário de Brasília (UTC-3).
  const seg = (hhmm: string) => `2026-09-21T${String(Number(hhmm.slice(0, 2)) + 3).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`
  const agora = (hhmm: string) => Date.parse(seg(hhmm))

  it('selo seg 10:00, opção ligada 10:05, sincronização 11:00 → varre já (antes: só depois de 20 h)', () => {
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: seg('10:00'), offAt: seg('10:05'), sweptAt: null, everyMs })).toBe('espera_varredura')
  })

  it('o cenário inteiro: com a varredura de 11:00, a quarta já avisa o que nasceu na terça', () => {
    // A varredura de 11:00 grava o instante (markAsaasNotificationsSwept): o piso é terça.
    const r = ligaAvisosFloor(seg('10:05'), seg('11:00'), diaBrasilia)
    expect(r).toEqual({ wait: false, floor: '2026-09-22' })
    const piso = (r as { floor: string }).floor
    // Quarta: a janela começa terça — antes, com a varredura só na terça 9h, começava quarta
    // e as cobranças de segunda e terça (clientes calados pelo selo) ficavam "antiga".
    // As de segunda, dia em que a opção foi ligada, continuam fora: o piso é o dia seguinte à varredura.
    expect(newChargeSince('2026-09-23', [piso], diaDeEnvio(golink))).toBe('2026-09-22')
    // E, gravada a varredura, a conexão volta à rotina.
    expect(fullSweepReason({ nowMs: agora('12:00'), lastSweepAt: seg('11:00'), offAt: seg('10:05'), sweptAt: seg('11:00'), everyMs })).toBeNull()
  })

  it('listagem que falhou renova a conexão mas não grava a varredura → a próxima sincronização tenta de novo', () => {
    // A tentativa das 11:00 falhou: notifications_off_at da conexão = 11:00, sweptAt segue nulo.
    expect(fullSweepReason({ nowMs: agora('12:00'), lastSweepAt: seg('11:00'), offAt: seg('10:05'), sweptAt: null, everyMs })).toBe('espera_varredura')
  })

  it('desmarcar e remarcar numa conta com a varredura diária (GoLink às 9h) → varre já', () => {
    // Remarcou às 10:05: o Salvar zerou a varredura; a das 9h (antes do clique) não vale.
    expect(fullSweepReason({ nowMs: agora('10:30'), lastSweepAt: seg('09:00'), offAt: seg('10:05'), sweptAt: null, everyMs })).toBe('espera_varredura')
    // Um Salvar concorrente que regravou a varredura antiga também não engana.
    expect(fullSweepReason({ nowMs: agora('10:30'), lastSweepAt: seg('09:00'), offAt: seg('10:05'), sweptAt: seg('09:00'), everyMs })).toBe('espera_varredura')
  })

  it('duas contas do Asaas: a 1ª gravou a varredura; a 2ª, varrida antes do clique, também varre já', () => {
    expect(fullSweepReason({ nowMs: agora('11:05'), lastSweepAt: seg('09:00'), offAt: seg('10:05'), sweptAt: seg('11:00'), everyMs })).toBe('conexao_antes_do_clique')
  })

  it('sem o campo (conta que ligou antes dele, GoLink hoje) → só a rotina de 20 h', () => {
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: seg('09:00'), offAt: null, sweptAt: null, everyMs })).toBeNull()
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: '2026-09-20T12:00:00.000Z', offAt: null, sweptAt: null, everyMs })).toBe('rotina')
  })

  it('rotina: conexão nunca varrida, ou há mais de 20 h (data do banco com espaço e +00 também serve)', () => {
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: null, offAt: null, sweptAt: null, everyMs })).toBe('rotina')
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: '2026-09-21 12:00:00.123+00', offAt: null, sweptAt: null, everyMs })).toBeNull()
    expect(fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: '2026-09-20 16:00:00+00', offAt: null, sweptAt: null, everyMs })).toBe('rotina')
  })

  it('ligada há dias, varrida depois do clique → só a rotina', () => {
    expect(
      fullSweepReason({ nowMs: agora('11:00'), lastSweepAt: seg('09:00'), offAt: '2026-09-01T12:00:00.000Z', sweptAt: '2026-09-01T13:00:00.000Z', everyMs }),
    ).toBeNull()
  })
})

describe('classifyNewCharge — o que é cobrança nova de verdade', () => {
  const vazio: ReadonlySet<string> = new Set()
  const ctx = (over: Partial<NewChargeContext> = {}): NewChargeContext => ({
    since: '2026-09-15',
    todayKey: '2026-09-15',
    horizonDays: NEW_CHARGE_HORIZON_DAYS,
    noticed: vazio,
    crmPaymentIds: vazio,
    crmRefs: vazio,
    crmGroups: vazio,
    ...over,
  })
  const pay = (over: Partial<NewChargePayment> = {}): NewChargePayment => ({
    id: 'pay_1',
    status: 'PENDING',
    dateCreated: '2026-09-15',
    dueDate: '2026-09-20',
    invoiceUrl: 'https://www.asaas.com/i/1',
    billingType: 'BOLETO',
    ...over,
  })

  it('renovação de assinatura gerada 39 dias antes → vence_longe (as 59 reais)', () => {
    expect(classifyNewCharge(pay({ dateCreated: '2026-09-16', dueDate: '2026-10-25', subscription: 'sub_1' }), ctx({ todayKey: '2026-09-16' }))).toBe(
      'vence_longe',
    )
  })

  it('"Cobrança gerada automaticamente a partir de Pix" já recebida → status', () => {
    expect(classifyNewCharge(pay({ status: 'RECEIVED', billingType: 'PIX' }), ctx())).toBe('status')
    expect(classifyNewCharge(pay({ status: 'CONFIRMED' }), ctx())).toBe('status')
  })

  it('Leva Entulho em 3x (20/09, 20/10, 20/11) → só a 1ª', () => {
    const c = ctx()
    expect(classifyNewCharge(pay({ id: 'p1', dueDate: '2026-09-20', installment: 'ins_1' }), c)).toBe('ok')
    expect(classifyNewCharge(pay({ id: 'p2', dueDate: '2026-10-20', installment: 'ins_1' }), c)).toBe('vence_longe')
    expect(classifyNewCharge(pay({ id: 'p3', dueDate: '2026-11-20', installment: 'ins_1' }), c)).toBe('vence_longe')
  })

  it('Convictus: assinatura nova com 1ª em 20/09 e 2ª em 20/10 → 1ª ok, 2ª vence_longe', () => {
    const c = ctx()
    expect(classifyNewCharge(pay({ id: 'c1', dueDate: '2026-09-20', subscription: 'sub_c' }), c)).toBe('ok')
    expect(classifyNewCharge(pay({ id: 'c2', dueDate: '2026-10-20', subscription: 'sub_c' }), c)).toBe('vence_longe')
  })

  it('horizonte: vence em 15 dias ainda entra, em 16 não', () => {
    expect(classifyNewCharge(pay({ dueDate: '2026-09-30' }), ctx())).toBe('ok')
    expect(classifyNewCharge(pay({ dueDate: '2026-10-01' }), ctx())).toBe('vence_longe')
  })

  it('já avisada → ja_avisado (antes de abrir o cadastro no Asaas)', () => {
    expect(classifyNewCharge(pay({ id: 'pay_x' }), ctx({ noticed: new Set(['pay_x']) }))).toBe('ja_avisado')
  })

  it('criada pelo CRM: por id, por referência (conversa/contato/conta, maiúscula ou não) e pelo grupo', () => {
    const conv = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(classifyNewCharge(pay({ id: 'pay_crm' }), ctx({ crmPaymentIds: new Set(['pay_crm']) }))).toBe('criada_pelo_crm')
    // 2ª mensalidade do Dom Burguer: o Asaas repassa a referência da assinatura.
    expect(classifyNewCharge(pay({ externalReference: conv.toUpperCase() }), ctx({ crmRefs: new Set([conv]) }))).toBe('criada_pelo_crm')
    expect(classifyNewCharge(pay({ installment: 'ins_crm' }), ctx({ crmGroups: new Set(['ins_crm']) }))).toBe('criada_pelo_crm')
    expect(classifyNewCharge(pay({ subscription: 'sub_crm' }), ctx({ crmGroups: new Set(['sub_crm']) }))).toBe('criada_pelo_crm')
  })

  it('referência de ERP, ou UUID que não é do CRM → segue ok', () => {
    expect(classifyNewCharge(pay({ externalReference: 'PED-4471' }), ctx())).toBe('ok')
    expect(classifyNewCharge(pay({ externalReference: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }), ctx())).toBe('ok')
  })

  it('sem link, criada antes da janela ou sem data de criação', () => {
    expect(classifyNewCharge(pay({ invoiceUrl: null }), ctx())).toBe('sem_link')
    expect(classifyNewCharge(pay({ dateCreated: '2026-09-14' }), ctx())).toBe('antiga')
    expect(classifyNewCharge(pay({ dateCreated: null }), ctx())).toBe('antiga')
  })

  it('nasceu vencida hoje (caso Sérgio Lemes) → ok', () => {
    expect(classifyNewCharge(pay({ status: 'OVERDUE', dueDate: '2026-09-15' }), ctx())).toBe('ok')
  })

  it('mensalidade no cartão (o Asaas debita sozinho) → cartao_recorrente; cartão avulso segue', () => {
    expect(classifyNewCharge(pay({ subscription: 'sub_cc', billingType: 'CREDIT_CARD' }), ctx())).toBe('cartao_recorrente')
    expect(classifyNewCharge(pay({ billingType: 'CREDIT_CARD' }), ctx())).toBe('ok')
  })

  // Revisão 17/09: quem abriu o link de pagamento e gerou o boleto já está com ele na tela.
  it('gerada pelo cliente num link de pagamento ou checkout do Asaas → gerada_pelo_cliente', () => {
    expect(classifyNewCharge(pay({ paymentLink: 'lnk_abc123' }), ctx())).toBe('gerada_pelo_cliente')
    expect(classifyNewCharge(pay({ checkoutSession: 'chk_987' }), ctx())).toBe('gerada_pelo_cliente')
    expect(classifyNewCharge(pay({ paymentLink: '  ', checkoutSession: null }), ctx())).toBe('ok')
    // Já avisada continua pesando antes (não abre nada no Asaas).
    expect(classifyNewCharge(pay({ id: 'pay_l', paymentLink: 'lnk_1' }), ctx({ noticed: new Set(['pay_l']) }))).toBe('ja_avisado')
  })
})

const semCanal: PaymentCreatedFlags = { enabled: true, email: false, sms: false, whatsapp: false, phoneCall: false }
const soSms: PaymentCreatedFlags = { ...semCanal, sms: true }

describe('asaasReachesCustomer — canal ligado sem o dado do canal não entrega nada', () => {
  it('só o e-mail ligado e cliente sem e-mail → o Asaas não avisa (revisão 17/09)', () => {
    expect(asaasReachesCustomer({ ...semCanal, email: true }, { mobilePhone: '67990000001' })).toBe(false)
    expect(asaasReachesCustomer({ ...semCanal, email: true }, { email: ' ', mobilePhone: '67990000001' })).toBe(false)
    expect(asaasReachesCustomer({ ...semCanal, email: true }, { email: 'fin@leva.com' })).toBe(true)
  })

  it('SMS e WhatsApp vão para o celular; a ligação, para o fixo ou o celular', () => {
    expect(asaasReachesCustomer(soSms, { email: 'fin@leva.com' })).toBe(false)
    expect(asaasReachesCustomer(soSms, { mobilePhone: '67990000001' })).toBe(true)
    expect(asaasReachesCustomer({ ...semCanal, whatsapp: true }, { phone: '6733330000' })).toBe(false)
    expect(asaasReachesCustomer({ ...semCanal, whatsapp: true }, { mobilePhone: '67990000001' })).toBe(true)
    expect(asaasReachesCustomer({ ...semCanal, phoneCall: true }, { phone: '6733330000' })).toBe(true)
    expect(asaasReachesCustomer({ ...semCanal, phoneCall: true }, {})).toBe(false)
  })

  it('evento desligado não entrega, mesmo com canal e dado', () => {
    expect(asaasReachesCustomer({ ...soSms, enabled: false }, { mobilePhone: '67990000001' })).toBe(false)
  })
})

describe('silencedBeforeCharge — o cliente já estava calado quando a cobrança nasceu?', () => {
  // Varredura de quarta 16/09 às 9h (12:00Z), lista tirada logo depois, desde 15/09.
  const varredura: SilencedRecord = { at: '2026-09-16T12:00:00Z', beforeSince: '2026-09-15', before: ['pay_x'] }

  it('está na lista do que já existia ao calar → depois (o Asaas avisou); não está → antes', () => {
    expect(silencedBeforeCharge({ dateCreated: '2026-09-15' }, 'pay_x', '2026-09-16', varredura, diaBrasilia)).toBe('depois')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-15' }, 'pay_y', '2026-09-16', varredura, diaBrasilia)).toBe('antes')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-15' }, 'pay_z', '2026-09-18', varredura, diaBrasilia)).toBe('antes')
  })

  it('cobrança de antes do período da lista → depois (nasceu antes de calar)', () => {
    expect(silencedBeforeCharge({ dateCreated: '2026-01-01' }, 'pay_v', '2026-09-14', varredura, diaBrasilia)).toBe('depois')
  })

  it('sem registro → antes (nasceu calado ou foi calado há mais de 35 dias); Redis fora → não sei', () => {
    expect(silencedBeforeCharge({ dateCreated: '2026-09-16' }, 'pay_x', '2026-09-16', null, diaBrasilia)).toBe('antes')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-16' }, 'pay_x', '2026-09-16', undefined, diaBrasilia)).toBe('nao_sei')
  })

  it('sem a lista, pelo dia: antes do dia de calar = depois; depois = antes; mesmo dia só se o cliente nasceu nele', () => {
    const semLista: SilencedRecord = { at: '2026-09-16T12:00:00Z' }
    expect(silencedBeforeCharge({ dateCreated: '2026-09-01' }, 'p', '2026-09-15', semLista, diaBrasilia)).toBe('depois')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-01' }, 'p', '2026-09-17', semLista, diaBrasilia)).toBe('antes')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-01' }, 'p', '2026-09-16', semLista, diaBrasilia)).toBe('antes')
    expect(silencedBeforeCharge({ dateCreated: '2026-09-16' }, 'p', '2026-09-16', semLista, diaBrasilia)).toBe('depois')
  })

  it('data da cobrança ou do registro inválida → não sei', () => {
    expect(silencedBeforeCharge({}, 'p', '', varredura, diaBrasilia)).toBe('nao_sei')
    expect(silencedBeforeCharge({}, 'p', '2026-09-16', { at: 'ontem' }, diaBrasilia)).toBe('nao_sei')
  })
})

describe('asaasNotifies — o próprio Asaas ainda avisa este cliente?', () => {
  const crmContact = '44f5e06c-0000-4000-8000-000000000001'
  const base = { isCrmRef: (r?: string | null) => r === crmContact, dayOf: diaBrasilia }
  const ctx = (chargeId: string, chargeCreated: string, silenced: SilencedRecord | null | undefined) => ({ ...base, chargeId, chargeCreated, silenced })
  const celular = '67990000001'

  it('calado há tempo (sem registro) → não avisa, sem GET', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-08-01', mobilePhone: celular }, ctx('p', '2026-09-16', null))).toBe('no')
  })

  it('avisos ligados (varredura recusada por assinatura ativa) → precisa das chaves', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-08-01' }, ctx('p', '2026-09-16', null))).toBe('need_flags')
  })

  // Achado da revisão 17/09: a mesma cobrança dava "o Asaas avisa" na quarta e
  // na quinta e "não avisa" na sexta (o `since` andava) — e o link saía dobrado.
  it('cliente criado terça 14h, cobrança quarta 08:00, varredura quarta 9h → o veredito não depende do dia', () => {
    const cliente = { notificationDisabled: true, dateCreated: '2026-09-15', mobilePhone: celular }
    const calado: SilencedRecord = { at: '2026-09-16T12:00:00Z', beforeSince: '2026-09-15', before: ['pay_x'] }
    // Nada no contexto é "hoje" nem a janela: quarta, quinta e sexta dão o mesmo.
    expect(asaasNotifies(cliente, ctx('pay_x', '2026-09-16', calado))).toBe('need_flags')
    expect(asaasNotifies(cliente, ctx('pay_x', '2026-09-16', calado), soSms)).toBe('yes')
  })

  // Achado da revisão 17/09: calado dentro da janela caía nas chaves por evento
  // (que o Asaas não mexe ao calar) e ninguém avisava.
  it('cliente de ERP que já nasce calado, cobrança no mesmo dia → o CRM avisa (as chaves nem são lidas)', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-09-16', mobilePhone: celular }, ctx('pay_erp', '2026-09-16', null))).toBe('no')
  })

  it('calado pela varredura de terça 9h, 2ª cobrança terça 11h (fora da lista) → o CRM avisa no mesmo dia', () => {
    const calado: SilencedRecord = { at: '2026-09-15T12:00:00Z', beforeSince: '2026-09-14', before: ['pay_1a'] }
    const cliente = { notificationDisabled: true, dateCreated: '2026-09-14', mobilePhone: celular }
    expect(asaasNotifies(cliente, ctx('pay_2a', '2026-09-15', calado))).toBe('no')
    expect(asaasNotifies(cliente, ctx('pay_1a', '2026-09-15', calado))).toBe('need_flags')
  })

  it('Redis fora (não deu para ler o registro) → as chaves decidem', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-08-01' }, ctx('p', '2026-09-16', undefined))).toBe('need_flags')
  })

  it('Andressa/Convictus: PAYMENT_CREATED sem canal nenhum → não avisa', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15', mobilePhone: celular }, ctx('p', '2026-09-15', null), semCanal)).toBe('no')
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15' }, ctx('p', '2026-09-15', null), { ...semCanal, enabled: false })).toBe('no')
  })

  it('cliente novo com SMS de cobrança criada ligado e celular → o Asaas avisa', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15', mobilePhone: celular }, ctx('p', '2026-09-15', null), soSms)).toBe('yes')
  })

  // Achado da revisão 17/09: só o e-mail ligado num cadastro sem e-mail — nem o Asaas nem o CRM mandavam.
  it('só o e-mail ligado e cadastro sem e-mail → o Asaas não avisa, o CRM manda', () => {
    expect(
      asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15', mobilePhone: celular }, ctx('p', '2026-09-15', null), { ...semCanal, email: true }),
    ).toBe('no')
  })

  it('cliente criado pelo CRM → não avisa (nasce calado), mesmo com chave ligada', () => {
    expect(
      asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-11', externalReference: crmContact, mobilePhone: celular }, ctx('p', '2026-09-16', null), soSms),
    ).toBe('no')
  })
})

describe('newChargeGraceCutoffIso — carência antes do sender', () => {
  it('é agora menos 30 min, num ISO que o banco entende', () => {
    const agora = Date.parse('2026-09-17T13:40:00.000Z')
    expect(NEW_CHARGE_GRACE_MIN).toBe(30)
    expect(newChargeGraceCutoffIso(agora)).toBe('2026-09-17T13:10:00.000Z')
  })

  it('aviso criado há 10 min ainda espera; há 31 min sai', () => {
    const agora = Date.parse('2026-09-17T13:40:00.000Z')
    const sai = (criadoMs: number) => criadoMs <= Date.parse(newChargeGraceCutoffIso(agora))
    expect(sai(agora - 10 * 60_000)).toBe(false)
    expect(sai(agora - 31 * 60_000)).toBe(true)
  })
})

describe('remindedFilter — o aviso na criação não apaga o lembrete D-5', () => {
  const agora = Date.parse('2026-09-21T12:00:00Z')
  const diasAtras = (n: number) => new Date(agora - n * 86_400_000).toISOString()
  // reminderDaysBefore = 5 → só conta aviso dos últimos 6 dias.
  const corte = diasAtras(6)
  const row = (kind: string, dias: number) => ({ kind, createdAt: diasAtras(dias), contactId: 'c1', payload: { kind, asaasIds: ['p'] } })

  it('aviso de cobrança nova de 10 dias atrás (Alpha Gás) não conta → o lembrete sai', () => {
    expect(remindedFilter([row('new_charge', 10)], corte)).toHaveLength(0)
  })

  it('aviso de 3 dias atrás conta → não repete o link', () => {
    expect(remindedFilter([row('new_charge', 3)], corte)).toHaveLength(1)
  })

  it('lembrete conta sempre (45 dias vêm da consulta)', () => {
    expect(remindedFilter([row('reminder', 40)], corte)).toHaveLength(1)
  })

  it('outros tipos não contam; kind também é lido do payload', () => {
    expect(remindedFilter([row('overdue', 1)], corte)).toHaveLength(0)
    expect(remindedFilter([{ createdAt: diasAtras(1), contactId: 'c1', payload: { kind: 'new_charge' } }], corte)).toHaveLength(1)
  })

  it('data do banco com espaço e +00 também serve', () => {
    expect(remindedFilter([{ kind: 'new_charge', createdAt: '2026-09-19 10:00:00.123+00', contactId: 'c1', payload: {} }], corte)).toHaveLength(1)
  })
})

describe('apoio', () => {
  it('shortChargeDescription: uma linha, cortada em 60 com reticências', () => {
    const longa = `Plano Site + Google Meu Negócio\n\n${'detalhe '.repeat(30)}`
    const curta = shortChargeDescription(longa)
    expect(Array.from(curta)).toHaveLength(60)
    expect(curta.endsWith('…')).toBe(true)
    expect(curta).not.toMatch(/\n/)
    expect(shortChargeDescription('  Mensalidade  ')).toBe('Mensalidade')
  })

  it('isUuidRef só aceita UUID', () => {
    expect(isUuidRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
    expect(isUuidRef('PED-1')).toBe(false)
    expect(isUuidRef(null)).toBe(false)
  })
})

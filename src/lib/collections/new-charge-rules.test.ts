import { describe, expect, it } from 'vitest'

import {
  NEW_CHARGE_GRACE_MIN,
  NEW_CHARGE_HORIZON_DAYS,
  addDaysYmd,
  asaasNotifies,
  classifyNewCharge,
  isUuidRef,
  newChargeGraceCutoffIso,
  newChargeSince,
  remindedFilter,
  shortChargeDescription,
  weekdayOfYmd,
  type NewChargeContext,
  type NewChargePayment,
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

  it('piso inválido é ignorado; piso no futuro não passa de hoje', () => {
    expect(newChargeSince('2026-09-17', ['lixo', undefined], diaDeEnvio(golink))).toBe('2026-09-15')
    expect(newChargeSince('2026-09-17', ['2026-09-30'], diaDeEnvio(golink))).toBe('2026-09-17')
  })

  it('conta que só cobra às segundas volta duas semanas (três, com o 7 de Setembro no caminho)', () => {
    expect(newChargeSince('2026-09-21', [], diaDeEnvio({ ...golink, sendWeekdays: [1], skipHolidays: false }))).toBe('2026-09-07')
    expect(newChargeSince('2026-09-21', [], diaDeEnvio({ ...golink, sendWeekdays: [1] }))).toBe('2026-08-31')
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
})

describe('asaasNotifies — o próprio Asaas ainda avisa este cliente?', () => {
  const crmContact = '44f5e06c-0000-4000-8000-000000000001'
  const ctx = { since: '2026-09-15', isCrmRef: (r?: string | null) => r === crmContact }

  it('avisos desligados antes da janela → não avisa, sem GET', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-08-01' }, ctx)).toBe('no')
  })

  it('avisos ligados (varredura recusada por assinatura ativa) → precisa das chaves', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-08-01' }, ctx)).toBe('need_flags')
  })

  it('cliente novo, calado pela varredura depois de criado → precisa das chaves', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-09-15' }, ctx)).toBe('need_flags')
  })

  it('Andressa/Convictus: PAYMENT_CREATED sem canal nenhum → não avisa', () => {
    expect(asaasNotifies({ notificationDisabled: true, dateCreated: '2026-09-15' }, ctx, { enabled: true, anyChannel: false })).toBe('no')
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15' }, ctx, { enabled: false, anyChannel: false })).toBe('no')
  })

  it('cliente novo com SMS de cobrança criada ligado → o Asaas avisa', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-15' }, ctx, { enabled: true, anyChannel: true })).toBe('yes')
  })

  it('cliente criado pelo CRM → não avisa (nasce calado), mesmo com chave ligada', () => {
    expect(asaasNotifies({ notificationDisabled: false, dateCreated: '2026-09-11', externalReference: crmContact }, ctx, { enabled: true, anyChannel: true })).toBe(
      'no',
    )
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

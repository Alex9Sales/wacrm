import { describe, expect, it } from 'vitest'
import {
  camposAoMudarStatus,
  dataLocal,
  decideCalendario,
  decideComAsaas,
  diasDeAtraso,
  type CandidatoTrava,
} from './suspension'
import { dueStep, type ReminderCandidate } from './reminders'

/**
 * Suspender quem pagou é o erro que gera chamado e perde cliente. Suspender
 * quem não deve, idem. Quase todo caso aqui é sobre NÃO suspender.
 */

// Vencimento de exemplo: quinta-feira, 01/10/2026.
const VENC_MEIO_DIA = '2026-10-01T12:00:00Z' // como a assinatura grava
const VENC_MEIA_NOITE = '2026-10-01T00:00:00Z' // como o PATCH do /admin grava

/** Um instante dado em horário de BRASÍLIA (UTC-3). */
const sp = (dataHora: string) => new Date(`${dataHora}-03:00`)

const ATIVA: CandidatoTrava = {
  status: 'active',
  dueAt: VENC_MEIO_DIA,
  cancelAt: null,
  deletedAt: null,
  asaasSubscriptionId: 'sub_123',
  asaasPaymentId: null,
}

describe('contar os dias de atraso', () => {
  it('conta pela data de São Paulo', () => {
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-10-01T10:00:00'))).toBe(0)
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-10-06T10:00:00'))).toBe(5)
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-10-07T10:00:00'))).toBe(6)
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-09-30T10:00:00'))).toBe(-1)
  })

  it('às 22h de Brasília ainda é o mesmo dia — UTC já virou', () => {
    // 06/10 22h em SP = 07/10 01h em UTC. Contando em UTC, suspenderia um dia
    // antes do combinado. A rotina roda de hora em hora, então isso aconteceria.
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-10-06T22:00:00'))).toBe(5)
    expect(diasDeAtraso(VENC_MEIO_DIA, sp('2026-10-06T23:59:00'))).toBe(5)
  })

  it('o vencimento gravado à meia-noite UTC é o mesmo dia do gravado ao meio-dia', () => {
    // O /admin grava '2026-10-01' como 00:00Z, que em SP é 30/09 21h. Lido em
    // SP, o vencimento recuaria um dia e a suspensão viria um dia mais cedo.
    for (const agora of ['2026-10-01T10:00:00', '2026-10-06T15:00:00', '2026-10-07T09:00:00']) {
      expect(diasDeAtraso(VENC_MEIA_NOITE, sp(agora))).toBe(diasDeAtraso(VENC_MEIO_DIA, sp(agora)))
    }
  })

  it('data local em SP', () => {
    expect(dataLocal(sp('2026-10-06T23:30:00'))).toBe('2026-10-06')
  })
})

describe('pelo calendário: entrou na zona de suspensão?', () => {
  it('"venceu, não pagou, bloqueia": no DIA SEGUINTE ao vencimento, nunca no próprio dia', () => {
    // Vence quinta 01/10 → a quinta inteira ainda é dia de pagar → sexta 02/10 suspende.
    expect(decideCalendario(ATIVA, sp('2026-10-01T10:00:00')).suspender).toBe(false)
    expect(decideCalendario(ATIVA, sp('2026-10-01T23:59:00')).suspender).toBe(false)
    expect(decideCalendario(ATIVA, sp('2026-10-02T00:30:00')).suspender).toBe(true)
  })

  it('às 22h do dia do vencimento NÃO suspende — UTC já virou, São Paulo não', () => {
    // 01/10 22h em SP = 02/10 01h em UTC. Contando em UTC, a pessoa seria
    // trancada no próprio dia em que a fatura vence.
    expect(decideCalendario(ATIVA, sp('2026-10-01T22:00:00')).suspender).toBe(false)
  })

  it('NÃO suspende quem não tem cobrança no Asaas', () => {
    // 11 das 13 contas ativas em 30/09 têm vencimento digitado à mão e pagam
    // por fora. Suspender por esse campo trancaria cliente que pagou.
    const semVinculo = { ...ATIVA, asaasSubscriptionId: null, asaasPaymentId: null }
    expect(decideCalendario(semVinculo, sp('2026-10-20T10:00:00')).suspender).toBe(false)
  })

  it('NÃO mexe em quem não está ativo, está cancelando ou foi excluído', () => {
    const tarde = sp('2026-10-20T10:00:00')
    expect(decideCalendario({ ...ATIVA, status: 'trial' }, tarde).suspender).toBe(false)
    expect(decideCalendario({ ...ATIVA, status: 'suspended' }, tarde).suspender).toBe(false)
    expect(decideCalendario({ ...ATIVA, status: 'canceled' }, tarde).suspender).toBe(false)
    expect(decideCalendario({ ...ATIVA, cancelAt: '2026-10-31T00:00:00Z' }, tarde).suspender).toBe(false)
    expect(decideCalendario({ ...ATIVA, deletedAt: '2026-10-02T00:00:00Z' }, tarde).suspender).toBe(false)
  })

  it('sem vencimento ou com vencimento quebrado, não suspende', () => {
    const tarde = sp('2026-10-20T10:00:00')
    expect(decideCalendario({ ...ATIVA, dueAt: null }, tarde).suspender).toBe(false)
    expect(decideCalendario({ ...ATIVA, dueAt: 'lixo' }, tarde).suspender).toBe(false)
  })

  it('cobrança avulsa (semestral/anual) também conta como vínculo', () => {
    const avulsa = { ...ATIVA, asaasSubscriptionId: null, asaasPaymentId: 'pay_9' }
    expect(decideCalendario(avulsa, sp('2026-10-07T10:00:00')).suspender).toBe(true)
  })
})

describe('com a palavra do Asaas', () => {
  const quarta = sp('2026-10-07T10:00:00')

  it('pagou e o banco não sabe (webhook perdido): NÃO suspende', () => {
    // É o caso mais caro de errar: o cliente pagou e fica trancado.
    expect(decideComAsaas({ tipo: 'paga' }, quarta).suspender).toBe(false)
  })

  it('nada em aberto naquele vínculo: NÃO suspende', () => {
    expect(decideComAsaas({ tipo: 'nada_em_aberto' }, quarta).suspender).toBe(false)
  })

  it('vencida de verdade (venceu ontem ou antes): suspende', () => {
    const r = decideComAsaas(
      { tipo: 'vencida', dueDate: '2026-10-01', invoiceUrl: 'https://x', paymentId: 'pay_1' },
      quarta,
    )
    expect(r.suspender).toBe(true)
  })

  it('o Asaas diz que a mais antiga vence HOJE: NÃO suspende', () => {
    // O vencimento do banco pode estar errado; o do Asaas manda — e o dia do
    // vencimento ainda é dia de pagar.
    const r = decideComAsaas(
      { tipo: 'vencida', dueDate: '2026-10-07', invoiceUrl: null, paymentId: 'pay_2' },
      quarta,
    )
    expect(r.suspender).toBe(false)
  })
})

describe('o aviso de "em aberto" (+3) não morre no fim de semana', () => {
  // Vale para quem NÃO está sob a trava (contas sem assinatura no Asaas, que
  // pagam por fora): quem tem assinatura e não pagou já foi suspenso no dia
  // seguinte ao vencimento, e o lembrete só roda para conta ativa.
  const candidato = (dueAt: string, sent: number[] = []): ReminderCandidate => ({
    orgId: 'o',
    name: 'GoLink',
    billingPhone: '5512974074219',
    plan: 'Essencial',
    monthlyValue: 497,
    dueAt,
    status: 'active',
    sentSteps: sent as ReminderCandidate['sentSteps'],
  })

  it('vencimento numa quinta: o +3 cairia no domingo — sai na segunda (4º dia)', () => {
    // dueStep conta em UTC; às 10h de SP as datas coincidem.
    expect(dueStep(candidato(VENC_MEIO_DIA), sp('2026-10-05T10:00:00'))).toBe(3)
  })

  it('sai no 3º, 4º e 5º dia — mas uma vez só', () => {
    const c = candidato(VENC_MEIO_DIA)
    expect(dueStep(c, sp('2026-10-04T10:00:00'))).toBe(3)
    expect(dueStep(c, sp('2026-10-06T10:00:00'))).toBe(3)
    expect(dueStep(candidato(VENC_MEIO_DIA, [3]), sp('2026-10-05T10:00:00'))).toBeNull()
  })

  it('do 6º dia em diante o +3 não sai mais', () => {
    expect(dueStep(candidato(VENC_MEIO_DIA), sp('2026-10-07T10:00:00'))).toBeNull()
  })

  it('o 2º dia de atraso continua sem lembrete', () => {
    expect(dueStep(candidato(VENC_MEIO_DIA), sp('2026-10-03T10:00:00'))).toBeNull()
  })
})

describe('admin religou à mão: a trava respeita', () => {
  const venc01 = { tipo: 'vencida' as const, dueDate: '2026-10-01', invoiceUrl: null, paymentId: 'p1' }
  const quarta = sp('2026-10-07T15:00:00')

  it('a fatura que motivou a suspensão NÃO volta a suspender', () => {
    // Sem isto, o "Ligar" do /admin durava até a próxima hora.
    const r = decideComAsaas(venc01, quarta, '2026-10-07T14:00:00Z')
    expect(r.suspender).toBe(false)
  })

  it('uma fatura NOVA, de outro mês, volta a contar', () => {
    const venc01nov = { tipo: 'vencida' as const, dueDate: '2026-11-01', invoiceUrl: null, paymentId: 'p2' }
    const r = decideComAsaas(venc01nov, sp('2026-11-07T15:00:00'), '2026-10-07T14:00:00Z')
    expect(r.suspender).toBe(true)
  })
})

describe('o que o /admin grava quando o status muda', () => {
  const agora = new Date('2026-10-07T15:00:00Z')

  it('o Salvar que reenvia o MESMO status não mexe em nada', () => {
    // O editar cobrança manda o status em todo salvamento. Se isto gravasse
    // 'manual', apagaria o "Pagar agora" de quem a trava suspendeu.
    expect(camposAoMudarStatus({ status: 'suspended', suspendReason: 'inadimplencia' }, 'suspended', agora)).toEqual({})
    expect(camposAoMudarStatus({ status: 'active', suspendReason: null }, 'active', agora)).toEqual({})
  })

  it('desligar à mão: suspensão manual, sem botão de pagar', () => {
    expect(camposAoMudarStatus({ status: 'active', suspendReason: null }, 'suspended', agora)).toEqual({
      suspendedAt: agora.toISOString(),
      suspendReason: 'manual',
      suspendInvoiceUrl: null,
    })
  })

  it('religar quem a trava suspendeu deixa a marca da liberação', () => {
    expect(camposAoMudarStatus({ status: 'suspended', suspendReason: 'inadimplencia' }, 'active', agora)).toEqual({
      suspendedAt: agora.toISOString(),
      suspendReason: 'liberada_manual',
      suspendInvoiceUrl: null,
    })
  })

  it('religar uma suspensão manual limpa tudo', () => {
    expect(camposAoMudarStatus({ status: 'suspended', suspendReason: 'manual' }, 'active', agora)).toEqual({
      suspendedAt: null,
      suspendReason: null,
      suspendInvoiceUrl: null,
    })
  })
})

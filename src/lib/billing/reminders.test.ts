import { describe, expect, it } from 'vitest'

import {
  canSendNow,
  daysUntil,
  dueStep,
  reminderText,
  type ReminderCandidate,
} from './reminders'

// 25/09: o lembrete da mensalidade existia só no botão do /admin — alguém
// tinha que lembrar de clicar, cliente por cliente. Estas são as decisões que
// separam um lembrete útil de uma cobrança chata.

const base: ReminderCandidate = {
  orgId: 'org1',
  name: 'Limpeza com Zelo',
  billingPhone: '5511999999999',
  plan: 'Pro',
  monthlyValue: 1298.5,
  dueAt: '2026-10-04T12:00:00Z',
  status: 'active',
  sentSteps: [],
}

const em = (iso: string) => new Date(iso)

describe('qual degrau cabe hoje', () => {
  it('cinco dias antes', () => {
    expect(dueStep(base, em('2026-09-29T10:00:00Z'))).toBe(-5)
  })

  it('no dia do vencimento', () => {
    expect(dueStep(base, em('2026-10-04T10:00:00Z'))).toBe(0)
  })

  it('três dias depois de vencer', () => {
    expect(dueStep(base, em('2026-10-07T10:00:00Z'))).toBe(3)
  })

  it('nos outros dias não manda nada', () => {
    for (const dia of ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-10-20']) {
      expect(dueStep(base, em(`${dia}T10:00:00Z`))).toBeNull()
    }
  })
})

describe('nunca manda duas vezes a mesma coisa', () => {
  it('degrau já enviado não repete', () => {
    const c = { ...base, sentSteps: [-5] }
    expect(dueStep(c, em('2026-09-29T10:00:00Z'))).toBeNull()
  })

  it('mas o degrau seguinte ainda sai', () => {
    const c = { ...base, sentSteps: [-5] }
    expect(dueStep(c, em('2026-10-04T10:00:00Z'))).toBe(0)
  })

  it('degrau perdido NÃO acumula — não dispara junto com o seguinte', () => {
    // Conta cadastrada depois do dia -5: o de 5 dias antes simplesmente não
    // acontece, em vez de sair colado no do vencimento.
    const c = { ...base, sentSteps: [] }
    expect(dueStep(c, em('2026-10-04T10:00:00Z'))).toBe(0) // só o do dia
    expect(dueStep(c, em('2026-10-01T10:00:00Z'))).toBeNull()
  })
})

describe('quem fica de fora, e em silêncio', () => {
  it('sem telefone de cobrança', () => {
    expect(dueStep({ ...base, billingPhone: null }, em('2026-10-04T10:00:00Z'))).toBeNull()
    expect(dueStep({ ...base, billingPhone: '  ' }, em('2026-10-04T10:00:00Z'))).toBeNull()
  })

  it('sem data de vencimento', () => {
    expect(dueStep({ ...base, dueAt: null }, em('2026-10-04T10:00:00Z'))).toBeNull()
  })

  it('conta cancelada, suspensa ou em teste não recebe cobrança', () => {
    for (const status of ['canceled', 'suspended', 'trial', 'deleted']) {
      expect(dueStep({ ...base, status }, em('2026-10-04T10:00:00Z'))).toBeNull()
    }
  })
})

describe('horário: cobrança às 23h queima a marca', () => {
  // ⚠️ Todo horário aqui é escrito em UTC (com Z) de propósito. Antes era
  // "2026-09-29T09:00:00" sem fuso, que o Node lê na hora da MÁQUINA: no Mac
  // do Alex (UTC-4) o teste media uma coisa e no CI (UTC) mediria outra. Um
  // teste de fuso que depende do fuso de quem roda não testa nada.
  // São Paulo é UTC-3 o ano todo (o Brasil não tem mais horário de verão).
  const sp = (h: number, dia = 29) =>
    new Date(`2026-09-${dia}T${String(h + 3).padStart(2, '0')}:00:00Z`)

  it('manda em dia útil, no comercial', () => {
    expect(canSendNow(sp(9))).toBe(true) // terça, 9h em SP
    expect(canSendNow(new Date('2026-09-29T20:59:00Z'))).toBe(true) // 17:59 SP
  })

  it('não manda de madrugada nem fora do expediente', () => {
    expect(canSendNow(new Date('2026-09-29T11:59:00Z'))).toBe(false) // 8:59 SP
    expect(canSendNow(sp(18))).toBe(false)
    expect(canSendNow(new Date('2026-09-30T02:00:00Z'))).toBe(false) // 23h SP
  })

  it('o bug real: 9h UTC é 6h da manhã em Brasília', () => {
    // Foi o que aconteceu com a Appia em 29/09 — o worker roda em UTC e a
    // janela "9h às 18h" virava 6h às 15h de Brasília. Cliente acordado às
    // 6h por causa de boleto não esquece.
    expect(canSendNow(new Date('2026-09-29T09:00:00Z'))).toBe(false)
    // E o outro lado do mesmo bug: às 16h de SP ninguém recebia nada.
    expect(canSendNow(new Date('2026-09-29T19:00:00Z'))).toBe(true)
  })

  it('não manda no fim de semana', () => {
    expect(canSendNow(sp(10, 26))).toBe(false) // sábado
    expect(canSendNow(sp(10, 27))).toBe(false) // domingo
  })

  it('o fim de semana é o daqui, não o de Londres', () => {
    // Sábado 21h em SP já é domingo 00h em UTC; e sexta 22h em SP é sábado em
    // UTC — pela regra antiga isso bloqueava sexta e liberava sábado.
    expect(canSendNow(new Date('2026-09-26T00:30:00Z'))).toBe(false) // sex 21:30 SP
    expect(canSendNow(new Date('2026-09-28T13:00:00Z'))).toBe(true) // seg 10h SP
  })
})

describe('o texto de cada degrau', () => {
  it('antes do vencimento é aviso, não cobrança', () => {
    const t = reminderText(base, -5)
    expect(t).toContain('vence dia 04/10')
    expect(t).toContain('R$ 1.298,50')
    expect(t).not.toMatch(/atraso|inadimpl|bloque/i)
  })

  it('no dia dá saída pra quem já pagou', () => {
    expect(reminderText(base, 0)).toContain('já pagou, pode desconsiderar')
  })

  it('depois de vencer pergunta, não ameaça', () => {
    const t = reminderText(base, 3)
    expect(t).toContain('ainda está em aberto')
    expect(t).not.toMatch(/suspens|cortar|bloquear|negativ/i)
  })

  it('sem valor gravado, a mensagem não fica com buraco', () => {
    const t = reminderText({ ...base, monthlyValue: null }, 0)
    expect(t).not.toContain('undefined')
    expect(t).not.toContain('R$')
    expect(t).toContain('vence hoje')
  })
})

describe('daysUntil', () => {
  it('conta dias inteiros, sem se perder na hora do dia', () => {
    expect(daysUntil('2026-10-04T12:00:00Z', em('2026-10-04T23:00:00Z'))).toBe(0)
    expect(daysUntil('2026-10-04T12:00:00Z', em('2026-09-29T01:00:00Z'))).toBe(5)
    expect(daysUntil('2026-10-04T12:00:00Z', em('2026-10-07T22:00:00Z'))).toBe(-3)
  })
})

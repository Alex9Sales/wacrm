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
  it('manda em dia útil, no comercial', () => {
    expect(canSendNow(new Date('2026-09-29T09:00:00'))).toBe(true) // terça 9h
    expect(canSendNow(new Date('2026-09-29T17:59:00'))).toBe(true)
  })

  it('não manda de madrugada nem fora do expediente', () => {
    expect(canSendNow(new Date('2026-09-29T08:59:00'))).toBe(false)
    expect(canSendNow(new Date('2026-09-29T18:00:00'))).toBe(false)
    expect(canSendNow(new Date('2026-09-29T23:00:00'))).toBe(false)
  })

  it('não manda no fim de semana', () => {
    expect(canSendNow(new Date('2026-09-26T10:00:00'))).toBe(false) // sábado
    expect(canSendNow(new Date('2026-09-27T10:00:00'))).toBe(false) // domingo
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

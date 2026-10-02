import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

/**
 * 02/10 — a confirmação ao agendar foi para uma FILA (sai uns minutos depois
 * do último salvar, lib/agenda/confirmacao-fila.ts). O lembrete de consulta
 * não pode passar na frente dela: marcado hoje para amanhã cedo, o degrau
 * "24h antes" já está vencido, e sem esperar o paciente recebia o lembrete e,
 * minutos depois, a confirmação dizendo a mesma coisa.
 *
 * A varredura PULA o compromisso com confirmação recém-pendente — só enquanto
 * é recente (worker parado não segura lembrete para sempre) e sem queimar o
 * degrau: o filtro está no SELECT, então o compromisso nem chega ao carimbo.
 *
 * Banco falso: o 1º db.execute é a lista de agentes, o 2º é a fila de
 * compromissos (o que este teste lê). Ids fictícios; nenhum dado de paciente.
 */

const h = vi.hoisted(() => ({
  execute: vi.fn<(q: unknown) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })),
}))
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: { execute: h.execute } }
})
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => ({ businessHoursEnabled: false, businessTimezone: 'America/Sao_Paulo' }),
}))

import { SEM_CONFIRMACAO_NA_FILA, runMeetingReminderSweep } from './followup'

const dialect = new PgDialect()
const plano = (s: string) => s.replace(/\s+/g, ' ').trim()
const FILTRO = "(e.confirmation_due_at IS NULL OR e.confirmation_due_at < now() - interval '15 minutes')"

const AGENTE = {
  id: 'ag-0001',
  account_id: 'conta-0001',
  auto_reply_channel_ids: [],
  is_default: true,
  sole_active: true,
  follow_up: { enabled: true, meetingReminders: [{ when: 'before', offsetValue: 24, offsetUnit: 'hours' }] },
}

beforeEach(() => {
  h.execute.mockReset()
  h.execute.mockImplementationOnce(async () => ({ rows: [AGENTE] }))
  h.execute.mockImplementation(async () => ({ rows: [] }))
  // Meio-dia em São Paulo: fora da madrugada, a varredura roda.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('lembrete de consulta × confirmação na fila (02/10)', () => {
  it('o filtro: sem pendente, ou pendente há mais de 15 min (worker parado não segura para sempre)', () => {
    expect(plano(dialect.sqlToQuery(SEM_CONFIRMACAO_NA_FILA).sql)).toBe(FILTRO)
  })

  it('a fila de compromissos da varredura usa o filtro, no WHERE da consulta principal', async () => {
    await runMeetingReminderSweep()

    expect(h.execute).toHaveBeenCalledTimes(2)
    const q = plano(dialect.sqlToQuery(h.execute.mock.calls[1]?.[0] as SQL).sql)
    expect(q).toContain(`AND ${FILTRO}`)
    // Na consulta principal (depois do "reminders_sent < total" dela e antes
    // do ORDER BY), não na lista de cópias.
    const principal = q.indexOf('AND e.reminders_sent <')
    const ordem = q.indexOf('ORDER BY e.starts_at ASC')
    const filtro = q.indexOf(`AND ${FILTRO}`)
    expect(principal).toBeGreaterThan(0)
    expect(filtro).toBeGreaterThan(principal)
    expect(filtro).toBeLessThan(ordem)
  })

  it('pular não queima degrau: com a fila vazia (pendentes de fora), nenhum UPDATE', async () => {
    await runMeetingReminderSweep()

    const textos = h.execute.mock.calls.map((c) => plano(dialect.sqlToQuery(c[0] as SQL).sql))
    expect(textos.some((t) => /^UPDATE/i.test(t))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { formatBusySlot } from './busy-slots'
import { scheduleInstruction } from './defaults'

// 17/09 (Limpeza com Zelo): a Zélia agenda na agenda do CRM e precisa enxergar
// o que já está marcado pra não oferecer o mesmo horário duas vezes.
describe('horários ocupados na agenda', () => {
  it('formata no fuso da conta (UTC 17:00 = 14:00 em São Paulo)', () => {
    const s = formatBusySlot({ startsAt: '2026-09-23T17:00:00Z', endsAt: '2026-09-23T17:45:00Z' }, 'America/Sao_Paulo')
    expect(s).toMatch(/23\/09/)
    expect(s).toContain('14:00–14:45')
  })

  it('dia inteiro e fuso inválido não quebram', () => {
    expect(formatBusySlot({ startsAt: '2026-09-24T03:00:00Z', endsAt: '2026-09-25T03:00:00Z', allDay: true }, 'Nada/Isso')).toMatch(/dia todo/)
  })

  it('a instrução de agendar lista os ocupados; sem nenhum, diz que está livre; sem consulta, fica igual', () => {
    expect(scheduleInstruction({ busySlots: ['qua 23/09 14:00–14:45'] })).toContain('ALREADY BOOKED')
    expect(scheduleInstruction({ busySlots: ['qua 23/09 14:00–14:45'] })).toContain('qua 23/09 14:00–14:45')
    expect(scheduleInstruction({ busySlots: [] })).toContain('no booked appointments')
    expect(scheduleInstruction()).not.toContain('BOOKED')
  })
})

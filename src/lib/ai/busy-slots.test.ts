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

describe('clínica com vários profissionais: uma fonte de verdade só', () => {
  // 30/09, clínica da Dra. Joyce: ao ligar as 11 agendas dos profissionais, as
  // DUAS listas passaram a ir no mesmo prompt, dizendo o contrário uma da
  // outra. A lista única achatava os 10 dentistas, então o bloqueio de
  // expediente de um ("30/09 00:00–23:59", "06:15–23:00") virava "a clínica
  // está ocupada" — e a instrução manda nunca oferecer nada que bata com
  // aquilo. Obedecendo, não sobrava um horário livre em 14 dias e a IA diria
  // não para todo paciente.
  const BLOQUEIOS_DE_EXPEDIENTE = ['30/09 00:00–23:59', '30/09 06:15–23:00', '01/10 05:30–22:00']
  const POR_AGENDA = '- Dra. Bruna Diodatti — ocupado: qua 01/10 10:00–11:00\n- Dr. Lucas Pracchia — sem compromissos no período'

  it('com agendas por profissional, a lista única NÃO entra no prompt', () => {
    const txt = scheduleInstruction({ busySlots: BLOQUEIOS_DE_EXPEDIENTE, agendasDaEquipe: POR_AGENDA })
    expect(txt).not.toContain('ALREADY BOOKED')
    expect(txt).not.toContain('00:00–23:59')
    // O bloco por profissional é quem manda.
    expect(txt).toContain('SEVERAL CALENDARS')
    expect(txt).toContain('Dr. Lucas Pracchia')
  })

  it('sem agendas por profissional, a lista única continua valendo', () => {
    // Quem tem uma agenda só não pode perder a checagem de conflito.
    const txt = scheduleInstruction({ busySlots: ['qua 23/09 14:00–14:45'] })
    expect(txt).toContain('ALREADY BOOKED')
    expect(txt).toContain('qua 23/09 14:00–14:45')
  })

  it('as duas instruções nunca aparecem juntas', () => {
    // Uma diz "nunca ofereça o que bater com esta lista"; a outra diz "horário
    // ocupado numa agenda não bloqueia as outras". Juntas, o modelo escolhe uma.
    const txt = scheduleInstruction({ busySlots: BLOQUEIOS_DE_EXPEDIENTE, agendasDaEquipe: POR_AGENDA })
    const temListaUnica = txt.includes('ALREADY BOOKED')
    const temPorAgenda = txt.includes('SEVERAL CALENDARS')
    expect(temListaUnica && temPorAgenda).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import {
  avisoDeLembreteNaGrade,
  classeDoDesmarcado,
  contarDesmarcados,
  tooltipComStatus,
  visivelNaGrade,
} from './agenda-desmarcados'

// 02/10 — a linha cancelada pelo sync (evento movido de agenda no Google)
// aparecia ao lado da consulta de verdade e a dona achou que a agenda
// duplicava. Ids fictícios.

const DE_PE = { status: 'confirmed', calendarId: 'cal-a', reminderBlock: 'sem_conversa' as const }
const DESMARCADO = { status: 'cancelled', calendarId: 'cal-a', reminderBlock: 'sem_conversa' as const }

describe('desmarcados na grade', () => {
  it('escondidos por padrão; aparecem com "Mostrar desmarcados"', () => {
    expect(visivelNaGrade(DESMARCADO, false)).toBe(false)
    expect(visivelNaGrade(DESMARCADO, true)).toBe(true)
    expect(visivelNaGrade(DE_PE, false)).toBe(true)
    expect(visivelNaGrade(DE_PE, true)).toBe(true)
  })

  it('a contagem do controle respeita o filtro de agenda', () => {
    const evs = [DESMARCADO, { ...DESMARCADO, calendarId: 'cal-b' }, DE_PE]
    expect(contarDesmarcados(evs, null)).toBe(2)
    expect(contarDesmarcados(evs, 'cal-b')).toBe(1)
    expect(contarDesmarcados([DE_PE], null)).toBe(0)
  })

  it('mostrado: riscado, esmaecido e "Desmarcado" no tooltip', () => {
    expect(classeDoDesmarcado(DESMARCADO)).toContain('line-through')
    expect(classeDoDesmarcado(DESMARCADO)).toContain('opacity-50')
    expect(tooltipComStatus(DESMARCADO, 'Consulta — Ana')).toBe('Desmarcado — Consulta — Ana')
  })

  it('o de pé fica como sempre foi', () => {
    expect(classeDoDesmarcado(DE_PE)).toBe('')
    expect(tooltipComStatus(DE_PE, 'Consulta — Ana')).toBe('Consulta — Ana')
  })

  it('desmarcado não acende o aviso de lembrete travado (não recebe lembrete nenhum)', () => {
    expect(avisoDeLembreteNaGrade(DESMARCADO)).toBeNull()
    expect(avisoDeLembreteNaGrade(DE_PE)).toBe('sem_conversa')
  })
})

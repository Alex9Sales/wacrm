import { describe, it, expect } from 'vitest'
import { delayMsOf, stepTimingIssues } from './step-timing'

const d = (delayValue: number, delayUnit = 'days') => ({ delayValue, delayUnit })

describe('stepTimingIssues', () => {
  it('cadência bem montada não tem aviso', () => {
    expect(stepTimingIssues([d(0), d(2), d(4), d(7), d(10)]).every((x) => !x.sameTimeAs.length && x.before === null)).toBe(true)
  })

  it('4 toques em +2 dias saem juntos (montada como "2 dias depois do anterior")', () => {
    const issues = stepTimingIssues([d(0), d(2), d(2), d(2), d(2), d(4), d(5), d(7)])
    expect(issues[1].sameTimeAs).toEqual([2, 3, 4])
    expect(issues[4].sameTimeAs).toEqual([1, 2, 3])
    expect(issues[0].sameTimeAs).toEqual([])
    expect(issues[5].sameTimeAs).toEqual([])
  })

  it('toque com tempo menor que um anterior sai antes dele', () => {
    const issues = stepTimingIssues([d(0), d(3), d(2)])
    expect(issues[2].before).toBe(1)
    expect(issues[1].before).toBeNull()
  })

  it('unidades diferentes no mesmo horário também avisam (48 h = 2 dias)', () => {
    expect(stepTimingIssues([d(0), d(48, 'hours'), d(2)])[1].sameTimeAs).toEqual([2])
    expect(delayMsOf(90, 'minutes')).toBe(90 * 60_000)
  })
})

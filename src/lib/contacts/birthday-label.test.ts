import { describe, expect, it } from 'vitest'

import { normalizeBirthday } from './birthday'
import { birthdayAge, birthdayLabel, isBirthdayToday } from './birthday-label'

describe('aniversário na tela', () => {
  it('com ano mostra a data inteira; sem ano mostra só dia e mês', () => {
    expect(birthdayLabel('1980-02-28')).toBe('28/02/1980')
    expect(birthdayLabel('1900-05-18')).toBe('18/05')
  })

  it('vazio ou lixo não vira rótulo', () => {
    expect(birthdayLabel(null)).toBeNull()
    expect(birthdayLabel('')).toBeNull()
    expect(birthdayLabel('18/05')).toBeNull()
  })

  it('idade só quando o ano é conhecido', () => {
    const hoje = new Date('2026-09-23T12:00:00Z')
    expect(birthdayAge('1980-02-28', hoje)).toBe(46)
    // Aniversário ainda não chegou este ano.
    expect(birthdayAge('1980-12-31', hoje)).toBe(45)
    expect(birthdayAge('1900-05-18', hoje)).toBeNull()
    expect(birthdayAge(null, hoje)).toBeNull()
  })

  it('é hoje? compara só dia e mês', () => {
    const hoje = new Date('2026-09-23T12:00:00Z')
    expect(isBirthdayToday('1975-09-23', hoje)).toBe(true)
    expect(isBirthdayToday('1900-09-23', hoje)).toBe(true)
    expect(isBirthdayToday('1975-09-24', hoje)).toBe(false)
    expect(isBirthdayToday(null, hoje)).toBe(false)
  })
})

describe('ida e volta do campo — o que o atendente digita volta igual na tela', () => {
  it('só dia e mês, que é o que o cliente costuma dizer', () => {
    const salvo = normalizeBirthday('18/05')
    expect(salvo).toBe('1900-05-18')
    expect(birthdayLabel(salvo)).toBe('18/05')
  })

  it('data completa mantém o ano', () => {
    const salvo = normalizeBirthday('28/02/1980')
    expect(salvo).toBe('1980-02-28')
    expect(birthdayLabel(salvo)).toBe('28/02/1980')
  })

  it('o que a tela mostra pode ser salvo de novo sem virar outra data', () => {
    for (const escrito of ['18/05', '28/02/1980', '1/1/2000']) {
      const salvo = normalizeBirthday(escrito)
      expect(normalizeBirthday(birthdayLabel(salvo))).toBe(salvo)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { firstNameForGreeting, greeting } from './names'

describe('firstNameForGreeting', () => {
  it('takes the first word of a person name', () => {
    expect(firstNameForGreeting('Maria Silva')).toBe('Maria')
    expect(firstNameForGreeting('  joão pedro ')).toBe('João')
  })

  it('keeps the title with the name, never alone', () => {
    expect(firstNameForGreeting('Dr. João Silva')).toBe('Dr. João')
    expect(firstNameForGreeting('dra ana')).toBe('Dra. Ana')
    expect(firstNameForGreeting('Sr. Carlos')).toBe('Sr. Carlos')
    expect(firstNameForGreeting('Dr.')).toBe('')
    expect(firstNameForGreeting('Dr. Clínica Sorriso')).toBe('')
  })

  it('rejects numbers, emoji-only, business words and short acronyms', () => {
    expect(firstNameForGreeting('+55 12 99123-4567')).toBe('')
    expect(firstNameForGreeting('💎')).toBe('')
    expect(firstNameForGreeting('💎 Carla')).toBe('Carla')
    expect(firstNameForGreeting('Google Ads')).toBe('')
    expect(firstNameForGreeting('Sta Casa Taubaté')).toBe('')
    expect(firstNameForGreeting('Clínica Bem Estar')).toBe('')
    expect(firstNameForGreeting('JMJ Materiais')).toBe('')
    expect(firstNameForGreeting('JR')).toBe('')
  })

  it('tames a shouted name — including short ones (ANA, BIA, ZÉ)', () => {
    expect(firstNameForGreeting('FERNANDO LIMA')).toBe('Fernando')
    expect(firstNameForGreeting('ANA SOUZA')).toBe('Ana')
    expect(firstNameForGreeting('BIA')).toBe('Bia')
    expect(firstNameForGreeting('ZÉ CARLOS')).toBe('Zé')
    expect(firstNameForGreeting('LÉO')).toBe('Léo')
    expect(firstNameForGreeting('Sra. ANA')).toBe('Sra. Ana')
    expect(firstNameForGreeting('ANA-CLARA LIMA')).toBe('Ana-Clara')
    // sigla continua fora: sem vogal no começo, ou gritando no meio de nome misto
    expect(firstNameForGreeting('MCE Engenharia')).toBe('')
    expect(firstNameForGreeting('RA Cosméticos')).toBe('')
    expect(firstNameForGreeting('SBC')).toBe('')
  })

  it('keeps accents, hyphens and apostrophes', () => {
    expect(firstNameForGreeting('João Silva'.normalize('NFD'))).toBe('João')
    expect(firstNameForGreeting('Ana-Clara Souza')).toBe('Ana-Clara')
    expect(firstNameForGreeting('D’Ávila Souza')).toBe('D’Ávila')
    expect(firstNameForGreeting('João - Financeiro')).toBe('João')
  })
})

describe('greeting', () => {
  it('says the name when there is one, plain "Oi!" otherwise', () => {
    expect(greeting('Dra. Ana Lima')).toBe('Oi Dra. Ana!')
    expect(greeting('Loja do Zé')).toBe('Oi!')
    expect(greeting(null)).toBe('Oi!')
  })
})

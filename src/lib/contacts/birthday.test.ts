import { describe, expect, it } from 'vitest'

import { normalizeBirthday } from './birthday'
import { parseContactCsv } from './parse-contact-csv'

describe('normalizeBirthday', () => {
  it('aceita ISO, BR com ano de 4 e 2 dígitos, e só dia/mês', () => {
    expect(normalizeBirthday('2026-05-18')).toBe('2026-05-18')
    expect(normalizeBirthday('18/05/1990')).toBe('1990-05-18')
    expect(normalizeBirthday('18/05/90')).toBe('1990-05-18')
    expect(normalizeBirthday('18/05/05')).toBe('2005-05-18')
    expect(normalizeBirthday('18/05')).toBe('1900-05-18')
    expect(normalizeBirthday('05.09.1988')).toBe('1988-09-05')
  })

  it('rejeita lixo, datas impossíveis e vazio', () => {
    expect(normalizeBirthday('')).toBeNull()
    expect(normalizeBirthday(null)).toBeNull()
    expect(normalizeBirthday(undefined)).toBeNull()
    expect(normalizeBirthday('31/02/2000')).toBeNull()
    expect(normalizeBirthday('abc')).toBeNull()
    expect(normalizeBirthday('1800-01-01')).toBeNull()
  })
})

describe('parseContactCsv — coluna de aniversário', () => {
  it('lê "aniversário" da planilha e sinaliza a coluna', () => {
    const csv = 'nome,telefone,aniversário\nMaria,+55 67 99999-0001,18/05/1990\nJoão,+55 67 99999-0002,'
    const r = parseContactCsv(csv)
    expect(r.hasBirthdayColumn).toBe(true)
    expect(r.rows[0]?.birthday).toBe('18/05/1990')
    expect(r.rows[1]?.birthday).toBeUndefined()
  })

  it('sem a coluna, hasBirthdayColumn é false', () => {
    const r = parseContactCsv('nome,telefone\nMaria,+55 67 99999-0001')
    expect(r.hasBirthdayColumn).toBe(false)
    expect(r.rows[0]?.birthday).toBeUndefined()
  })
})

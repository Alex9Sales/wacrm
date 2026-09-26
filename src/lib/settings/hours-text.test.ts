import { describe, expect, it } from 'vitest'
import { businessHoursText } from './hours-text'
import type { BusinessDay } from './account-settings'

const fechado: BusinessDay = { open: null, close: null }
const dia = (open: string, close: string): BusinessDay => ({ open, close })

/** Monta a semana com índice 0 = domingo, como em `businessDays`. */
function semana(map: Partial<Record<number, BusinessDay>>): BusinessDay[] {
  return Array.from({ length: 7 }, (_, i) => map[i] ?? fechado)
}

describe('o caso real da Família do Gás', () => {
  it('seg–sáb 7h–20h e domingo 8h–14h', () => {
    const s = semana({
      1: dia('07:00', '20:00'),
      2: dia('07:00', '20:00'),
      3: dia('07:00', '20:00'),
      4: dia('07:00', '20:00'),
      5: dia('07:00', '20:00'),
      6: dia('07:00', '20:00'),
      0: dia('08:00', '14:00'),
    })
    expect(businessHoursText(s)).toBe(
      'Segunda a sábado das 7h às 20h, domingo das 8h às 14h',
    )
  })

  it('minuto quebrado aparece — 20:30 vira 20h30', () => {
    const s = semana({ 1: dia('07:00', '20:30'), 2: dia('07:00', '20:30') })
    expect(businessHoursText(s)).toBe('Segunda a terça das 7h às 20h30')
  })
})

describe('agrupa só dias SEGUIDOS de mesmo horário', () => {
  it('buraco no meio da semana quebra o bloco', () => {
    // Fecha na quarta: não pode virar "segunda a sexta".
    const s = semana({
      1: dia('08:00', '18:00'),
      2: dia('08:00', '18:00'),
      4: dia('08:00', '18:00'),
      5: dia('08:00', '18:00'),
    })
    expect(businessHoursText(s)).toBe(
      'Segunda a terça das 8h às 18h, quinta a sexta das 8h às 18h',
    )
  })

  it('horário diferente no sábado vira bloco próprio', () => {
    const s = semana({
      1: dia('08:00', '18:00'),
      2: dia('08:00', '18:00'),
      3: dia('08:00', '18:00'),
      4: dia('08:00', '18:00'),
      5: dia('08:00', '18:00'),
      6: dia('08:00', '12:00'),
    })
    expect(businessHoursText(s)).toBe(
      'Segunda a sexta das 8h às 18h, sábado das 8h às 12h',
    )
  })

  it('um dia só não vira intervalo', () => {
    expect(businessHoursText(semana({ 3: dia('09:00', '17:00') }))).toBe(
      'Quarta das 9h às 17h',
    )
  })
})

describe('não inventa horário', () => {
  it('semana toda fechada devolve null, não "nunca abre"', () => {
    // Quem chama cai no texto do perfil — melhor nada do que afirmar que a
    // empresa não atende.
    expect(businessHoursText(semana({}))).toBeNull()
  })

  it('lista vazia ou ausente devolve null', () => {
    expect(businessHoursText([])).toBeNull()
    expect(businessHoursText(null)).toBeNull()
    expect(businessHoursText(undefined)).toBeNull()
  })

  it('dia pela metade (só abertura) não conta como aberto', () => {
    expect(businessHoursText(semana({ 1: { open: '08:00', close: null } }))).toBeNull()
  })
})

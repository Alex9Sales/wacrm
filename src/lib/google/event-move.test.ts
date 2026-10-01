import { describe, expect, it } from 'vitest'
import { planoDaEdicao } from './event-move'

// 01/10 — trocar de agenda deixava o evento antigo no Google, e o import o
// trazia de volta como um compromisso fantasma (agora com o telefone do paciente).

const GOOGLE_A = { calendarId: 'cal-a', googleEventId: 'g-1', google: true }

describe('salvar sem trocar de agenda', () => {
  it('segue como sempre: só espelha a edição', () => {
    const esperado = { trocou: false, apagarNaAntiga: false, pushDepois: 'update' }
    expect(planoDaEdicao(GOOGLE_A, null)).toEqual(esperado)
    // O modal manda a MESMA agenda em todo salvamento.
    expect(planoDaEdicao(GOOGLE_A, { calendarId: 'cal-a', google: true })).toEqual(esperado)
  })
})

describe('trocar de agenda', () => {
  it('Google → Google: apaga na antiga e cria na nova', () => {
    expect(planoDaEdicao(GOOGLE_A, { calendarId: 'cal-b', google: true })).toEqual({
      trocou: true,
      apagarNaAntiga: true,
      pushDepois: 'create',
    })
  })

  it('Google → local: só apaga na antiga', () => {
    expect(planoDaEdicao(GOOGLE_A, { calendarId: 'cal-local', google: false })).toEqual({
      trocou: true,
      apagarNaAntiga: true,
      pushDepois: null,
    })
  })

  it('local → Google: nada a apagar, cria na nova', () => {
    const local = { calendarId: 'cal-local', googleEventId: null, google: false }
    expect(planoDaEdicao(local, { calendarId: 'cal-b', google: true })).toEqual({
      trocou: true,
      apagarNaAntiga: false,
      pushDepois: 'create',
    })
  })

  it('evento que nunca chegou ao Google antigo: nada a apagar', () => {
    const semId = { ...GOOGLE_A, googleEventId: null }
    expect(planoDaEdicao(semId, { calendarId: 'cal-b', google: true }).apagarNaAntiga).toBe(false)
  })

  it('agenda antiga desconectada do Google: não há com o que apagar', () => {
    const desconectada = { ...GOOGLE_A, google: false }
    expect(planoDaEdicao(desconectada, { calendarId: 'cal-b', google: true }).apagarNaAntiga).toBe(false)
  })
})

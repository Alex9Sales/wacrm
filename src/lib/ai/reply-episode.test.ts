import { describe, expect, it } from 'vitest'

import { EPISODE_GAP_HOURS, isNewEpisode } from './reply-episode'

const agora = new Date('2026-09-05T08:26:41-03:00')
const horasAtras = (h: number) => new Date(agora.getTime() - h * 3_600_000)

describe('isNewEpisode — o teto vale por episódio, não por vida da conversa', () => {
  it('IA calada há mais que a janela = pedido novo, contador zera', () => {
    expect(isNewEpisode(horasAtras(5), agora)).toBe(true)
  })

  it('IA falou há pouco = mesmo episódio, contador continua', () => {
    // Caso Poliana: a IA respondeu às 08:26:34 e o "Sim" chegou 08:26:41.
    expect(isNewEpisode(horasAtras(0.002), agora)).toBe(false)
  })

  it('exatamente na janela já conta como novo', () => {
    expect(isNewEpisode(horasAtras(EPISODE_GAP_HOURS), agora)).toBe(true)
  })

  it('um pouco antes da janela ainda é o mesmo', () => {
    expect(isNewEpisode(horasAtras(EPISODE_GAP_HOURS - 0.1), agora)).toBe(false)
  })

  it('nunca falou nesta conversa = episódio novo', () => {
    expect(isNewEpisode(null, agora)).toBe(true)
  })

  it('data inválida não trava a IA — trata como novo', () => {
    expect(isNewEpisode('não é data', agora)).toBe(true)
  })

  it('aceita string ISO e Date', () => {
    expect(isNewEpisode(horasAtras(6).toISOString(), agora)).toBe(true)
    expect(isNewEpisode(horasAtras(6), agora)).toBe(true)
  })

  it('a janela padrão é de horas, não de dias — cliente de gás pede de manhã e à noite', () => {
    // Pediu de manhã (IA falou 08h), volta à noite (20h): tem que ser novo.
    expect(EPISODE_GAP_HOURS).toBeLessThanOrEqual(12)
    expect(isNewEpisode(horasAtras(12), agora)).toBe(true)
  })
})

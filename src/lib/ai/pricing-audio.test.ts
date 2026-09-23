import { describe, expect, it } from 'vitest'

import { audioCostUsd, lineCostUsd } from './pricing'

const SEM_TOKENS = { promptTokens: 0, completionTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 }

describe('custo da transcrição — cobrada por minuto, não por token', () => {
  it('um minuto de Whisper custa o preço de tabela', () => {
    expect(audioCostUsd('whisper-1', 60)).toBeCloseTo(0.006, 6)
    expect(audioCostUsd('whisper-1', 30)).toBeCloseTo(0.003, 6)
  })

  it('áudio zerado, negativo ou lixo não vira custo', () => {
    expect(audioCostUsd('whisper-1', 0)).toBe(0)
    expect(audioCostUsd('whisper-1', -10)).toBe(0)
    expect(audioCostUsd('whisper-1', Number.NaN)).toBe(0)
  })

  it('modelo de áudio desconhecido cobra como Whisper — despesa nunca some', () => {
    expect(audioCostUsd('modelo-novo-de-audio', 60)).toBeCloseTo(0.006, 6)
  })

  it('lineCostUsd soma token e áudio: a linha de transcrição não tem token, a de texto não tem áudio', () => {
    const transcricao = lineCostUsd('whisper-1', { ...SEM_TOKENS, audioSeconds: 120 })
    expect(transcricao).toBeCloseTo(0.012, 6)
    const texto = lineCostUsd('gpt-4o-mini', {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
    })
    expect(texto).toBeCloseTo(0.15, 6)
    // Sem áudio informado, o custo é exatamente o dos tokens.
    expect(lineCostUsd('gpt-4o-mini', { ...SEM_TOKENS })).toBe(0)
  })
})

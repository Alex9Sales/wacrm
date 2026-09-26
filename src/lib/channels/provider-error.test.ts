import { describe, expect, it } from 'vitest'
import {
  OUTSIDE_WINDOW_MESSAGE,
  humanProviderError,
  isOutsideWindowError,
} from './provider-error'

// 25/09 — o erro que o Alex viu na tela, inteiro, como chegou:
const ERRO_REAL =
  'instagram send falhou: 403 Essa mensagem foi enviada fora do período permitido.'

describe('a janela de 24h ganha nome próprio', () => {
  it('reconhece o erro real do Instagram', () => {
    expect(isOutsideWindowError(ERRO_REAL)).toBe(true)
    expect(humanProviderError(ERRO_REAL)).toBe(OUTSIDE_WINDOW_MESSAGE)
  })

  it('reconhece a versão em inglês e o código (#10) da Meta', () => {
    expect(isOutsideWindowError('(#10) Message sent outside the allowed window')).toBe(true)
    expect(isOutsideWindowError('403 outside of the allowed window')).toBe(true)
  })

  it('não confunde com outro 403', () => {
    expect(isOutsideWindowError('403 Token inválido')).toBe(false)
  })
})

describe('tira os prefixos dos adaptadores', () => {
  it('sobra o que a Meta escreveu, sem "instagram send falhou: 403"', () => {
    expect(humanProviderError('instagram send falhou: 403 Token inválido')).toBe(
      'Token inválido',
    )
  })

  it('erro sem código HTTP passa inteiro — não há o que cortar', () => {
    expect(humanProviderError('rede indisponível')).toBe('rede indisponível')
  })

  it('nunca devolve vazio', () => {
    // O corte não pode engolir a mensagem toda e deixar o atendente sem nada.
    expect(humanProviderError('500 ')).toBe('500')
    expect(humanProviderError('')).toMatch(/não disse o motivo/)
  })

  it('número que NÃO é código HTTP não vira corte', () => {
    expect(humanProviderError('falha ao reagir na mensagem 123 do cliente')).toBe(
      'falha ao reagir na mensagem 123 do cliente',
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  IG_ONLY_HEART_MESSAGE,
  OUTSIDE_WINDOW_MESSAGE,
  PROVIDER_FLAKY_MESSAGE,
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

describe('os dois erros que o Alex viu testando no Instagram', () => {
  it('👍 → "Reação inválida" vira a explicação do coração', () => {
    expect(
      humanProviderError('instagram send falhou: 400 Reação inválida.'),
    ).toBe(IG_ONLY_HEART_MESSAGE)
  })

  it('500 da Meta não vira culpa do atendente', () => {
    expect(
      humanProviderError(
        'instagram send falhou: 500 An unexpected error has occurred. Please retry your request later.',
      ),
    ).toBe(PROVIDER_FLAKY_MESSAGE)
  })

  it('a janela de 24h ganha prioridade sobre o código HTTP', () => {
    // 403 casaria com nada, mas o texto é o que manda.
    expect(humanProviderError(ERRO_REAL)).toBe(OUTSIDE_WINDOW_MESSAGE)
  })
})

describe('o detalhe técnico fica no log, não na tela', () => {
  // 26/09: o adaptador passou a anexar code/subcode/fbtrace_id para abrir
  // chamado com a Meta. O atendente não tem o que fazer com isso.
  it('corta o bloco [code=… fbtrace_id=…] do fim', () => {
    expect(
      humanProviderError(
        'instagram send falhou: 400 Token inválido [code=190 fbtrace_id=Abc123]',
      ),
    ).toBe('Token inválido')
  })

  it('o 500 com fbtrace ainda cai na frase de erro interno', () => {
    expect(
      humanProviderError(
        'instagram send falhou: 500 An unexpected error has occurred. [code=-1 fbtrace_id=Xyz]',
      ),
    ).toBe(PROVIDER_FLAKY_MESSAGE)
  })

  it('colchete no MEIO do texto não é cortado', () => {
    expect(humanProviderError('erro no campo [nome] do cadastro')).toBe(
      'erro no campo [nome] do cadastro',
    )
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
    expect(humanProviderError('404 ')).toBe('404')
    expect(humanProviderError('')).toMatch(/não disse o motivo/)
  })

  it('número 5xx no MEIO do texto não vira "erro interno"', () => {
    // A primeira versão da regra casava `\b5\d{2}\b` em qualquer lugar.
    expect(humanProviderError('o pedido 500 não foi encontrado')).toBe(
      'o pedido 500 não foi encontrado',
    )
  })

  it('número que NÃO é código HTTP não vira corte', () => {
    expect(humanProviderError('falha ao reagir na mensagem 123 do cliente')).toBe(
      'falha ao reagir na mensagem 123 do cliente',
    )
  })
})

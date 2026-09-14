import { describe, expect, it } from 'vitest'

import { RETRY_AFTER_FAILURE_MS, deliveredEchoSnippet, retryCutoffIso } from './rules'

// 14/09 (A.M Carretos/GoLink): o WAHA devolveu erro mas entregou, e o reenvio do
// minuto seguinte deu ao devedor a mesma cobrança duas vezes.
describe('retryCutoffIso — pedido que falhou sai da vez por 3 minutos', () => {
  const falhou = '2026-09-14T13:09:03.000Z'
  const t = Date.parse(falhou)
  // Mesma regra do filtro SQL do sender: volta à fila quando lastAttemptAt <= corte.
  const voltaAFila = (agoraMs: number) => Date.parse(falhou) <= Date.parse(retryCutoffIso(agoraMs))

  it('no minuto seguinte à falha (quando o reenvio duplicou) ainda está fora da vez', () => {
    expect(voltaAFila(t + 60_000)).toBe(false)
  })

  it('passados 3 minutos volta, para conferir o eco antes de reenviar', () => {
    expect(voltaAFila(t + RETRY_AFTER_FAILURE_MS)).toBe(true)
    expect(voltaAFila(t + 10 * 60_000)).toBe(true)
  })

  it('o corte é um ISO que o banco entende', () => {
    expect(retryCutoffIso(t + RETRY_AFTER_FAILURE_MS)).toBe(falhou)
  })
})

describe('deliveredEchoSnippet', () => {
  const rascunho =
    'A.M Carretos, identificamos uma parcela vencida em 10/09/2026, com 4 dias de atraso.\n\nSe já pagou, é só responder por aqui.'

  it('pega o começo do rascunho com espaços normalizados', () => {
    const s = deliveredEchoSnippet(rascunho)!
    expect(s.startsWith('A.M Carretos, identificamos uma parcela vencida')).toBe(true)
    expect(Array.from(s).length).toBeLessThanOrEqual(80)
    expect(s).not.toMatch(/\n/)
  })

  it('casa com a mensagem enviada mesmo com a assinatura na frente', () => {
    const enviada = `*João:*\n${rascunho}`.replace(/\s+/g, ' ')
    expect(enviada.includes(deliveredEchoSnippet(rascunho)!)).toBe(true)
  })

  it('texto curto não serve de prova', () => {
    expect(deliveredEchoSnippet('Bom dia!')).toBeNull()
    expect(deliveredEchoSnippet('')).toBeNull()
    expect(deliveredEchoSnippet(null)).toBeNull()
  })

  it('não parte emoji ao meio no corte', () => {
    const comEmoji = `${'x'.repeat(79)}🙏 e mais um pouco de texto aqui`
    const s = deliveredEchoSnippet(comEmoji)!
    expect(s.endsWith('🙏')).toBe(true)
    expect(s).not.toMatch(/�/)
  })
})

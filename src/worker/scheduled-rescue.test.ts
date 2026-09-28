import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A varredura que resgata agendada pendente SEM job (28/09).
 *
 * O worker só trabalha por job: linha `pending` sem job não é enviada por
 * ninguém e não gera erro — some em silêncio. A API pública gravava e não
 * enfileirava, e 296 mensagens de um cliente ficaram assim. O bug foi
 * corrigido na origem; esta varredura é a rede por baixo, porque o mesmo
 * buraco se abre com Redis limpo, job perdido em restart, ou qualquer caminho
 * novo que esqueça de enfileirar.
 *
 * Testa o código porque o que importa aqui são as JANELAS e a idempotência —
 * escolhas que um mock de banco não preservaria.
 */
const fonte = readFileSync(
  join(process.cwd(), 'src/worker/scheduled-message-worker.ts'),
  'utf8',
)

describe('resgate de agendadas órfãs', () => {
  it('só olha o que está pendente', () => {
    const i = fonte.indexOf('rescueOrphanScheduledMessages')
    const bloco = fonte.slice(i, i + 1800)
    expect(bloco).toMatch(/eq\(scheduledMessages\.status, 'pending'\)/)
  })

  it('não ressuscita mensagem velha — janela de atraso limitada', () => {
    // Entregar 2h atrasado ainda faz sentido; 3 dias depois seria mensagem
    // fora de hora chegando do nada no cliente.
    expect(fonte).toMatch(/scheduledAt\} > now\(\) - interval '2 hours'/)
  })

  it('pega o que vence antes do próximo tick, não a agenda inteira', () => {
    expect(fonte).toMatch(/scheduledAt\} <= now\(\) \+ interval '10 minutes'/)
    expect(fonte).toMatch(/RESCUE_EVERY_MS\s*=\s*5 \* 60_000/)
  })

  it('respeita o horário marcado em vez de disparar tudo na hora', () => {
    const i = fonte.indexOf('rescueOrphanScheduledMessages')
    const bloco = fonte.slice(i, i + 1800)
    expect(bloco).toMatch(/delayMs\s*=\s*Math\.max\(\s*0,/)
    expect(bloco).toMatch(/enqueueScheduledMessage\(r\.id, \{ delayMs \}\)/)
  })

  it('uma falha não derruba o resgate das outras', () => {
    const i = fonte.indexOf('for (const r of rows)')
    const bloco = fonte.slice(i, i + 500)
    expect(bloco).toMatch(/try/)
    expect(bloco).toMatch(/catch/)
  })

  it('roda no start e em intervalo, sem segurar o desligamento', () => {
    expect(fonte).toMatch(/void rescueOrphanScheduledMessages\(\)/)
    expect(fonte).toMatch(/setInterval\([\s\S]*?RESCUE_EVERY_MS\)\.unref\(\)/)
  })

  it('tem teto por rodada — não enfileira a base inteira num tick', () => {
    const i = fonte.indexOf('rescueOrphanScheduledMessages')
    expect(fonte.slice(i, i + 1800)).toMatch(/\.limit\(200\)/)
  })
})

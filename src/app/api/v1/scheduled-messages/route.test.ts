import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Agendar pela API tem de ENFILEIRAR, não só gravar.
 *
 * O worker de agendadas trabalha por job e não varre pendentes: linha sem job
 * fica `pending` para sempre. A tela sempre enfileirou; esta rota, não — então
 * tudo que o cliente agendava pela API aparecia na Central de Agendamentos e
 * nunca saía (Rafael Odonto, 28/09: 13 presas, 8 já vencidas).
 *
 * O teste é sobre o código porque o buraco era uma AUSÊNCIA de chamada: um
 * teste de comportamento com tudo mockado passaria feliz sem a fila.
 */
const fonte = readFileSync(
  join(process.cwd(), 'src/app/api/v1/scheduled-messages/route.ts'),
  'utf8',
)

describe('POST /api/v1/scheduled-messages', () => {
  it('enfileira o job depois de gravar', () => {
    expect(fonte).toMatch(/enqueueScheduledMessage\s*\(/)
    expect(fonte).toMatch(/import\s*\{\s*enqueueScheduledMessage\s*\}/)
  })

  it('passa o atraso até o horário marcado, senão sairia na hora', () => {
    expect(fonte).toMatch(/delayMs:\s*when\.getTime\(\)\s*-\s*Date\.now\(\)/)
  })

  it('apaga a linha se a fila recusar — nada de pendente órfão', () => {
    const i = fonte.indexOf('enqueueScheduledMessage(')
    const bloco = fonte.slice(i, i + 700)
    expect(bloco).toMatch(/catch/)
    expect(bloco).toMatch(/delete\(scheduledMessages\)/)
  })

  it('enfileira ANTES de responder 201, para o cliente não receber falso ok', () => {
    const iFila = fonte.indexOf('enqueueScheduledMessage(')
    const iResposta = fonte.indexOf('scheduled_at: when.toISOString()')
    expect(iFila).toBeGreaterThan(0)
    expect(iResposta).toBeGreaterThan(iFila)
  })
})

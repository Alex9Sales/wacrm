import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { MEETING_QUEUE_ORDER, sqlCarimboDoAtendimento } from './followup'

/**
 * 01/10: o carimbo do degrau é gravado no ATENDIMENTO (o compromisso e as
 * cópias dele em outras agendas) no mesmo instante em que o lembrete sai.
 * Antes a cópia só carimbava na varredura seguinte; se o canônico fosse
 * cancelado nesse minuto, ela virava canônica e repetia o degrau.
 *
 * Teste de texto de propósito: o que importa aqui é a forma do UPDATE (o que
 * ele toca e o que ele NÃO toca), e não há banco no teste. Ids fictícios.
 */
const dialect = new PgDialect()
const plano = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('carimbo do degrau no atendimento inteiro', () => {
  const q = dialect.sqlToQuery(sqlCarimboDoAtendimento('conta-0001', 'evt-canonico', 2))
  const texto = plano(q.sql)

  it('só anda para frente e limpa o motivo de todos', () => {
    expect(texto).toContain('SET reminders_sent = GREATEST(d.reminders_sent, $1)')
    expect(texto).toContain('reminder_block = NULL')
    expect(texto).toContain('reminder_block_at = NULL')
  })

  it('pega o próprio compromisso e as cópias: mesmo contato, mesmo instante, confirmadas', () => {
    expect(texto).toContain('d.id = e.id')
    expect(texto).toContain('d.contact_id = e.contact_id')
    expect(texto).toContain('d.starts_at = e.starts_at')
    expect(texto).toContain("d.status = 'confirmed'")
  })

  it('nunca sai da conta do compromisso', () => {
    expect(texto).toContain('e.account_id = $3')
    expect(texto).toContain('d.account_id = e.account_id')
  })

  it('o instante vem do próprio banco (e), não de um texto devolvido ao Postgres', () => {
    // Comparar com o starts_at em texto arriscaria microssegundo e fuso; o
    // self-join compara a coluna com ela mesma.
    expect(q.params).toEqual([2, 'evt-canonico', 'conta-0001'])
  })

  it('cancelada não é cópia: só entra pelo próprio id', () => {
    // O status 'confirmed' só é exigido das OUTRAS linhas — o OR garante isso.
    expect(texto).toMatch(/\(d\.id = e\.id OR \(d\.contact_id = e\.contact_id AND d\.starts_at = e\.starts_at AND d\.status = 'confirmed'\)\)/)
  })

  it('sem comentário SQL dentro do UPDATE (interpolação depois de -- derruba a consulta)', () => {
    expect(q.sql).not.toContain('--')
  })
})

describe('ordem da fila dos lembretes', () => {
  it('desempata como escolherCanonico: criado primeiro (no milissegundo) e menor id byte a byte', () => {
    // Com o mesmo starts_at, a ordem entre os dois do par era arbitrária: a
    // cópia podia entrar na página do limite e o canônico ficar de fora.
    expect(plano(dialect.sqlToQuery(MEETING_QUEUE_ORDER).sql)).toBe(
      `e.starts_at ASC, date_trunc('milliseconds', e.created_at) ASC, (e.id::text) COLLATE "C" ASC`,
    )
  })
})

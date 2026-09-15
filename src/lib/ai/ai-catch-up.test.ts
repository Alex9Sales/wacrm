import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// Revisão 15/09 (GoLink): "Tirar responsável" nunca retomava a mensagem
// parada — ligar a IA grava a nota interna "▶️ IA religada…" e a busca da
// última mensagem pegava a NOTA e desistia. O stub do banco aplica o filtro
// de is_internal só se a consulta pedir (como o Postgres faria).
type Msg = { senderType: string; isInternal: boolean }

const h = vi.hoisted(() => ({
  /** Mensagens da conversa, da MAIS NOVA para a mais antiga. */
  messages: [] as { senderType: string; isInternal: boolean }[],
  conversation: { contactId: 'contact-1' } as { contactId: string | null } | null,
  lastMessageSql: '' as string,
  lastMessageOrder: '' as string,
  enqueued: [] as unknown[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const dialect = new PgDialect()
  const render = (s: SQL) => dialect.sqlToQuery(s).sql
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: SQL) => {
          const chain = {
            orderBy: (...order: SQL[]) => {
              h.lastMessageSql = render(cond)
              h.lastMessageOrder = order.map((o) => render(o as SQL)).join(', ')
              return chain
            },
            limit: async () => {
              if (table === actual.messages) {
                const filtersInternal = /"messages"\."is_internal" = \$\d/.test(h.lastMessageSql)
                const visible = filtersInternal ? h.messages.filter((m: Msg) => !m.isInternal) : h.messages
                return visible.slice(0, 1).map((m: Msg) => ({ senderType: m.senderType, isInternal: m.isInternal }))
              }
              if (table === actual.conversations) return h.conversation ? [h.conversation] : []
              if (table === actual.contacts) return [{ userId: 'owner-1' }]
              return []
            },
          }
          return chain
        },
      }),
    }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/queue/queues', () => ({
  enqueueAiReplyDebounced: async (job: unknown, delay: number) => {
    h.enqueued.push({ job, delay })
  },
}))

import { aiCatchUpOnEnable } from './ai-catch-up'

beforeEach(() => {
  h.messages = []
  h.conversation = { contactId: 'contact-1' }
  h.lastMessageSql = ''
  h.lastMessageOrder = ''
  h.enqueued = []
})

describe('aiCatchUpOnEnable', () => {
  it('nota interna DEPOIS da mensagem do cliente: retoma mesmo assim (o bug)', async () => {
    h.messages = [
      { senderType: 'bot', isInternal: true }, // "▶️ IA religada nesta conversa por Vitor."
      { senderType: 'customer', isInternal: false },
    ]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    expect(h.enqueued).toEqual([
      {
        job: { accountId: 'acc-1', conversationId: 'conv-1', contactId: 'contact-1', configOwnerUserId: 'owner-1' },
        delay: 0,
      },
    ])
  })

  it('várias notas internas seguidas também não escondem o cliente', async () => {
    h.messages = [
      { senderType: 'bot', isInternal: true },
      { senderType: 'agent', isInternal: true },
      { senderType: 'customer', isInternal: false },
    ]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    expect(h.enqueued).toHaveLength(1)
  })

  it('última mensagem visível é do atendente ou do bot: não enfileira', async () => {
    h.messages = [
      { senderType: 'bot', isInternal: true },
      { senderType: 'agent', isInternal: false },
      { senderType: 'customer', isInternal: false },
    ]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    h.messages = [{ senderType: 'bot', isInternal: false }]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    expect(h.enqueued).toHaveLength(0)
  })

  it('só notas internas / conversa vazia: não enfileira', async () => {
    h.messages = [{ senderType: 'bot', isInternal: true }]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    h.messages = []
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    expect(h.enqueued).toHaveLength(0)
  })

  it('ordena pela mais nova com NULL por último e id de desempate', async () => {
    h.messages = [{ senderType: 'customer', isInternal: false }]
    await aiCatchUpOnEnable('acc-1', 'conv-1')
    expect(h.lastMessageSql).toContain('"messages"."conversation_id" = $1')
    expect(h.lastMessageOrder).toBe('"messages"."created_at" DESC NULLS LAST, "messages"."id" desc')
  })

  it('conversa de outra conta (ou sem contato): não enfileira e não lança', async () => {
    h.messages = [{ senderType: 'customer', isInternal: false }]
    h.conversation = null
    await expect(aiCatchUpOnEnable('acc-1', 'conv-1')).resolves.toBeUndefined()
    expect(h.enqueued).toHaveLength(0)
  })
})

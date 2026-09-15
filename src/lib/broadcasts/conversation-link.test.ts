import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'

// 15/09 (GoLink): o disparo do Vitor saiu pelo número dedicado ao Leonardo e
// ele não via nenhuma conversa. Vira participante — sem trocar responsável,
// setor nem número. Revisão 15/09: SÓ em conversa que nasceu do disparo
// (participante vence privada/setor/atribuição e lê o histórico inteiro).
//
// O db é trocado por respostas por tabela; a tabela de participantes simula o
// índice único (conversation_id, user_id). As consultas cruas (db.execute) são
// renderizadas pelo dialeto do Postgres pra conferir o SQL e os parâmetros.
const h = vi.hoisted(() => ({
  channel: null as { accountId: string; provider: string } | null,
  contact: null as { userId: string } | null,
  /** Conversa existente pro canal sem eco (select em conversations). */
  existingConv: null as { id: string; isPrivate: boolean; assignedAgentId: string | null } | null,
  throwOnSelect: false,
  participants: new Set<string>(),
  inserts: [] as { values: unknown; conflictTarget: unknown }[],
  conv: null as {
    conversation: { id: string; isPrivate: boolean; assignedAgentId: string | null }
    created: boolean
  } | null,
  /** null = disparo não encontrado; senão a resposta do EXISTS de histórico. */
  hasHistory: false as boolean | null,
  /** user_ids que a INSERT … SELECT da 1ª resposta devolve. */
  firstReplyRows: [] as string[],
  throwOnExecute: false,
  noteAccess: false,
  executed: [] as { sql: string; params: unknown[] }[],
  findCalls: [] as unknown[][],
  webhooks: [] as unknown[][],
  events: [] as unknown[][],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const { PgDialect: Dialect } = await import('drizzle-orm/pg-core')
  const dialect = new Dialect()
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (h.throwOnSelect) throw new Error('db caiu')
            if (table === actual.channels) return h.channel ? [h.channel] : []
            if (table === actual.contacts) return h.contact ? [h.contact] : []
            if (table === actual.conversations) return h.existingConv ? [h.existingConv] : []
            return []
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: { conversationId: string; userId: string }) => ({
        onConflictDoNothing: async (opts?: { target?: unknown }) => {
          if (table !== actual.conversationParticipants) throw new Error('tabela errada')
          h.inserts.push({ values, conflictTarget: opts?.target })
          // índice único: repetido é ignorado (DO NOTHING), nunca duplica
          h.participants.add(`${values.conversationId}:${values.userId}`)
        },
      }),
    }),
    execute: async (query: SQL) => {
      const q = dialect.sqlToQuery(query)
      h.executed.push(q)
      if (h.throwOnExecute) throw new Error('db caiu')
      if (q.sql.includes('INSERT INTO "conversation_participants"')) {
        for (const uid of h.firstReplyRows) h.participants.add(`${q.params[0]}:${uid}`)
        return { rows: h.firstReplyRows.map((user_id) => ({ user_id })) }
      }
      if (q.sql.includes('"has_history"')) {
        return { rows: h.hasHistory === null ? [] : [{ has_history: h.hasHistory }] }
      }
      return { rows: h.noteAccess ? [{ '?column?': 1 }] : [] }
    },
  }
  return { ...actual, db }
})

vi.mock('@/lib/channels/inbound', () => ({
  findOrCreateConversation: vi.fn(async (...args: unknown[]) => {
    h.findCalls.push(args)
    return h.conv
  }),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async (...args: unknown[]) => {
    h.webhooks.push(args)
  }),
}))
vi.mock('@/lib/events/publish', () => ({
  publishEvent: vi.fn(async (...args: unknown[]) => {
    h.events.push(args)
  }),
}))

import {
  hasBroadcastAccessToConversation,
  linkBroadcastConversation,
  linkBroadcastCreatorsOnFirstReply,
} from './conversation-link'

const input = {
  accountId: 'acc',
  channelId: 'ch-atendimento',
  contactId: 'c1',
  creatorUserId: 'u-vitor',
  broadcastId: 'b1',
}

const existing = (over: Partial<{ id: string; isPrivate: boolean; assignedAgentId: string | null }> = {}) => ({
  id: 'cv1',
  isPrivate: false,
  assignedAgentId: null,
  ...over,
})

const oneLine = (s: string) => s.replace(/\s+/g, ' ')

beforeEach(() => {
  h.channel = { accountId: 'acc', provider: 'waha' }
  h.contact = { userId: 'u-owner' }
  h.existingConv = null
  h.throwOnSelect = false
  h.participants = new Set()
  h.inserts = []
  h.conv = { conversation: existing(), created: false }
  h.hasHistory = false
  h.firstReplyRows = []
  h.throwOnExecute = false
  h.noteAccess = false
  h.executed = []
  h.findCalls = []
  h.webhooks = []
  h.events = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('linkBroadcastConversation — canal com eco (WAHA)', () => {
  it('conversa NOVA (esta chamada criou) → participante, sem consultar histórico, e emite conversation.created', async () => {
    h.conv = { conversation: existing({ id: 'cv-new' }), created: true }
    await linkBroadcastConversation(input)
    // autoria da conversa = dono do contato (igual ao eco), não quem disparou
    expect(h.findCalls).toEqual([['acc', 'u-owner', 'c1', 'ch-atendimento']])
    expect([...h.participants]).toEqual(['cv-new:u-vitor'])
    expect(h.inserts[0].conflictTarget).toBeTruthy()
    expect(h.executed).toHaveLength(0)
    expect(h.webhooks).toEqual([
      ['acc', 'conversation.created', { conversation_id: 'cv-new', contact_id: 'c1' }, 'ch-atendimento'],
    ])
    expect(h.events).toEqual([['acc', { type: 'conversation.created', conversationId: 'cv-new' }]])
  })

  it('eco chegou antes (existente, sem mensagem anterior, sem responsável, não privada) → participante', async () => {
    h.conv = { conversation: existing(), created: false }
    h.hasHistory = false
    await linkBroadcastConversation(input)
    expect([...h.participants]).toEqual(['cv1:u-vitor'])
    // conversa já existia → nada de conversation.created
    expect(h.webhooks).toHaveLength(0)
    expect(h.events).toHaveLength(0)
    // a regra compara com ESTE disparo, na conta, e com o envio pra esse contato
    expect(h.executed).toHaveLength(1)
    const q = h.executed[0]
    expect(q.params).toEqual(expect.arrayContaining(['cv1', 'c1', 'b1', 'acc']))
    const s = oneLine(q.sql)
    expect(s).toContain('FROM "broadcasts" b')
    expect(s).toContain('m."created_at" < GREATEST(b."created_at", r."last_sent_at" - interval \'10 minutes\')')
    expect(s).toContain('m."sender_type" <> \'agent\'')
  })

  it('conversa PRIVADA de outra pessoa que já existia → sem participante', async () => {
    h.conv = { conversation: existing({ isPrivate: true, assignedAgentId: 'u-leo' }), created: false }
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(0)
    expect(h.participants.size).toBe(0)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('privada'),
      expect.objectContaining({ conversationId: 'cv1', broadcastId: 'b1' }),
    )
  })

  it('existente atribuída a colega → sem participante', async () => {
    h.conv = { conversation: existing({ assignedAgentId: 'u-leo' }), created: false }
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(0)
    expect(h.executed).toHaveLength(0)
  })

  it('existente atribuída ao próprio criador e sem histórico → participante', async () => {
    h.conv = { conversation: existing({ assignedAgentId: 'u-vitor' }), created: false }
    await linkBroadcastConversation(input)
    expect([...h.participants]).toEqual(['cv1:u-vitor'])
  })

  it('existente com mensagem anterior ao disparo → sem participante', async () => {
    h.conv = { conversation: existing(), created: false }
    h.hasHistory = true
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('histórico anterior'), expect.anything())
  })

  it('existente sem broadcastId ou com disparo de outra conta → sem participante', async () => {
    await linkBroadcastConversation({ ...input, broadcastId: undefined })
    expect(h.executed).toHaveLength(0)
    h.hasHistory = null // disparo não encontrado nessa conta
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(0)
  })

  it('não duplica participante (2º envio pra mesma conversa / retry)', async () => {
    await linkBroadcastConversation(input)
    await linkBroadcastConversation(input)
    expect(h.inserts).toHaveLength(2)
    expect(h.participants.size).toBe(1)
  })
})

describe('linkBroadcastConversation — canal SEM eco (meta/evogo)', () => {
  it('meta sem conversa → não cria conversa nem participante', async () => {
    for (const provider of ['meta', 'evogo']) {
      h.channel = { accountId: 'acc', provider }
      h.existingConv = null
      await linkBroadcastConversation(input)
    }
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
    expect(h.webhooks).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })

  it('meta com conversa nova (não privada, sem responsável, sem histórico) → participante, sem conversation.created', async () => {
    h.channel = { accountId: 'acc', provider: 'meta' }
    h.existingConv = existing({ id: 'cv-meta' })
    await linkBroadcastConversation(input)
    expect(h.findCalls).toHaveLength(0)
    expect([...h.participants]).toEqual(['cv-meta:u-vitor'])
    expect(h.webhooks).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })

  it('evogo com conversa de histórico anterior → sem participante', async () => {
    h.channel = { accountId: 'acc', provider: 'evogo' }
    h.existingConv = existing({ id: 'cv-evo' })
    h.hasHistory = true
    await linkBroadcastConversation(input)
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('linkBroadcastConversation — guardas', () => {
  it('pula canal de e-mail e gmail sem criar conversa', async () => {
    for (const provider of ['email', 'gmail']) {
      h.channel = { accountId: 'acc', provider }
      await linkBroadcastConversation(input)
    }
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('canal de outra conta ou contato de outra conta → não faz nada', async () => {
    h.channel = { accountId: 'outra', provider: 'waha' }
    await linkBroadcastConversation(input)
    h.channel = { accountId: 'acc', provider: 'waha' }
    h.contact = null
    await linkBroadcastConversation(input)
    expect(h.findCalls).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('nunca lança: conversa não resolvida, banco fora ou consulta de histórico falhando', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.conv = null
    await expect(linkBroadcastConversation(input)).resolves.toBeUndefined()
    expect(h.inserts).toHaveLength(0)
    h.conv = { conversation: existing(), created: false }
    h.throwOnExecute = true
    await expect(linkBroadcastConversation(input)).resolves.toBeUndefined()
    expect(h.inserts).toHaveLength(0)
    h.throwOnSelect = true
    await expect(linkBroadcastConversation(input)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('sem quem criou (disparo antigo/automático) → não consulta', async () => {
    h.throwOnSelect = true
    await expect(linkBroadcastConversation({ ...input, creatorUserId: '' })).resolves.toBeUndefined()
    expect(h.findCalls).toHaveLength(0)
  })
})

describe('linkBroadcastCreatorsOnFirstReply', () => {
  const reply = { accountId: 'acc', conversationId: 'cv-meta', contactId: 'c1', channelId: 'ch-oficial' }

  it('liga quem disparou pra esse contato por esse número nos últimos 7 dias', async () => {
    h.firstReplyRows = ['u-vitor', 'u-ana']
    await linkBroadcastCreatorsOnFirstReply(reply)
    expect([...h.participants].sort()).toEqual(['cv-meta:u-ana', 'cv-meta:u-vitor'])
    expect(h.executed).toHaveLength(1)
    const s = oneLine(h.executed[0].sql)
    expect(h.executed[0].params).toEqual(['cv-meta', 'acc', 'c1', 'ch-oficial'])
    expect(s).toContain('INSERT INTO "conversation_participants" ("conversation_id", "user_id") SELECT DISTINCT c."id", b."user_id"')
    expect(s).toContain('b."channel_id" = c."channel_id"')
    expect(s).toContain('r."contact_id" = c."contact_id"')
    expect(s).toContain('r."sent_at" IS NOT NULL')
    expect(s).toContain('r."sent_at" >= now() - interval \'7 days\'')
    expect(s).toContain('c."is_private" = false')
    expect(s).toContain('ON CONFLICT ("conversation_id", "user_id") DO NOTHING')
    // quem ganhou acesso recebe o ping pra conversa aparecer na lista
    expect(h.events).toEqual([['acc', { type: 'conversation.created', conversationId: 'cv-meta' }]])
  })

  it('ninguém disparou (ou fora da janela) → nada vinculado e nenhum ping', async () => {
    h.firstReplyRows = []
    await linkBroadcastCreatorsOnFirstReply(reply)
    expect(h.participants.size).toBe(0)
    expect(h.events).toHaveLength(0)
  })

  it('sem canal → não consulta; banco fora → não lança', async () => {
    await linkBroadcastCreatorsOnFirstReply({ ...reply, channelId: null })
    expect(h.executed).toHaveLength(0)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.throwOnExecute = true
    await expect(linkBroadcastCreatorsOnFirstReply(reply)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('hasBroadcastAccessToConversation (rota /note)', () => {
  it('só conta disparo DESSA pessoa, mesmo canal/contato/conta, conversa não privada e sem mensagem anterior', async () => {
    h.noteAccess = true
    await expect(hasBroadcastAccessToConversation('acc', 'cv1', 'u-vitor')).resolves.toBe(true)
    const q = h.executed[0]
    expect(q.params).toEqual(expect.arrayContaining(['u-vitor', 'cv1', 'acc']))
    const s = oneLine(q.sql)
    expect(s).toContain('b."user_id" = $1::uuid')
    expect(s).toContain('b."channel_id" = c."channel_id"')
    expect(s).toContain('r."contact_id" = c."contact_id"')
    expect(s).toContain('c."is_private" = false')
    expect(s).toContain('AND NOT EXISTS ( SELECT 1 FROM "messages" m')
    expect(s).toContain('m."created_at" < GREATEST(b."created_at", r."sent_at" - interval \'10 minutes\')')
  })

  it('sem linha (privada, histórico anterior ou disparo de outro) → false', async () => {
    h.noteAccess = false
    await expect(hasBroadcastAccessToConversation('acc', 'cv1', 'u-vitor')).resolves.toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
// Payloads are the camelCase drizzle `values(...)` objects.
const h = vi.hoisted(() => ({
  conversationInserts: [] as Array<Record<string, unknown>>,
  messageInserts: [] as Array<Record<string, unknown>>,
  // Toggles for the per-test scenario.
  existingConversation: null as Record<string, unknown> | null,
  contactRow: null as Record<string, unknown> | null,
  // A conversation created during the request becomes retrievable by id —
  // the shared send core re-loads the conversation from just the id, so
  // the mock must model insert-then-select-by-id.
  createdConversation: null as Record<string, unknown> | null,
}))

// `after()` do Next só existe dentro de uma requisição de verdade. Aqui ele
// roda o trabalho na hora, para o teste enxergar o aviso em tempo real.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (task: unknown) => {
      if (typeof task === 'function') void (task as () => unknown)()
    },
  }
})

const CONTACT = {
  id: 'contact-1',
  accountId: 'acct-1',
  phone: '+15551234567',
}

// Chainable drizzle mock over the real table objects (kept via
// importOriginal so identity checks like `table === contacts` work).
// Every select resolves canned rows per table; inserts are recorded.
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()

  const tableName = (t: unknown): string => {
    switch (t) {
      case actual.member:
        return 'member'
      case actual.user:
        return 'user'
      case actual.organization:
        return 'organization'
      case actual.contacts:
        return 'contacts'
      case actual.conversations:
        return 'conversations'
      case actual.channels:
        return 'channels'
      case actual.messageTemplates:
        return 'message_templates'
      case actual.messages:
        return 'messages'
      case actual.flowRuns:
        return 'flow_runs'
      default:
        return 'unknown'
    }
  }

  const selectRows = (table: string): unknown[] => {
    switch (table) {
      case 'member':
        // Tenancy + role: the fallback path in getCurrentAccount reads
        // the caller's first membership (organizationId + role).
        return [{ organizationId: 'acct-1', role: 'agent', userId: 'user-1' }]
      case 'user':
        return [{ id: 'user-1', name: 'Test User', email: 'user@test.dev' }]
      case 'organization':
        return [{ id: 'acct-1', name: 'Test Account', default_currency: 'USD' }]
      case 'contacts':
        return h.contactRow ? [h.contactRow] : []
      case 'conversations': {
        // Once created this request, a by-id reload returns it;
        // otherwise fall back to the canned existing row.
        const row = h.createdConversation ?? h.existingConversation
        return row ? [row] : []
      }
      case 'channels':
        return [
          {
            id: 'chan-1',
            accountId: 'acct-1',
            provider: 'meta',
            name: 'WhatsApp (Meta)',
            status: 'connected',
            phoneNumber: null,
            credentials: 'enc-token',
            providerMeta: { phone_number_id: 'PNID-1' },
            settings: {},
            webhookSecret: 'whsec',
          },
        ]
      default:
        return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectBuilder = (rowsFn: () => unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['where', 'limit', 'orderBy', 'leftJoin', 'innerJoin']) {
      b[m] = vi.fn(() => b)
    }
    b.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(rowsFn()).then(resolve, reject)
    return b
  }

  const insertResult = (table: string): unknown[] => {
    switch (table) {
      case 'conversations':
        return [h.createdConversation!]
      case 'messages':
        return [{ id: 'msg-1' }]
      default:
        return [{}]
    }
  }

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => selectBuilder(() => selectRows(tableName(table))),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (payload: Record<string, unknown>) => {
        const name = tableName(table)
        if (name === 'conversations') {
          h.conversationInserts.push(payload)
          h.createdConversation = {
            id: 'conv-new',
            accountId: 'acct-1',
            contactId: 'contact-1',
          }
        }
        if (name === 'messages') h.messageInserts.push(payload)
        return {
          returning: vi.fn(() => Promise.resolve(insertResult(name))),
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(insertResult(name)).then(resolve, reject),
        }
      },
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  }

  return { ...actual, db }
})

// Phase-1 session stub replacement — a fixed authenticated user.
vi.mock('@/lib/auth/session', () => ({
  getSessionUserId: vi.fn(async () => 'user-1'),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

// Phase 4: the send path resolves the channel through the channels
// helpers (credentials already decrypted). Mock at that boundary so
// the test doesn't depend on the encrypted DB round-trip.
const META_CHANNEL_CTX = {
  id: 'chan-1',
  accountId: 'acct-1',
  provider: 'meta' as const,
  name: 'WhatsApp (Meta)',
  phoneNumber: null,
  credentials: { accessToken: 'plaintext-token' },
  providerMeta: { phone_number_id: 'PNID-1' },
  settings: {},
  webhookSecret: 'whsec',
}
vi.mock('@/lib/channels/channels', () => ({
  loadChannel: vi.fn(async () => META_CHANNEL_CTX),
  loadChannelByAccount: vi.fn(async () => META_CHANNEL_CTX),
  loadDefaultChannel: vi.fn(async () => META_CHANNEL_CTX),
  loadMetaChannelByAccount: vi.fn(async () => META_CHANNEL_CTX),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

// Aviso em tempo real: a rota publica UMA vez, no fim, com a aba de origem.
const { publishEvent } = vi.hoisted(() => ({
  publishEvent: vi.fn(async () => {}),
}))
vi.mock('@/lib/events/publish', () => ({ publishEvent }))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    h.conversationInserts.length = 0
    h.messageInserts.length = 0
    h.existingConversation = null
    h.createdConversation = null
    h.contactRow = CONTACT
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(h.conversationInserts).toHaveLength(1)
    expect(h.conversationInserts[0]).toMatchObject({
      accountId: 'acct-1',
      contactId: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(h.messageInserts).toHaveLength(1)
    expect(h.messageInserts[0]).toMatchObject({
      conversationId: 'conv-new',
      contentType: 'template',
      templateName: 'order_update',
      senderType: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    h.existingConversation = {
      id: 'conv-existing',
      accountId: 'acct-1',
      contactId: 'contact-1',
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(h.conversationInserts).toHaveLength(0)
    expect(h.messageInserts[0]).toMatchObject({
      conversationId: 'conv-existing',
    })
  })

  it('404s when the contact is not in the caller account', async () => {
    h.contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — aviso em tempo real para os colegas', () => {
  beforeEach(() => {
    h.conversationInserts.length = 0
    h.messageInserts.length = 0
    h.existingConversation = null
    h.createdConversation = null
    h.contactRow = CONTACT
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('publica uma vez, com a aba que enviou', async () => {
    const res = await postContactTemplate({ origin_tab_id: 'aba-1234-abcd' })
    expect(res.status).toBe(200)

    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('acct-1', {
      type: 'message.received',
      conversationId: 'conv-new',
      fromMe: true,
      originTabId: 'aba-1234-abcd',
    })
  })

  it('sem aba (ou com id inválido) publica mesmo assim, sem originTabId', async () => {
    await postContactTemplate()
    await postContactTemplate({ origin_tab_id: '<script>alert(1)</script>' })
    await postContactTemplate({ origin_tab_id: 'a'.repeat(65) })

    expect(publishEvent).toHaveBeenCalledTimes(3)
    for (const call of publishEvent.mock.calls as unknown[][]) {
      const event = call[1] as Record<string, unknown>
      expect(event.type).toBe('message.received')
      expect(event.originTabId).toBeUndefined()
    }
  })

  it('não publica quando o envio não acontece', async () => {
    h.contactRow = null
    const res = await postContactTemplate({ origin_tab_id: 'aba-1234-abcd' })
    expect(res.status).toBe(404)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// 01/10: token do canal recusado pela Meta (190). O atendente lia um erro
// genérico na bolha; agora a rota diz que o canal está desconectado e onde
// reconectar. Falha que não é de token segue com a frase original.
describe('POST /api/whatsapp/send — canal desconectado', () => {
  beforeEach(() => {
    h.conversationInserts.length = 0
    h.messageInserts.length = 0
    h.existingConversation = null
    h.createdConversation = null
    h.contactRow = CONTACT
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('token invalidado → "O canal X está desconectado — reconecte em Configurações → Canais."', async () => {
    sendTemplateMessage.mockRejectedValueOnce(
      new Error(
        'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.',
      ),
    )
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(502)
    expect(json.error).toBe(
      'O canal WhatsApp (Meta) está desconectado — reconecte em Configurações → Canais.',
    )
    expect(json.code).toBe('channel_disconnected')
    expect(h.messageInserts).toHaveLength(0)
  })

  it('outra falha do provedor com o canal conectado mantém o erro original', async () => {
    sendTemplateMessage.mockRejectedValueOnce(new Error('Something else broke'))
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(502)
    expect(json.error).toMatch(/Something else broke/)
    expect(json.code).toBeUndefined()
  })
})

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
      case actual.whatsappConfig:
        return 'whatsapp_config'
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
      case 'whatsapp_config':
        return [
          {
            id: 'cfg-1',
            accountId: 'acct-1',
            phoneNumberId: 'PNID-1',
            accessToken: 'enc-token',
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

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

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

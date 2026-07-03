import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// Scriptable stubs. The dedupe + audit-user helpers live in other
// modules (with their own tests) — mock them at the boundary so these
// tests only exercise resolve-conversation's own control flow. The
// `db` mock keeps the real table objects (identity-compared to route
// each query) and swaps only the client.
// ------------------------------------------------------------
type ContactRow = { id: string; phone: string; name?: string | null };

const h = vi.hoisted(() => ({
  /** When true, any db call throws — proves a path never queries. */
  throwOnDb: false,
  config: null as { id: string } | null, // whatsapp_config lookup
  /** findExistingContact result (same every call). */
  existingContact: null as ContactRow | null,
  /** Per-call results — overrides existingContact. Lets a test
   *  simulate "miss, then hit" for the unique-race path. */
  existingByCall: null as (ContactRow | null)[] | null,
  findCalls: 0,
  insertedContactId: 'c-new',
  insertContactError: null as { code?: string } | null,
  existingConversation: null as { id: string } | null,
  insertedConversationId: 'cv-new',
  auditUserId: 'owner-1',
}));

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => {
    const result = h.existingByCall
      ? (h.existingByCall[h.findCalls] ?? null)
      : h.existingContact;
    h.findCalls++;
    return result;
  }),
  isUniqueViolation: (error: unknown) =>
    !!error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === '23505',
}));

vi.mock('@/lib/api/v1/contacts', () => {
  class ContactError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = 'ContactError';
      this.code = code;
      this.status = status;
    }
  }
  return {
    ContactError,
    resolveAuditUserId: vi.fn(async () => h.auditUserId),
  };
});

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  const guard = () => {
    if (h.throwOnDb) throw new Error('should not query');
  };
  const db = {
    select: () => {
      guard();
      return {
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === actual.whatsappConfig)
                return h.config ? [h.config] : [];
              if (table === actual.conversations)
                return h.existingConversation ? [h.existingConversation] : [];
              return [];
            },
          }),
        }),
      };
    },
    update: () => {
      guard();
      return { set: () => ({ where: async () => undefined }) };
    },
    insert: (table: unknown) => {
      guard();
      return {
        values: () => ({
          returning: async () => {
            if (table === actual.contacts) {
              if (h.insertContactError) throw h.insertContactError;
              return [{ id: h.insertedContactId }];
            }
            if (table === actual.conversations)
              return [{ id: h.insertedConversationId }];
            return [];
          },
        }),
      };
    },
  };
  return { ...actual, db };
});

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

beforeEach(() => {
  h.throwOnDb = false;
  h.config = null;
  h.existingContact = null;
  h.existingByCall = null;
  h.findCalls = 0;
  h.insertedContactId = 'c-new';
  h.insertContactError = null;
  h.existingConversation = null;
  h.insertedConversationId = 'cv-new';
  h.auditUserId = 'owner-1';
});

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    h.throwOnDb = true;
    await expect(
      resolveConversationByPhone('acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('fails with whatsapp_not_configured when no config owner exists', async () => {
    h.config = null;
    await resolveConversationByPhone('acct', '+14155550123').catch(
      (e: SendMessageError) => {
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
      }
    );
    await expect(
      resolveConversationByPhone('acct', '+14155550123')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('returns the existing contact + conversation without creating', async () => {
    h.config = { id: 'cfg-1' };
    h.existingContact = { id: 'c1', phone: '14155550123' };
    h.existingConversation = { id: 'cv1' };
    const res = await resolveConversationByPhone('acct', '+1 (415) 555-0123');
    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      contactCreated: false,
    });
  });

  it('creates contact + conversation when none exist', async () => {
    h.config = { id: 'cfg-1' };
    h.existingContact = null;
    h.insertedContactId = 'c2';
    h.existingConversation = null;
    h.insertedConversationId = 'cv2';
    const res = await resolveConversationByPhone(
      'acct',
      '+14155550199',
      'Jane'
    );
    expect(res).toEqual({
      conversationId: 'cv2',
      contactId: 'c2',
      contactCreated: true,
    });
  });

  it('re-resolves an existing contact when the insert loses a unique race', async () => {
    // First lookup misses (→ we attempt an insert), the insert hits a
    // 23505 unique violation, and the post-race re-lookup now returns
    // the row a concurrent writer created.
    h.config = { id: 'cfg-1' };
    h.existingByCall = [null, { id: 'c-raced', phone: '14155550123' }];
    h.insertContactError = { code: '23505' };
    h.existingConversation = { id: 'cv-raced' };
    const res = await resolveConversationByPhone('acct', '+14155550123');
    expect(res.contactId).toBe('c-raced');
    expect(res.contactCreated).toBe(false);
    expect(res.conversationId).toBe('cv-raced');
  });
});

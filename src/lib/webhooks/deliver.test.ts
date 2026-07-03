import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

// ------------------------------------------------------------
// Mock the shared Drizzle client. `rows` is the endpoint set the
// select resolves to; `updates` records every update().set() payload
// (success path resets failure_count); `executes` records raw SQL
// calls (the atomic record_webhook_failure function).
// ------------------------------------------------------------
const state = vi.hoisted(() => ({
  rows: [] as { id: string; url: string; secret: string }[],
  updates: [] as Record<string, unknown>[],
  executes: [] as unknown[],
}));

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => state.rows }) }),
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: async () => {
            state.updates.push(payload);
          },
        }),
      }),
      execute: async (query: unknown) => {
        state.executes.push(query);
        return { rows: [] };
      },
    },
  };
});

import { dispatchWebhookEvent, MAX_CONSECUTIVE_FAILURES } from './deliver';
import { isDeliverableUrl } from './ssrf';

/**
 * Extract the bound parameter values from a drizzle sql`` object.
 * queryChunks interleaves StringChunk objects (whose `value` is a
 * string array) with the raw interpolated values — keep the latter.
 */
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter(
    (c) =>
      !(
        typeof c === 'object' &&
        c !== null &&
        Array.isArray((c as { value?: unknown }).value)
      )
  );
}

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  state.executes = [];
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets failure_count on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    state.rows = [{ id: 'a', url: 'https://a.test/hook', secret: 's1' }];

    await dispatchWebhookEvent('acct-1', 'message.received', { x: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(state.updates[0]).toMatchObject({ failureCount: 0 });
    expect(state.executes).toHaveLength(0);
  });

  it('records an atomic failure (SQL function) when the endpoint errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    state.rows = [{ id: 'b', url: 'https://b.test/hook', secret: 's2' }];

    await dispatchWebhookEvent('acct-1', 'message.received', {});

    expect(state.executes).toHaveLength(1);
    expect(sqlParams(state.executes[0])).toEqual(['b', MAX_CONSECUTIVE_FAILURES]);
    expect(state.updates).toHaveLength(0);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.rows = [{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }];

    await dispatchWebhookEvent('acct-1', 'message.received', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.executes).toHaveLength(1);
    expect(sqlParams(state.executes[0])).toEqual(['c', MAX_CONSECUTIVE_FAILURES]);
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await dispatchWebhookEvent('acct-1', 'message.received', {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.executes).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });
});

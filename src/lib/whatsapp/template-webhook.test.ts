import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Param } from 'drizzle-orm';

// Mock only the `db` client; keep the real table objects so the
// module's `eq(messageTemplates.metaTemplateId, …)` references keep
// working and the recorded `update` target can be identity-compared.
// Records the .set payload and the .where condition for inspection —
// anything beyond the surface this module uses throws loudly.
const h = vi.hoisted(() => ({
  calls: [] as {
    table: unknown;
    set?: Record<string, unknown>;
    where?: unknown;
  }[],
  /** Rows the UPDATE … RETURNING resolves with. */
  rows: [{ id: 'row-1' }] as { id: string }[],
  /** When set, the query rejects with this message instead. */
  errorMessage: null as string | null,
}));

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    db: {
      update: (table: unknown) => {
        const entry: (typeof h.calls)[number] = { table };
        h.calls.push(entry);
        return {
          set: (payload: Record<string, unknown>) => {
            entry.set = payload;
            return {
              where: (cond: unknown) => {
                entry.where = cond;
                const result = () =>
                  h.errorMessage
                    ? Promise.reject(new Error(h.errorMessage))
                    : Promise.resolve(h.rows);
                return {
                  returning: () => result(),
                  // Allow `await db.update().set().where()` (no .returning()).
                  then: (
                    onFulfilled?: (v: unknown) => unknown,
                    onRejected?: (e: unknown) => unknown,
                  ) => result().then(onFulfilled, onRejected),
                };
              },
            };
          },
        };
      },
    },
  };
});

import { messageTemplates } from '@/db';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook';

/** Extract the bound parameter values from a drizzle `eq()` condition. */
function boundValues(cond: unknown): unknown[] {
  const chunks =
    (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks
    .filter((c): c is Param => c instanceof Param)
    .map((c) => c.value);
}

beforeEach(() => {
  h.calls = [];
  h.rows = [{ id: 'row-1' }];
  h.errorMessage = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_components_update')).toBe(
      true,
    );
  });
  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false);
    expect(isTemplateWebhookField('message_status')).toBe(false);
  });
});

describe('handleTemplateWebhookChange — status update', () => {
  it('flips status to APPROVED and clears any rejection_reason', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 12345,
        message_template_name: 'order_confirmation',
        message_template_language: 'en_US',
      },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].table).toBe(messageTemplates);
    // Coerced to string so the filter matches the TEXT column.
    expect(boundValues(h.calls[0].where)).toEqual(['12345']);
    expect(h.calls[0].set).toEqual({
      status: 'APPROVED',
      rejectionReason: null,
      submissionError: null,
    });
  });

  it('persists the reason field on REJECTED', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'REJECTED',
        message_template_id: 'TMPL_99',
        reason: 'Template uses non-compliant language.',
      },
    });
    expect(h.calls[0].set?.status).toBe('REJECTED');
    expect(h.calls[0].set?.rejectionReason).toBe(
      'Template uses non-compliant language.',
    );
  });

  it('falls back to a generic reason when REJECTED has no `reason`', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'REJECTED', message_template_id: '7' },
    });
    expect(h.calls[0].set?.rejectionReason).toBe('Rejected by Meta');
  });

  it('normalises PENDING_REVIEW → PENDING (via shared normalizeStatus)', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'PENDING_REVIEW', message_template_id: '1' },
    });
    expect(h.calls[0].set?.status).toBe('PENDING');
  });

  it('logs and exits when meta_template_id is missing (no UPDATE issued)', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'APPROVED' },
    });
    expect(h.calls).toHaveLength(0);
  });

  it('logs a warning when the row is unknown locally (zero matches)', async () => {
    const warn = vi.spyOn(console, 'warn');
    h.rows = [];
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 'NEVER_SEEN',
        message_template_name: 'mystery',
      },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('logs (and does not throw) when the UPDATE fails', async () => {
    const error = vi.spyOn(console, 'error');
    h.errorMessage = 'db exploded';
    await expect(
      handleTemplateWebhookChange({
        field: 'message_template_status_update',
        value: { event: 'APPROVED', message_template_id: '3' },
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — quality update', () => {
  it('sets quality_score from new_quality_score', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        previous_quality_score: 'GREEN',
        new_quality_score: 'YELLOW',
      },
    });
    expect(h.calls[0].table).toBe(messageTemplates);
    expect(h.calls[0].set).toEqual({ qualityScore: 'YELLOW' });
    expect(boundValues(h.calls[0].where)).toEqual(['99']);
  });

  it('stores null for unrecognised quality scores', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        new_quality_score: 'PURPLE', // not a real Meta value
      },
    });
    expect(h.calls[0].set).toEqual({ qualityScore: null });
  });
});

describe('handleTemplateWebhookChange — components update', () => {
  it('is an info-log no-op (does not write to DB)', async () => {
    const info = vi.spyOn(console, 'info');
    await handleTemplateWebhookChange({
      field: 'message_template_components_update',
      value: {
        message_template_id: '5',
        message_template_name: 'x',
      },
    });
    expect(h.calls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — unknown field', () => {
  it('is a defensive no-op', async () => {
    await handleTemplateWebhookChange(
      // Pretend Meta added a new template_* field we don't know about.
      // The route handler pre-filters via isTemplateWebhookField, but
      // the dispatch should still be safe if the filter is bypassed.
      { field: 'message_template_future_field', value: {} },
    );
    expect(h.calls).toHaveLength(0);
  });
});

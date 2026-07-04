import { describe, it, expect } from 'vitest';
import { createBroadcast, BroadcastError } from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any DB call — the shared Drizzle client is lazy, so no mock needed.

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast('acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast('acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than the sanity cap of recipients', async () => {
    // The old immediate-loop cap (1000) was relaxed to a high sanity
    // bound (50000) now that fan-out is a durable BullMQ queue.
    const recipients = Array.from({ length: 50_001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast('acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

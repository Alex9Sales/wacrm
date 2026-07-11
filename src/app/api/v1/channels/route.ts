// ============================================================
// GET /api/v1/channels — list the account's WhatsApp channels
//   (scope: broadcasts:send). Returns the id + name + provider + status of
//   each connected number so a caller (e.g. Hermes) can resolve which
//   channel_id to send a broadcast (or message) from — e.g. map the name
//   "Família do Gás 2" to its UUID. Read-only.
//
//   NOTE: this is the WhatsApp *sending* channels list. It is unrelated to
//   /api/v1/internal/channels, which are the team's internal CHAT channels.
//
//   `official` = true for the Meta Cloud API (templates, no jitter);
//   false for the non-official providers (WAHA/Evolution/EvoGo) that a text
//   broadcast (POST /broadcasts/text) runs on.
// ============================================================

import { asc, eq } from 'drizzle-orm';

import { db, channels } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getProvider } from '@/lib/channels/registry';
import type { ProviderId } from '@/lib/channels/provider';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const rows = await db
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
        status: channels.status,
        phone_number: channels.phoneNumber,
      })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))
      .orderBy(asc(channels.createdAt));

    const data = rows.map((r) => ({
      ...r,
      // Non-official providers need jitter; Meta (official) does not.
      official: !getProvider(r.provider as ProviderId).capabilities.needsJitter,
    }));
    return ok({ data });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

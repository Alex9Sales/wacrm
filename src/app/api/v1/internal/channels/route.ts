// ============================================================
// GET  /api/v1/internal/channels — list the account's internal channels
//   (scope: internal:read)
// POST /api/v1/internal/channels — create an internal channel
//   (scope: internal:write) — body: { name, is_private?, member_ids? }
// Account-scoped. Lets an agent (e.g. Hermes) see and open team channels.
// ============================================================

import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  db,
  internalChannels,
  internalChannelMembers,
  member,
} from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'internal:read');
    const rows = await db
      .select({
        id: internalChannels.id,
        name: internalChannels.name,
        is_private: internalChannels.isPrivate,
        created_at: internalChannels.createdAt,
      })
      .from(internalChannels)
      .where(eq(internalChannels.accountId, ctx.accountId))
      .orderBy(asc(internalChannels.name));
    return ok({ data: rows });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'internal:write');
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('invalid_request', 'name is required', 422);
    const isPrivate = body.is_private === true;
    const memberIds = Array.isArray(body.member_ids)
      ? (body.member_ids as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];

    const [row] = await db
      .insert(internalChannels)
      .values({ accountId: ctx.accountId, name, isPrivate })
      .returning({ id: internalChannels.id });

    // Add members (validated against the account) for a private channel.
    if (memberIds.length > 0) {
      const valid = await db
        .select({ userId: member.userId })
        .from(member)
        .where(
          and(
            eq(member.organizationId, ctx.accountId),
            inArray(member.userId, memberIds),
          ),
        );
      if (valid.length > 0) {
        await db
          .insert(internalChannelMembers)
          .values(valid.map((m) => ({ channelId: row.id, userId: m.userId })))
          .onConflictDoNothing();
      }
    }

    return ok({ id: row.id }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

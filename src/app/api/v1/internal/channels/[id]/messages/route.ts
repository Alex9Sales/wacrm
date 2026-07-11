// ============================================================
// GET  /api/v1/internal/channels/{id}/messages — recent messages
//   (scope: internal:read)
// POST /api/v1/internal/channels/{id}/messages — post a message
//   (scope: internal:write) — body: { sender_user_id, content }
// The API key carries no user, so the caller (e.g. Hermes) names the sender.
// ============================================================

import { and, desc, eq } from 'drizzle-orm';

import { db, internalChannels, internalMessages, member, user } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { publishEvent } from '@/lib/events/publish';

async function channelInAccount(id: string, accountId: string) {
  return firstOrNull(
    await db
      .select({ id: internalChannels.id })
      .from(internalChannels)
      .where(
        and(
          eq(internalChannels.id, id),
          eq(internalChannels.accountId, accountId),
        ),
      )
      .limit(1),
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'internal:read');
    const { id } = await params;
    if (!(await channelInAccount(id, ctx.accountId))) {
      return fail('not_found', 'Channel not found', 404);
    }
    const rows = await db
      .select({
        id: internalMessages.id,
        sender_id: internalMessages.senderId,
        sender_name: user.name,
        content: internalMessages.content,
        created_at: internalMessages.createdAt,
      })
      .from(internalMessages)
      .leftJoin(user, eq(internalMessages.senderId, user.id))
      .where(eq(internalMessages.channelId, id))
      .orderBy(desc(internalMessages.createdAt))
      .limit(50);
    return ok({ data: rows.reverse() });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'internal:write');
    const { id } = await params;
    if (!(await channelInAccount(id, ctx.accountId))) {
      return fail('not_found', 'Channel not found', 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const content =
      typeof body.content === 'string' ? body.content.trim() : '';
    const senderUserId =
      typeof body.sender_user_id === 'string' ? body.sender_user_id : '';
    if (!content) return fail('invalid_request', 'content is required', 422);
    if (!senderUserId) {
      return fail('invalid_request', 'sender_user_id is required', 422);
    }

    // The sender must be a member of this account.
    const sender = firstOrNull(
      await db
        .select({ userId: member.userId, name: user.name })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(member.organizationId, ctx.accountId),
            eq(member.userId, senderUserId),
          ),
        )
        .limit(1),
    );
    if (!sender) {
      return fail(
        'invalid_request',
        'sender_user_id is not a member of this account',
        422
      );
    }

    const [row] = await db
      .insert(internalMessages)
      .values({ channelId: id, senderId: senderUserId, content })
      .returning({
        id: internalMessages.id,
        created_at: internalMessages.createdAt,
      });

    await publishEvent(ctx.accountId, {
      type: 'internal_message',
      channelId: id,
      senderId: senderUserId,
      senderName: sender.name ?? undefined,
    });

    return ok(
      {
        id: row.id,
        channel_id: id,
        sender_id: senderUserId,
        content,
        created_at: row.created_at,
      },
      201
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

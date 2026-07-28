'use server';

// ============================================================
// Chat Interno — server actions. Account-scoped team chat: public
// channels are visible to everyone in the account; private channels only
// to their members. Channel creation is admin-only; sending messages is
// open to any member who can see the channel. There is no delete here —
// same policy as the rest of the app (removal is out of the API surface).
// ============================================================

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import {
  db,
  internalChannels,
  internalChannelMembers,
  internalChannelReads,
  internalMessages,
  member,
  notifications,
  user,
} from '@/db';
import { firstOrNull } from '@/db/helpers';
import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { publishEvent } from '@/lib/events/publish';
import { parseMentions } from '@/lib/inbox/mentions';
import type {
  InternalChannel,
  InternalChatMessage,
  TeamMemberOption,
} from '@/lib/internal-chat/types';

/** Channel ids the user is an explicit member of (private channels). */
async function memberChannelIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ channelId: internalChannelMembers.channelId })
    .from(internalChannelMembers)
    .where(eq(internalChannelMembers.userId, userId));
  return rows.map((r) => r.channelId);
}

/** True when the user may see/post in the channel (public in-account, or a
 *  private member). Also enforces account tenancy. */
async function canAccessChannel(
  accountId: string,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const ch = firstOrNull(
    await db
      .select({
        accountId: internalChannels.accountId,
        isPrivate: internalChannels.isPrivate,
      })
      .from(internalChannels)
      .where(eq(internalChannels.id, channelId))
      .limit(1),
  );
  if (!ch || ch.accountId !== accountId) return false;
  if (!ch.isPrivate) return true;
  const membership = firstOrNull(
    await db
      .select({ id: internalChannelMembers.id })
      .from(internalChannelMembers)
      .where(
        and(
          eq(internalChannelMembers.channelId, channelId),
          eq(internalChannelMembers.userId, userId),
        ),
      )
      .limit(1),
  );
  return !!membership;
}

/** Set of channel ids with messages from OTHERS newer than the user's last
 *  read — the "has unread" signal for the badge and per-channel dots. */
async function unreadChannelIds(
  userId: string,
  channelIds: string[],
): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  const last = await db
    .select({
      channelId: internalMessages.channelId,
      lastOther: sql<
        string | null
      >`max(${internalMessages.createdAt}) filter (where ${internalMessages.senderId} <> ${userId})`,
    })
    .from(internalMessages)
    .where(inArray(internalMessages.channelId, channelIds))
    .groupBy(internalMessages.channelId);
  const reads = await db
    .select({
      channelId: internalChannelReads.channelId,
      lastReadAt: internalChannelReads.lastReadAt,
    })
    .from(internalChannelReads)
    .where(
      and(
        eq(internalChannelReads.userId, userId),
        inArray(internalChannelReads.channelId, channelIds),
      ),
    );
  const readMap = new Map(reads.map((r) => [r.channelId, r.lastReadAt]));
  const set = new Set<string>();
  for (const row of last) {
    if (!row.lastOther) continue;
    const lastRead = readMap.get(row.channelId);
    if (!lastRead || new Date(row.lastOther) > new Date(lastRead)) {
      set.add(row.channelId);
    }
  }
  return set;
}

/** Ids of every channel the current user can see (public + private member). */
async function accessibleChannelIds(
  accountId: string,
  userId: string,
): Promise<string[]> {
  const mine = await memberChannelIds(userId);
  const rows = await db
    .select({ id: internalChannels.id })
    .from(internalChannels)
    .where(
      and(
        eq(internalChannels.accountId, accountId),
        or(
          eq(internalChannels.isPrivate, false),
          mine.length ? inArray(internalChannels.id, mine) : sql`false`,
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** Channels the current user can see: every public channel in the account
 *  plus the private ones they belong to, each with its unread flag. */
export async function listInternalChannels(): Promise<InternalChannel[]> {
  const ctx = await getCurrentAccount();
  const mine = await memberChannelIds(ctx.userId);
  const rows = await db
    .select({
      id: internalChannels.id,
      name: internalChannels.name,
      description: internalChannels.description,
      is_private: internalChannels.isPrivate,
      created_at: internalChannels.createdAt,
    })
    .from(internalChannels)
    .where(
      and(
        eq(internalChannels.accountId, ctx.accountId),
        or(
          eq(internalChannels.isPrivate, false),
          mine.length ? inArray(internalChannels.id, mine) : sql`false`,
        ),
      ),
    )
    .orderBy(asc(internalChannels.name));
  const unread = await unreadChannelIds(
    ctx.userId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, unread: unread.has(r.id) })) as InternalChannel[];
}

/** Total number of channels with unread messages — for the sidebar badge. */
export async function getInternalUnreadCount(): Promise<number> {
  const ctx = await getCurrentAccount();
  const ids = await accessibleChannelIds(ctx.accountId, ctx.userId);
  const unread = await unreadChannelIds(ctx.userId, ids);
  return unread.size;
}

/** Mark a channel read up to now for the current user. */
export async function markInternalChannelRead(channelId: string): Promise<void> {
  const ctx = await getCurrentAccount();
  await db
    .insert(internalChannelReads)
    .values({ channelId, userId: ctx.userId })
    .onConflictDoUpdate({
      target: [internalChannelReads.channelId, internalChannelReads.userId],
      set: { lastReadAt: new Date().toISOString() },
    });
}

/** The account's team members — for the private-channel member picker. */
export async function listTeamMembers(): Promise<TeamMemberOption[]> {
  const ctx = await getCurrentAccount();
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.accountId))
    .orderBy(asc(user.name));
  return rows as TeamMemberOption[];
}

export interface CreateInternalChannelInput {
  name: string;
  description?: string | null;
  isPrivate: boolean;
  /** User ids to add when private (the creator is always included). */
  memberIds?: string[];
}

/** Create a channel (supervisor+). Private channels get member rows for the
 *  selected users plus the creator. */
export async function createInternalChannel(
  input: CreateInternalChannelInput,
): Promise<InternalChannel> {
  const ctx = await requireRole('supervisor');
  const name = input.name.trim();
  if (!name) throw new Error('Dê um nome ao canal.');

  const channel = firstOrNull(
    await db
      .insert(internalChannels)
      .values({
        accountId: ctx.accountId,
        name,
        description: input.description?.trim() || null,
        isPrivate: !!input.isPrivate,
        createdBy: ctx.userId,
      })
      .returning({
        id: internalChannels.id,
        name: internalChannels.name,
        description: internalChannels.description,
        is_private: internalChannels.isPrivate,
        created_at: internalChannels.createdAt,
      }),
  );
  if (!channel) throw new Error('Não foi possível criar o canal.');

  if (input.isPrivate) {
    // Restrict the selected ids to real account members, then always add
    // the creator so they can see the channel they just made.
    const memberRows = await db
      .select({ id: user.id })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId));
    const validIds = new Set(memberRows.map((r) => r.id));
    const ids = new Set<string>([ctx.userId]);
    for (const id of input.memberIds ?? []) {
      if (validIds.has(id)) ids.add(id);
    }
    await db
      .insert(internalChannelMembers)
      .values([...ids].map((userId) => ({ channelId: channel.id, userId })))
      .onConflictDoNothing();
  }

  return channel as InternalChannel;
}

export interface UpdateInternalChannelInput {
  channelId: string;
  name: string;
  description?: string | null;
  isPrivate: boolean;
  /** User ids for a private channel (creator + editor always kept). */
  memberIds?: string[];
}

/**
 * Edit a channel's name/description, flip its privacy, and (for private
 * channels) reset who participates. Supervisor+. Going public drops the member
 * rows (everyone sees public channels); going private rebuilds them from the
 * selected ids plus the creator and the editor.
 */
export async function updateInternalChannel(
  input: UpdateInternalChannelInput,
): Promise<InternalChannel> {
  const ctx = await requireRole('supervisor');
  const name = input.name.trim();
  if (!name) throw new Error('Dê um nome ao canal.');

  const existing = firstOrNull(
    await db
      .select({ id: internalChannels.id, createdBy: internalChannels.createdBy })
      .from(internalChannels)
      .where(
        and(
          eq(internalChannels.id, input.channelId),
          eq(internalChannels.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  );
  if (!existing) throw new Error('Canal não encontrado.');

  const updated = firstOrNull(
    await db
      .update(internalChannels)
      .set({
        name,
        description: input.description?.trim() || null,
        isPrivate: !!input.isPrivate,
      })
      .where(
        and(
          eq(internalChannels.id, input.channelId),
          eq(internalChannels.accountId, ctx.accountId),
        ),
      )
      .returning({
        id: internalChannels.id,
        name: internalChannels.name,
        description: internalChannels.description,
        is_private: internalChannels.isPrivate,
        created_at: internalChannels.createdAt,
      }),
  );
  if (!updated) throw new Error('Não foi possível atualizar o canal.');

  // Rebuild membership to match the new privacy state.
  await db
    .delete(internalChannelMembers)
    .where(eq(internalChannelMembers.channelId, input.channelId));
  if (input.isPrivate) {
    const memberRows = await db
      .select({ id: user.id })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId));
    const validIds = new Set(memberRows.map((r) => r.id));
    const ids = new Set<string>();
    if (existing.createdBy) ids.add(existing.createdBy);
    ids.add(ctx.userId);
    for (const id of input.memberIds ?? []) if (validIds.has(id)) ids.add(id);
    if (ids.size > 0) {
      await db
        .insert(internalChannelMembers)
        .values([...ids].map((userId) => ({ channelId: input.channelId, userId })))
        .onConflictDoNothing();
    }
  }
  return updated as InternalChannel;
}

/** Delete a channel and everything in it (members/messages/reads cascade via
 *  FK). Supervisor+. */
export async function deleteInternalChannel(channelId: string): Promise<void> {
  const ctx = await requireRole('supervisor');
  await db
    .delete(internalChannels)
    .where(
      and(
        eq(internalChannels.id, channelId),
        eq(internalChannels.accountId, ctx.accountId),
      ),
    );
}

/** Current member ids of a (private) channel — for the edit dialog. */
export async function listInternalChannelMemberIds(
  channelId: string,
): Promise<string[]> {
  const ctx = await getCurrentAccount();
  // Scope by account via the channel row.
  const ch = firstOrNull(
    await db
      .select({ id: internalChannels.id })
      .from(internalChannels)
      .where(
        and(
          eq(internalChannels.id, channelId),
          eq(internalChannels.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  );
  if (!ch) return [];
  const rows = await db
    .select({ userId: internalChannelMembers.userId })
    .from(internalChannelMembers)
    .where(eq(internalChannelMembers.channelId, channelId));
  return rows.map((r) => r.userId);
}

/** Messages in a channel (oldest first), access-checked. */
export async function getInternalMessages(
  channelId: string,
): Promise<InternalChatMessage[]> {
  const ctx = await getCurrentAccount();
  if (!(await canAccessChannel(ctx.accountId, ctx.userId, channelId))) {
    throw new Error('Canal não encontrado.');
  }
  const rows = await db
    .select({
      id: internalMessages.id,
      channel_id: internalMessages.channelId,
      sender_id: internalMessages.senderId,
      sender_name: user.name,
      sender_image: user.image,
      content: internalMessages.content,
      created_at: internalMessages.createdAt,
    })
    .from(internalMessages)
    .innerJoin(user, eq(internalMessages.senderId, user.id))
    .where(eq(internalMessages.channelId, channelId))
    .orderBy(desc(internalMessages.createdAt))
    .limit(300);
  // Query newest-first (indexed) then flip to chronological for display.
  return rows
    .map((r) => ({ ...r, is_mine: r.sender_id === ctx.userId }))
    .reverse() as InternalChatMessage[];
}

/** Post a message to a channel, access-checked. Emits a realtime event so
 *  other members' open clients refetch. */
export async function sendInternalMessage(
  channelId: string,
  content: string,
): Promise<InternalChatMessage> {
  const ctx = await getCurrentAccount();
  const text = content.trim();
  if (!text) throw new Error('Escreva uma mensagem.');
  if (text.length > 4000) throw new Error('Mensagem muito longa.');
  if (!(await canAccessChannel(ctx.accountId, ctx.userId, channelId))) {
    throw new Error('Canal não encontrado.');
  }

  const inserted = firstOrNull(
    await db
      .insert(internalMessages)
      .values({ channelId, senderId: ctx.userId, content: text })
      .returning({
        id: internalMessages.id,
        channel_id: internalMessages.channelId,
        sender_id: internalMessages.senderId,
        content: internalMessages.content,
        created_at: internalMessages.createdAt,
      }),
  );
  if (!inserted) throw new Error('Não foi possível enviar a mensagem.');

  const me = firstOrNull(
    await db
      .select({ name: user.name, image: user.image })
      .from(user)
      .where(eq(user.id, ctx.userId))
      .limit(1),
  );

  // The sender has obviously seen their own channel — keep it "read".
  await db
    .insert(internalChannelReads)
    .values({ channelId, userId: ctx.userId })
    .onConflictDoUpdate({
      target: [internalChannelReads.channelId, internalChannelReads.userId],
      set: { lastReadAt: new Date().toISOString() },
    });

  await publishEvent(ctx.accountId, {
    type: 'internal_message',
    channelId,
    senderId: ctx.userId,
    senderName: me?.name ?? undefined,
  });

  // @mentions → a persistent notification (bell) for each mentioned member,
  // plus a live "mention" event so their pop-up fires even inside the chat.
  // Best-effort: a mention hiccup must never fail the message that went out.
  try {
    const membersList = await db
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId));
    const mentionedIds = parseMentions(text, membersList).filter(
      (id) => id !== ctx.userId,
    );
    if (mentionedIds.length > 0) {
      await db.insert(notifications).values(
        mentionedIds.map((uid) => ({
          accountId: ctx.accountId,
          userId: uid,
          type: 'mention' as const,
          actorUserId: ctx.userId,
          title: `${me?.name ?? 'Alguém'} mencionou você`,
          body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
        })),
      );
      await publishEvent(ctx.accountId, {
        type: 'mention',
        channelId,
        senderName: me?.name ?? undefined,
        mentionedUserIds: mentionedIds,
      });
    }
  } catch (err) {
    console.error('[internal-chat] mention notify failed:', err);
  }

  return {
    ...inserted,
    sender_name: me?.name ?? 'Você',
    sender_image: me?.image ?? null,
    is_mine: true,
  } as InternalChatMessage;
}

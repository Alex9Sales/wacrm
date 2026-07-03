'use server'

// ============================================================
// Server actions for the Notifications page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Scoped to the
// caller's account AND user — notifications are per-recipient and
// there is no RLS anymore.
// ============================================================

import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, notifications } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Notification } from '@/types'

const notificationColumns = {
  id: notifications.id,
  account_id: notifications.accountId,
  user_id: notifications.userId,
  type: notifications.type,
  conversation_id: notifications.conversationId,
  contact_id: notifications.contactId,
  actor_user_id: notifications.actorUserId,
  title: notifications.title,
  body: notifications.body,
  read_at: notifications.readAt,
  created_at: notifications.createdAt,
}

/** The caller's 100 most recent notifications, newest first. */
export async function listNotifications(): Promise<Notification[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(notificationColumns)
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, ctx.accountId),
        eq(notifications.userId, ctx.userId),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(100)
  return rows as unknown as Notification[]
}

/** Mark one notification read (no-op if already read). */
export async function markNotificationRead(
  notificationId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, ctx.userId),
          eq(notifications.accountId, ctx.accountId),
          isNull(notifications.readAt),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to mark as read' }
  }
}

/** Mark every unread notification of the caller as read. */
export async function markAllNotificationsRead(): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(
        and(
          eq(notifications.userId, ctx.userId),
          eq(notifications.accountId, ctx.accountId),
          isNull(notifications.readAt),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to mark all as read' }
  }
}

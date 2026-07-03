// ============================================================
// GET /api/notifications/unread-count — number of unread
// notifications for the current user.
//
// Replaces the browser Supabase read that use-unread-notifications
// did directly (client code can't touch Drizzle/pg). Scoped to the
// caller's own rows (user_id) AND their account, since RLS is gone
// in Phase 1 and every tenant query must filter by accountId.
//
// Response: { count: number }
// 401 when unauthenticated.
//
// TODO(fase-3): live updates (a badge that ticks without a refetch)
// come back with SSE. For now the client fetches once + refetches.
// ============================================================

import { NextResponse } from "next/server";
import { and, count, eq, isNull } from "drizzle-orm";

import { db, notifications } from "@/db";
import { firstOrThrow } from "@/db/helpers";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { n } = firstOrThrow(
      await db
        .select({ n: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.accountId, ctx.accountId),
            eq(notifications.userId, ctx.userId),
            isNull(notifications.readAt),
          ),
        ),
    );

    return NextResponse.json({ count: n });
  } catch (err) {
    return toErrorResponse(err);
  }
}

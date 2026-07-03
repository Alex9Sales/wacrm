// ============================================================
// GET /api/conversations/unread-count — number of conversations
// with at least one unread inbound message for the current user.
//
// Feeds the sidebar's green dot on the Inbox nav entry. Replaces the
// browser Supabase read that use-total-unread did directly (client
// code can't touch Drizzle/pg). Scoped to the caller's own rows
// (user_id) AND their account — RLS is gone in Phase 1, so every
// tenant query must filter by accountId explicitly.
//
// Response: { count: number }  (count = conversations, not messages)
// 401 when unauthenticated.
//
// TODO(fase-3): live updates via SSE. For now the client fetches
// once + refetches manually.
// ============================================================

import { NextResponse } from "next/server";
import { and, count, eq, gt } from "drizzle-orm";

import { db, conversations } from "@/db";
import { firstOrThrow } from "@/db/helpers";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { n } = firstOrThrow(
      await db
        .select({ n: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, ctx.accountId),
            eq(conversations.userId, ctx.userId),
            gt(conversations.unreadCount, 0),
          ),
        ),
    );

    return NextResponse.json({ count: n });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ============================================================
// GET /api/tasks/due-alert — count of OPEN tasks that need attention
// (overdue + due today) for the caller's account. Powers the red
// badge on the "Tarefas" sidebar entry.
//
// Client code can't touch Drizzle/pg, so the sidebar hook fetches
// this. Scoped to the caller's account (RLS is gone).
//
// Response: { count: number, overview: { total, open, overdue, dueToday } }
// 401 when unauthenticated.
// ============================================================

import { NextResponse } from 'next/server'

import { getTasksOverview } from '@/app/(dashboard)/tarefas/actions'
import { toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const overview = await getTasksOverview()
    // The badge alerts on anything open that's overdue or due today.
    const count = overview.overdue + overview.dueToday
    return NextResponse.json({ count, overview })
  } catch (err) {
    return toErrorResponse(err)
  }
}

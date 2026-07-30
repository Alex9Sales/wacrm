// ============================================================
// GET /api/tasks/due-alert — count of OPEN tasks that are OVERDUE (past due)
// for the caller's account. Powers the RED badge on the "Tarefas" sidebar
// entry. Red = "vencida" only (matches the Tarefas page: "Prazos vencidos
// aparecem em vermelho") — a task due later TODAY isn't late yet, so it
// doesn't trigger the alert.
//
// Client code can't touch Drizzle/pg, so the sidebar hook fetches this.
// Scoped to the caller's account (RLS is gone).
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
    // Only genuinely overdue tasks light the red badge (not due-today).
    const count = overview.overdue
    return NextResponse.json({ count, overview })
  } catch (err) {
    return toErrorResponse(err)
  }
}

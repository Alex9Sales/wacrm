import { NextResponse } from 'next/server'
import { and, asc, eq, lte } from 'drizzle-orm'
import { db, automationPendingExecutions } from '@/db'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let due
  try {
    due = await db
      .select()
      .from(automationPendingExecutions)
      .where(
        and(
          eq(automationPendingExecutions.status, 'pending'),
          lte(automationPendingExecutions.runAt, new Date().toISOString()),
        ),
      )
      .orderBy(asc(automationPendingExecutions.runAt))
      .limit(50)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const claim = await db
      .update(automationPendingExecutions)
      .set({ status: 'running' })
      .where(
        and(
          eq(automationPendingExecutions.id, row.id),
          eq(automationPendingExecutions.status, 'pending'),
        ),
      )
      .returning({ id: automationPendingExecutions.id })
    if (claim.length === 0) continue

    await resumePendingExecution({
      id: row.id,
      automation_id: row.automationId,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.accountId,
      user_id: row.userId,
      contact_id: row.contactId ?? null,
      log_id: row.logId ?? null,
      parent_step_id: row.parentStepId ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.nextStepPosition,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, flows, flowRuns, flowRunEvents } from '@/db'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  let runs
  try {
    runs = await db
      .select({
        id: flowRuns.id,
        flow_id: flowRuns.flowId,
        user_id: flowRuns.userId,
        contact_id: flowRuns.contactId,
        last_advanced_at: flowRuns.lastAdvancedAt,
        fallback_policy: flows.fallbackPolicy,
      })
      .from(flowRuns)
      .leftJoin(flows, eq(flowRuns.flowId, flows.id))
      .where(eq(flowRuns.status, 'active'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[flows-cron] active-run scan failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (runs.length === 0) return NextResponse.json({ swept: 0 })

  let swept = 0
  for (const r of runs) {
    const policy = resolveFallbackPolicy(r.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const updated = await db
      .update(flowRuns)
      .set({
        status: 'timed_out',
        endedAt: now.toISOString(),
        endReason: 'stale_sweep',
      })
      .where(and(eq(flowRuns.id, r.id), eq(flowRuns.status, 'active')))
      .returning({ id: flowRuns.id })

    if (updated.length > 0) {
      await db.insert(flowRunEvents).values({
        flowRunId: r.id,
        eventType: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept })
}

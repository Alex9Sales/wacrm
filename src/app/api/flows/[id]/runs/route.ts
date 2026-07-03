import { NextResponse } from 'next/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db, flows, flowRuns, flowRunEvents, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/[id]/runs
 *
 * Newest-first list of flow runs for a single flow, with the latest
 * event timeline embedded for each. Used by the run-history viewer
 * page (`/flows/[id]/runs`) to give the owner end-to-end visibility
 * into what the bot did with each customer.
 *
 * Ownership is enforced by scoping the flow lookup (and the run
 * query) to the caller's account.
 *
 * Limited to the 50 most recent runs. Pagination can come later;
 * the dashboard surface here is for debugging, not heavy querying.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await getCurrentAccount()

    // Confirm flow exists + caller's account owns it before doing the
    // run query — gives us a clean 404 instead of empty array.
    const flow = firstOrNull(
      await db
        .select({ id: flows.id, name: flows.name })
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Pull runs + each run's contact name + each run's events. Two
    // queries: the runs (with contact join) + one batch events query.
    const runRows = await db
      .select({
        id: flowRuns.id,
        status: flowRuns.status,
        current_node_key: flowRuns.currentNodeKey,
        started_at: flowRuns.startedAt,
        last_advanced_at: flowRuns.lastAdvancedAt,
        ended_at: flowRuns.endedAt,
        end_reason: flowRuns.endReason,
        vars: flowRuns.vars,
        reprompt_count: flowRuns.repromptCount,
        contact_id: contacts.id,
        contact_name: contacts.name,
        contact_phone: contacts.phone,
      })
      .from(flowRuns)
      .leftJoin(contacts, eq(flowRuns.contactId, contacts.id))
      .where(and(eq(flowRuns.flowId, id), eq(flowRuns.accountId, ctx.accountId)))
      .orderBy(desc(flowRuns.startedAt))
      .limit(50)

    // Rebuild the embedded `contact` object the old PostgREST join
    // (`contact:contacts(id, name, phone)`) produced.
    const runs = runRows.map(({ contact_id, contact_name, contact_phone, ...run }) => ({
      ...run,
      contact: contact_id
        ? { id: contact_id, name: contact_name, phone: contact_phone }
        : null,
    }))

    const runIds = runs.map((r) => r.id)
    let events: Array<{
      flow_run_id: string
      event_type: string
      node_key: string | null
      payload: Record<string, unknown>
      created_at: string
    }> = []
    if (runIds.length > 0) {
      try {
        events = (await db
          .select({
            flow_run_id: flowRunEvents.flowRunId,
            event_type: flowRunEvents.eventType,
            node_key: flowRunEvents.nodeKey,
            payload: flowRunEvents.payload,
            created_at: flowRunEvents.createdAt,
          })
          .from(flowRunEvents)
          .where(inArray(flowRunEvents.flowRunId, runIds))
          .orderBy(asc(flowRunEvents.createdAt))) as typeof events
      } catch (evsErr) {
        // Non-fatal — the page can still show runs without timelines.
        console.error(
          '[flows-runs] events fetch failed:',
          evsErr instanceof Error ? evsErr.message : evsErr,
        )
      }
    }

    return NextResponse.json({
      flow,
      runs,
      events,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

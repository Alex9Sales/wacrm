import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, flows, flowNodes } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { validateFlowForActivation } from '@/lib/flows/validate'

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */

// Snake_case projection matching the old PostgREST `select('*')` shape.
const flowColumns = {
  id: flows.id,
  user_id: flows.userId,
  account_id: flows.accountId,
  name: flows.name,
  description: flows.description,
  status: flows.status,
  trigger_type: flows.triggerType,
  trigger_config: flows.triggerConfig,
  entry_node_id: flows.entryNodeId,
  channel_id: flows.channelId,
  fallback_policy: flows.fallbackPolicy,
  execution_count: flows.executionCount,
  last_executed_at: flows.lastExecutedAt,
  created_at: flows.createdAt,
  updated_at: flows.updatedAt,
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await getCurrentAccount()

    const body = (await request.json().catch(() => null)) as
      | { status?: 'draft' | 'active' | 'archived' }
      | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      return NextResponse.json(
        { error: "status must be one of 'draft' | 'active' | 'archived'" },
        { status: 400 },
      )
    }

    // Account-scoped ownership check.
    const existing = firstOrNull(
      await db
        .select({ id: flows.id })
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (status === 'active') {
      // Re-load with the full payload the validator needs.
      const [flow, nodes] = await Promise.all([
        db
          .select({
            name: flows.name,
            trigger_type: flows.triggerType,
            trigger_config: flows.triggerConfig,
            entry_node_id: flows.entryNodeId,
          })
          .from(flows)
          .where(eq(flows.id, id))
          .limit(1)
          .then(firstOrNull),
        db
          .select({
            node_key: flowNodes.nodeKey,
            node_type: flowNodes.nodeType,
            config: flowNodes.config,
          })
          .from(flowNodes)
          .where(eq(flowNodes.flowId, id)),
      ])
      if (!flow) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const issues = validateFlowForActivation(
        flow as {
          name: string
          trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
          trigger_config: Record<string, unknown>
          entry_node_id: string | null
        },
        nodes as Array<{
          node_key: string
          node_type: string
          config: Record<string, unknown>
        }>,
      )
      const blockers = issues.filter((i) => i.severity === 'error')
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot activate flow — fix the issues below first.',
            issues,
          },
          { status: 422 },
        )
      }
    }

    const updated = firstOrNull(
      await db
        .update(flows)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(flows.id, id))
        .returning(flowColumns),
    )
    return NextResponse.json({ flow: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}

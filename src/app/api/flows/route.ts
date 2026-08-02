import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { db, flows, flowNodes } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getFlowTemplate } from '@/lib/flows/templates'

/**
 * GET /api/flows — list the caller's flows.
 * POST /api/flows — create a new (draft) flow.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
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

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const data = await db
      .select(flowColumns)
      .from(flows)
      .where(eq(flows.accountId, ctx.accountId))
      .orderBy(desc(flows.createdAt))

    return NextResponse.json({ flows: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    // Resolves the caller's account_id — `flows.account_id` is NOT NULL
    // post-017, so an INSERT without it trips the not-null constraint.
    const ctx = await getCurrentAccount()

    const body = (await request.json().catch(() => null)) as
      | {
          name?: string
          description?: string | null
          trigger_type?: 'keyword' | 'first_inbound_message' | 'tag_added' | 'manual'
          trigger_config?: Record<string, unknown>
          /** Optional channel binding (null/omitted = todos os canais). */
          channel_id?: string | null
          /**
           * If set, clone the matching template's name + trigger +
           * entry_node_id + nodes[] into a fresh draft for this user.
           * `name` from the body overrides the template default if
           * provided.
           */
          template_slug?: string
        }
      | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // -------- Template clone path --------
    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug)
      if (!template) {
        return NextResponse.json(
          { error: `Unknown template_slug "${body.template_slug}"` },
          { status: 400 },
        )
      }
      const flow = firstOrThrow(
        await db
          .insert(flows)
          .values({
            userId: ctx.userId,
            accountId: ctx.accountId,
            name: body.name?.trim() || template.name,
            description: template.description,
            status: 'draft',
            triggerType: template.trigger_type,
            triggerConfig: template.trigger_config,
            entryNodeId: template.entry_node_id,
            channelId: typeof body.channel_id === 'string' ? body.channel_id : null,
          })
          .returning(flowColumns),
        'flow insert failed',
      )
      if (template.nodes.length > 0) {
        try {
          await db.insert(flowNodes).values(
            template.nodes.map((n) => ({
              flowId: flow.id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: n.config,
            })),
          )
        } catch (nodesErr) {
          // Roll back the parent flow so a half-cloned template doesn't
          // sit as an empty draft. CASCADE on flow_id removes the
          // (probably zero) nodes too.
          await db.delete(flows).where(eq(flows.id, flow.id))
          return NextResponse.json(
            { error: nodesErr instanceof Error ? nodesErr.message : String(nodesErr) },
            { status: 500 },
          )
        }
      }
      return NextResponse.json({ flow }, { status: 201 })
    }

    // -------- Plain (empty) create path --------
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const trigger_type = body.trigger_type ?? 'keyword'

    const data = firstOrThrow(
      await db
        .insert(flows)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name: body.name.trim(),
          description: body.description ?? null,
          status: 'draft',
          triggerType: trigger_type,
          triggerConfig: body.trigger_config ?? {},
          channelId: typeof body.channel_id === 'string' ? body.channel_id : null,
        })
        .returning(flowColumns),
      'insert failed',
    )
    return NextResponse.json({ flow: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

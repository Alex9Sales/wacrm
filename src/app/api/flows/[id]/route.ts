import { NextResponse } from 'next/server'
import { and, asc, eq, sql } from 'drizzle-orm'
import {
  db,
  flows,
  flowNodes,
  flowRuns,
  flowRunEvents,
  channels,
  member,
  user,
  tags,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes.
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph (delete-then-insert under
 *                          the hood; not atomic, but the runner is
 *                          resilient to mid-edit reads — node_not_found
 *                          gracefully ends the run).
 * DELETE /api/flows/[id] — hard delete (CASCADE cleans up nodes,
 *                          runs, events).
 *
 * All three require a signed-in caller whose account owns the flow.
 * Flows is in soft-GA — the beta gate that previously 404'd non-beta
 * accounts is gone; the "Beta" label in the UI is the only remaining
 * signal.
 */

// Snake_case projections matching the old PostgREST `select('*')` shapes.
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

const flowNodeColumns = {
  id: flowNodes.id,
  flow_id: flowNodes.flowId,
  node_key: flowNodes.nodeKey,
  node_type: flowNodes.nodeType,
  config: flowNodes.config,
  position_x: flowNodes.positionX,
  position_y: flowNodes.positionY,
  created_at: flowNodes.createdAt,
}

/** Account-scoped ownership check — a flow owned by another account
 *  resolves to null (404 in the handlers). */
async function ownsFlow(flowId: string, accountId: string): Promise<boolean> {
  const flow = firstOrNull(
    await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.accountId, accountId)))
      .limit(1),
  )
  return flow !== null
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await getCurrentAccount()

    const [flow, nodes, channelList, memberList, tagList, statRows] =
      await Promise.all([
      db
        .select(flowColumns)
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
        .limit(1)
        .then(firstOrNull),
      db
        .select(flowNodeColumns)
        .from(flowNodes)
        .where(eq(flowNodes.flowId, id))
        .orderBy(asc(flowNodes.createdAt)),
      // Channels for the builder's "Canal" picker. Served here (account-scoped,
      // SAFE fields only) so the client doesn't hit the admin-gated
      // /api/channels — the flow editor is open to every authed user.
      db
        .select({
          id: channels.id,
          name: channels.name,
          provider: channels.provider,
          phone_number: channels.phoneNumber,
        })
        .from(channels)
        .where(eq(channels.accountId, ctx.accountId))
        .orderBy(asc(channels.name)),
      // Members for the handoff node's "Atribuir a" picker. Names only
      // (no emails) — matches the agent/viewer visibility of the members API.
      db
        .select({
          user_id: member.userId,
          full_name: user.name,
          avatar_url: user.image,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, ctx.accountId))
        .orderBy(asc(user.name)),
      // Tags for the tag_added trigger picker + set_tag node.
      db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId))
        .orderBy(asc(tags.name)),
      // Analytics por nó (Fase 3): quantas vezes cada nó ENVIOU uma mensagem e
      // quantas RESPOSTAS chegou nele (toques em botão) — pra CTR estilo ManyChat.
      db
        .select({
          node_key: flowRunEvents.nodeKey,
          event_type: flowRunEvents.eventType,
          n: sql<number>`count(*)::int`,
        })
        .from(flowRunEvents)
        .innerJoin(flowRuns, eq(flowRunEvents.flowRunId, flowRuns.id))
        .where(eq(flowRuns.flowId, id))
        .groupBy(flowRunEvents.nodeKey, flowRunEvents.eventType),
    ])
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    // { node_key: { sent, replies } } — o cliente calcula o CTR (replies/sent).
    const stats: Record<string, { sent: number; replies: number }> = {}
    for (const row of statRows) {
      if (!row.node_key) continue
      const s = (stats[row.node_key] ??= { sent: 0, replies: 0 })
      if (row.event_type === 'message_sent') s.sent += row.n
      else if (row.event_type === 'reply_received') s.replies += row.n
    }
    return NextResponse.json({
      flow,
      nodes,
      channels: channelList,
      members: memberList,
      tags: tagList,
      stats,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'tag_added' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  /** Optional channel binding. null = todos os canais. */
  channel_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await getCurrentAccount()
    if (!(await ownsFlow(id, ctx.accountId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json(
        { error: 'name cannot be empty' },
        { status: 400 },
      )
    }

    // Update the flow row first — the body may not include `nodes` (a
    // header-only save for editing the trigger config without touching
    // the graph). Skip node replacement in that case.
    const flowPatch: Partial<typeof flows.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    }
    if (body.name !== undefined) flowPatch.name = body.name.trim()
    if (body.description !== undefined)
      flowPatch.description = body.description
    if (body.trigger_type !== undefined) flowPatch.triggerType = body.trigger_type
    if (body.trigger_config !== undefined)
      flowPatch.triggerConfig = body.trigger_config
    if (body.entry_node_id !== undefined)
      flowPatch.entryNodeId = body.entry_node_id
    if (body.channel_id !== undefined)
      flowPatch.channelId =
        typeof body.channel_id === 'string' ? body.channel_id : null
    if (body.fallback_policy !== undefined)
      flowPatch.fallbackPolicy = body.fallback_policy

    await db.update(flows).set(flowPatch).where(eq(flows.id, id))

    if (body.nodes !== undefined) {
      // Delete-then-insert. Not transactional but the runner handles
      // mid-edit reads safely (a node_not_found ends the run cleanly).
      await db.delete(flowNodes).where(eq(flowNodes.flowId, id))
      if (body.nodes.length > 0) {
        await db.insert(flowNodes).values(
          body.nodes.map((n) => ({
            flowId: id,
            nodeKey: n.node_key,
            nodeType: n.node_type,
            config: n.config,
            positionX: n.position_x ?? 0,
            positionY: n.position_y ?? 0,
          })),
        )
      }
    }

    // Re-fetch and return the new state — the editor uses the response
    // to reconcile its local form state.
    const [flow, nodes] = await Promise.all([
      db
        .select(flowColumns)
        .from(flows)
        .where(eq(flows.id, id))
        .limit(1)
        .then(firstOrNull),
      db
        .select(flowNodeColumns)
        .from(flowNodes)
        .where(eq(flowNodes.flowId, id))
        .orderBy(asc(flowNodes.createdAt)),
    ])
    return NextResponse.json({ flow, nodes })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await getCurrentAccount()
    if (!(await ownsFlow(id, ctx.accountId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
    // children. Active runs end abruptly — there's no graceful "drain"
    // mechanism in v1, but that's intentional: deleting a flow is a
    // deliberate destructive action and the partial unique index will
    // free up the contact for new triggers immediately.
    await db.delete(flows).where(eq(flows.id, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

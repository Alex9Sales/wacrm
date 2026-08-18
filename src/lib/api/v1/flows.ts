// ============================================================
// Public API (v1) — Flows. CRUD + activate, com paridade ao construtor visual.
// Pensado pra um agente montar automações programaticamente:
//   • os tipos de nó e seus campos estão em FLOW_NODE_CATALOG (node-catalog.ts);
//   • arestas = `node_key` do destino nos campos next_node_key/true_next/etc.;
//   • ativar um fluxo roda a MESMA validação do builder (validateFlowForActivation).
// Tudo escopado por accountId (não há RLS).
// ============================================================

import { and, asc, desc, eq } from 'drizzle-orm'

import { db, flows, flowNodes, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { badRequest } from '@/lib/api/v1/respond'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { isFlowNodeType } from '@/lib/flows/node-catalog'

const TRIGGER_TYPES = [
  'keyword',
  'first_inbound_message',
  'tag_added',
  'manual',
] as const
type TriggerType = (typeof TRIGGER_TYPES)[number]

const STATUSES = ['draft', 'active', 'archived'] as const
type FlowStatus = (typeof STATUSES)[number]

export interface ApiFlowNode {
  node_key: string
  node_type: string
  config: Record<string, unknown>
  position_x: number
  position_y: number
}

export interface ApiFlow {
  id: string
  name: string
  description: string | null
  status: FlowStatus
  trigger_type: TriggerType
  trigger_config: Record<string, unknown>
  entry_node_id: string | null
  channel_id: string | null
  execution_count: number
  created_at: string
  updated_at: string
  nodes?: ApiFlowNode[]
}

export interface FlowWriteInput {
  name?: string
  description?: string | null
  trigger_type?: TriggerType
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  channel_id?: string | null
  status?: FlowStatus
  nodes?: ApiFlowNode[]
}

const summaryCols = {
  id: flows.id,
  name: flows.name,
  description: flows.description,
  status: flows.status,
  trigger_type: flows.triggerType,
  trigger_config: flows.triggerConfig,
  entry_node_id: flows.entryNodeId,
  channel_id: flows.channelId,
  execution_count: flows.executionCount,
  created_at: flows.createdAt,
  updated_at: flows.updatedAt,
}

function rowToFlow(row: Record<string, unknown>): ApiFlow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    status: row.status as FlowStatus,
    trigger_type: row.trigger_type as TriggerType,
    trigger_config: (row.trigger_config as Record<string, unknown>) ?? {},
    entry_node_id: (row.entry_node_id as string | null) ?? null,
    channel_id: (row.channel_id as string | null) ?? null,
    execution_count: (row.execution_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

async function loadNodes(flowId: string): Promise<ApiFlowNode[]> {
  const rows = await db
    .select({
      node_key: flowNodes.nodeKey,
      node_type: flowNodes.nodeType,
      config: flowNodes.config,
      position_x: flowNodes.positionX,
      position_y: flowNodes.positionY,
    })
    .from(flowNodes)
    .where(eq(flowNodes.flowId, flowId))
    .orderBy(asc(flowNodes.createdAt))
  return rows.map((r) => ({
    node_key: r.node_key,
    node_type: r.node_type,
    config: (r.config as Record<string, unknown>) ?? {},
    position_x: r.position_x ?? 0,
    position_y: r.position_y ?? 0,
  }))
}

/** Lista os fluxos da conta (sem os nós — enxuto). Mais novos primeiro. */
export async function listFlows(accountId: string): Promise<ApiFlow[]> {
  const rows = await db
    .select(summaryCols)
    .from(flows)
    .where(eq(flows.accountId, accountId))
    .orderBy(desc(flows.createdAt))
  return rows.map(rowToFlow)
}

/** Um fluxo + seus nós. null se não existe/não é da conta. */
export async function getFlow(
  accountId: string,
  id: string,
): Promise<ApiFlow | null> {
  const row = firstOrNull(
    await db
      .select(summaryCols)
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1),
  )
  if (!row) return null
  const flow = rowToFlow(row)
  flow.nodes = await loadNodes(id)
  return flow
}

/** Normaliza + valida a lista de nós vinda da API. Lança badRequest. */
function normalizeNodes(input: unknown): ApiFlowNode[] {
  if (!Array.isArray(input)) {
    throw badRequest("'nodes' deve ser uma lista.")
  }
  const seen = new Set<string>()
  const out: ApiFlowNode[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      throw badRequest('Cada nó deve ser um objeto.')
    }
    const n = raw as Record<string, unknown>
    const nodeKey = typeof n.node_key === 'string' ? n.node_key.trim() : ''
    if (!nodeKey) throw badRequest('Cada nó precisa de um node_key.')
    if (seen.has(nodeKey)) {
      throw badRequest(`node_key duplicado: '${nodeKey}'.`)
    }
    seen.add(nodeKey)
    if (!isFlowNodeType(n.node_type)) {
      throw badRequest(
        `node_type inválido em '${nodeKey}': '${String(n.node_type)}'. Veja GET /api/v1/flows/node-types.`,
      )
    }
    const config =
      n.config && typeof n.config === 'object'
        ? (n.config as Record<string, unknown>)
        : {}
    out.push({
      node_key: nodeKey,
      node_type: n.node_type,
      config,
      position_x: typeof n.position_x === 'number' ? n.position_x : 0,
      position_y: typeof n.position_y === 'number' ? n.position_y : 0,
    })
  }
  return out
}

function assertTrigger(v: unknown): TriggerType {
  if (!TRIGGER_TYPES.includes(v as TriggerType)) {
    throw badRequest(
      `trigger_type inválido. Use um de: ${TRIGGER_TYPES.join(', ')}.`,
    )
  }
  return v as TriggerType
}

async function assertChannel(
  accountId: string,
  channelId: string | null | undefined,
): Promise<string | null> {
  if (!channelId) return null
  const ch = firstOrNull(
    await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.accountId, accountId)))
      .limit(1),
  )
  if (!ch) throw badRequest('channel_id não pertence à conta.')
  return channelId
}

/** Roda a validação de ativação (mesma do builder); lança badRequest com os
 *  problemas se houver erro-bloqueante. */
function assertActivatable(
  flow: {
    name: string
    trigger_type: TriggerType
    trigger_config: Record<string, unknown>
    entry_node_id: string | null
  },
  nodes: ApiFlowNode[],
): void {
  const issues = validateFlowForActivation(flow, nodes)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    throw badRequest(
      'Não dá pra ativar: ' + errors.map((e) => e.message).join(' '),
    )
  }
}

/** Cria um fluxo (+ nós). Se status='active', valida antes. */
export async function createFlow(
  accountId: string,
  userId: string,
  input: FlowWriteInput,
): Promise<ApiFlow> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw badRequest("'name' é obrigatório.")
  const triggerType = input.trigger_type
    ? assertTrigger(input.trigger_type)
    : 'manual'
  const triggerConfig =
    input.trigger_config && typeof input.trigger_config === 'object'
      ? input.trigger_config
      : {}
  const status: FlowStatus = input.status ?? 'draft'
  if (!STATUSES.includes(status)) {
    throw badRequest(`status inválido. Use: ${STATUSES.join(', ')}.`)
  }
  const nodes = input.nodes ? normalizeNodes(input.nodes) : []
  const entryNodeId =
    typeof input.entry_node_id === 'string' ? input.entry_node_id : null
  if (entryNodeId && !nodes.some((n) => n.node_key === entryNodeId)) {
    throw badRequest(`entry_node_id '${entryNodeId}' não é um node_key da lista.`)
  }
  const channelId = await assertChannel(accountId, input.channel_id)

  if (status === 'active') {
    assertActivatable(
      { name, trigger_type: triggerType, trigger_config: triggerConfig, entry_node_id: entryNodeId },
      nodes,
    )
  }

  const created = firstOrNull(
    await db
      .insert(flows)
      .values({
        userId,
        accountId,
        name,
        description: input.description ?? null,
        status,
        triggerType,
        triggerConfig,
        entryNodeId,
        channelId,
      })
      .returning(summaryCols),
  )
  if (!created) throw badRequest('Falha ao criar o fluxo.')
  if (nodes.length > 0) {
    await db.insert(flowNodes).values(
      nodes.map((n) => ({
        flowId: created.id as string,
        nodeKey: n.node_key,
        nodeType: n.node_type,
        config: n.config,
        positionX: n.position_x,
        positionY: n.position_y,
      })),
    )
  }
  const flow = rowToFlow(created)
  flow.nodes = nodes
  return flow
}

/** Atualiza um fluxo (patch parcial). `nodes` presente = substitui o grafo
 *  inteiro. Revalida se o fluxo (novo estado) ficar/estiver ativo. */
export async function updateFlow(
  accountId: string,
  id: string,
  input: FlowWriteInput,
): Promise<ApiFlow | null> {
  const current = firstOrNull(
    await db
      .select(summaryCols)
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1),
  )
  if (!current) return null

  const patch: Partial<typeof flows.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  }
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw badRequest("'name' não pode ser vazio.")
    patch.name = name
  }
  if (input.description !== undefined) patch.description = input.description
  if (input.trigger_type !== undefined) patch.triggerType = assertTrigger(input.trigger_type)
  if (input.trigger_config !== undefined) patch.triggerConfig = input.trigger_config
  if (input.entry_node_id !== undefined) patch.entryNodeId = input.entry_node_id
  if (input.channel_id !== undefined) {
    patch.channelId = await assertChannel(accountId, input.channel_id)
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) {
      throw badRequest(`status inválido. Use: ${STATUSES.join(', ')}.`)
    }
    patch.status = input.status
  }

  const nextNodes =
    input.nodes !== undefined ? normalizeNodes(input.nodes) : null

  // Estado resultante pra validar ativação, se aplicável.
  const resultingStatus = (patch.status ?? current.status) as FlowStatus
  if (resultingStatus === 'active') {
    const name = (patch.name ?? current.name) as string
    const triggerType = (patch.triggerType ?? current.trigger_type) as TriggerType
    const triggerConfig = (patch.triggerConfig ??
      current.trigger_config ??
      {}) as Record<string, unknown>
    const entryNodeId = (patch.entryNodeId ?? current.entry_node_id) as
      | string
      | null
    const nodesForValidation = nextNodes ?? (await loadNodes(id))
    if (entryNodeId && nextNodes && !nextNodes.some((n) => n.node_key === entryNodeId)) {
      throw badRequest(`entry_node_id '${entryNodeId}' não é um node_key da lista.`)
    }
    assertActivatable(
      { name, trigger_type: triggerType, trigger_config: triggerConfig, entry_node_id: entryNodeId },
      nodesForValidation,
    )
  }

  await db.update(flows).set(patch).where(eq(flows.id, id))

  if (nextNodes !== null) {
    await db.delete(flowNodes).where(eq(flowNodes.flowId, id))
    if (nextNodes.length > 0) {
      await db.insert(flowNodes).values(
        nextNodes.map((n) => ({
          flowId: id,
          nodeKey: n.node_key,
          nodeType: n.node_type,
          config: n.config,
          positionX: n.position_x,
          positionY: n.position_y,
        })),
      )
    }
  }

  return getFlow(accountId, id)
}

/** Muda o status (draft/active/archived). Valida ao ativar. */
export async function setFlowStatus(
  accountId: string,
  id: string,
  status: FlowStatus,
): Promise<ApiFlow | null> {
  if (!STATUSES.includes(status)) {
    throw badRequest(`status inválido. Use: ${STATUSES.join(', ')}.`)
  }
  return updateFlow(accountId, id, { status })
}

/** Exclui um fluxo (CASCADE nos nós/execuções). false se não existe. */
export async function deleteFlow(
  accountId: string,
  id: string,
): Promise<boolean> {
  const current = firstOrNull(
    await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1),
  )
  if (!current) return false
  await db.delete(flows).where(eq(flows.id, id))
  return true
}

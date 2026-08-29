// ============================================================
// Fase B — Agregações do medidor de custo da IA (leitura de `ai_usage`).
//
// `ai_usage` guarda só TOKENS; o custo é derivado aqui, POR MODELO, via
// ./pricing (custo 100% local, sem Langfuse). Duas superfícies consomem isto:
//   • Cards do painel de agentes (custo + atendimentos, hoje e mês) — getAgentsUsage.
//   • Painel "Uso de LLM" (série diária, por modelo, por agente, por inbox) — getUsageDashboard.
//
// Fuso do relatório = America/Sao_Paulo (todos os clientes são BR; sem horário de
// verão desde 2019, então o offset fixo -03:00 é exato hoje). Os limites de
// "dia"/"mês" e o agrupamento diário são calculados nesse fuso.
// ============================================================

import { eq, sql } from 'drizzle-orm'

import { db, aiConfigs, channels } from '@/db'
import { costUsd, priceForModel, toBrl, type UsageTokens } from './pricing'

// ============================================================
// Fase 4 — Funil de automação (quanto a IA resolve sozinha). Inspirado no
// painel do fazer.ai/agents. Base = conversas ATIVAS no período. sender_type:
// 'bot' = IA, 'agent' = humano, 'customer' = cliente.
//   • aiEngaged  = a IA mandou ≥1 mensagem (has_bot)
//   • aiResolved = engajada + fechada + NENHUM humano respondeu
//   • transferred= engajada + um humano entrou (respondeu OU a IA foi pausada)
// ============================================================
export interface ResolutionFunnel {
  total: number
  aiEngaged: number
  aiResolved: number
  transferred: number
}

export async function getResolutionFunnel(
  accountId: string,
  days: number,
): Promise<ResolutionFunnel> {
  const d = Math.min(365, Math.max(1, Math.floor(days || 30)))
  const res = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE has_bot)::int AS ai_engaged,
      count(*) FILTER (WHERE has_bot AND status = 'closed' AND NOT has_human)::int AS ai_resolved,
      count(*) FILTER (WHERE has_bot AND (has_human OR ai_off))::int AS transferred
    FROM (
      SELECT c.status,
        c.ai_autoreply_disabled AS ai_off,
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_type = 'bot'
        ) AS has_bot,
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_type = 'agent'
            AND m.is_internal = false
        ) AS has_human
      FROM conversations c
      WHERE c.account_id = ${accountId}
        AND c.last_message_at >= now() - (${d} * interval '1 day')
    ) t
  `)
  const r = res.rows[0] as
    | {
        total?: number
        ai_engaged?: number
        ai_resolved?: number
        transferred?: number
      }
    | undefined
  return {
    total: Number(r?.total ?? 0),
    aiEngaged: Number(r?.ai_engaged ?? 0),
    aiResolved: Number(r?.ai_resolved ?? 0),
    transferred: Number(r?.transferred ?? 0),
  }
}

const REPORT_TZ = 'America/Sao_Paulo'
const BR_OFFSET = '-03:00'

// ---- helpers de data (limites no fuso BR) ----
function brParts(d: Date): { y: string; m: string; d: string } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '01'
  return { y: get('year'), m: get('month'), d: get('day') }
}
/** Meia-noite (BR) do dia que contém `d`, como instante UTC. */
function brDayStart(d: Date): Date {
  const { y, m, d: day } = brParts(d)
  return new Date(`${y}-${m}-${day}T00:00:00${BR_OFFSET}`)
}
/** Meia-noite (BR) do 1º dia do mês que contém `d`. */
function brMonthStart(d: Date): Date {
  const { y, m } = brParts(d)
  return new Date(`${y}-${m}-01T00:00:00${BR_OFFSET}`)
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

// ---- coerção (sum()/count() do Postgres voltam como string/bigint) ----
function n(v: unknown): number {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
interface TokenRow {
  prompt: unknown
  completion: unknown
  cached_read: unknown
  cache_creation: unknown
}
function tokensOf(r: TokenRow): UsageTokens {
  return {
    promptTokens: n(r.prompt),
    completionTokens: n(r.completion),
    cachedReadTokens: n(r.cached_read),
    cacheCreationTokens: n(r.cache_creation),
  }
}

// "Real" = tráfego real (inbox + rascunho + agentes), exclui só o playground de teste.
export type UsageSource = 'real' | 'playground' | 'all'
function sourceCond(source: UsageSource) {
  if (source === 'playground') return sql`AND source = 'playground'`
  if (source === 'real') return sql`AND source <> 'playground'`
  return sql``
}

// ============================================================
// B2 — Totais por agente (hoje + mês) para os cards do painel.
// ============================================================

export interface AgentUsageTotals {
  todayCostUsd: number
  todayCostBrl: number
  monthCostUsd: number
  monthCostBrl: number
  todayConversations: number
  monthConversations: number
}

interface AgentCostRow extends TokenRow {
  agent_id: string
  model: string
  t_prompt: unknown
  t_completion: unknown
  t_cached_read: unknown
  t_cache_creation: unknown
}
interface AgentConvRow {
  agent_id: string
  t_convs: unknown
  m_convs: unknown
}

/**
 * Custo + atendimentos por agente, no MÊS corrente e recorte de HOJE. Uma
 * varredura só do mês (indexada por account+agent), com `FILTER` pra separar
 * hoje. Custo derivado por modelo. Exclui o playground.
 */
export async function getAgentsUsage(
  accountId: string,
): Promise<Record<string, AgentUsageTotals>> {
  const now = new Date()
  const monthStart = brMonthStart(now).toISOString()
  const todayStart = brDayStart(now).toISOString()

  const costRes = await db.execute(sql`
    SELECT agent_id, model,
           sum(prompt_tokens)         FILTER (WHERE created_at >= ${todayStart}::timestamptz) AS t_prompt,
           sum(completion_tokens)     FILTER (WHERE created_at >= ${todayStart}::timestamptz) AS t_completion,
           sum(cached_read_tokens)    FILTER (WHERE created_at >= ${todayStart}::timestamptz) AS t_cached_read,
           sum(cache_creation_tokens) FILTER (WHERE created_at >= ${todayStart}::timestamptz) AS t_cache_creation,
           sum(prompt_tokens)         AS prompt,
           sum(completion_tokens)     AS completion,
           sum(cached_read_tokens)    AS cached_read,
           sum(cache_creation_tokens) AS cache_creation
    FROM ai_usage
    WHERE account_id = ${accountId}
      AND created_at >= ${monthStart}::timestamptz
      AND source <> 'playground'
      AND agent_id IS NOT NULL
    GROUP BY 1, 2
  `)

  const out: Record<string, AgentUsageTotals> = {}
  const ensure = (id: string): AgentUsageTotals =>
    (out[id] ??= {
      todayCostUsd: 0,
      todayCostBrl: 0,
      monthCostUsd: 0,
      monthCostBrl: 0,
      todayConversations: 0,
      monthConversations: 0,
    })

  for (const row of costRes.rows as unknown as AgentCostRow[]) {
    const agg = ensure(row.agent_id)
    agg.monthCostUsd += costUsd(row.model, tokensOf(row))
    agg.todayCostUsd += costUsd(
      row.model,
      tokensOf({
        prompt: row.t_prompt,
        completion: row.t_completion,
        cached_read: row.t_cached_read,
        cache_creation: row.t_cache_creation,
      }),
    )
  }

  const convRes = await db.execute(sql`
    SELECT agent_id,
           count(DISTINCT conversation_id) FILTER (WHERE created_at >= ${todayStart}::timestamptz) AS t_convs,
           count(DISTINCT conversation_id) AS m_convs
    FROM ai_usage
    WHERE account_id = ${accountId}
      AND created_at >= ${monthStart}::timestamptz
      AND source <> 'playground'
      AND agent_id IS NOT NULL
      AND conversation_id IS NOT NULL
    GROUP BY 1
  `)
  for (const row of convRes.rows as unknown as AgentConvRow[]) {
    const agg = ensure(row.agent_id)
    agg.monthConversations = n(row.m_convs)
    agg.todayConversations = n(row.t_convs)
  }

  for (const id of Object.keys(out)) {
    out[id].monthCostBrl = toBrl(out[id].monthCostUsd)
    out[id].todayCostBrl = toBrl(out[id].todayCostUsd)
  }
  return out
}

// ============================================================
// B3 — Painel "Uso de LLM".
// ============================================================

export interface UsageDashboard {
  rangeDays: number
  source: UsageSource
  usdBrlRate: number
  totals: {
    costUsd: number
    costBrl: number
    calls: number
    conversations: number
    promptTokens: number
    completionTokens: number
    cachedReadTokens: number
    cacheCreationTokens: number
  }
  costPerConversationUsd: number
  costPerConversationBrl: number
  daily: { date: string; costUsd: number; costBrl: number; calls: number }[]
  byModel: {
    model: string
    calls: number
    costUsd: number
    promptTokens: number
    completionTokens: number
    /** true = preço é uma ESTIMATIVA (modelo sem preço exato cadastrado). */
    estimated: boolean
  }[]
  byAgent: {
    agentId: string | null
    name: string
    calls: number
    costUsd: number
    conversations: number
  }[]
  byChannel: {
    channelId: string | null
    name: string
    calls: number
    costUsd: number
    conversations: number
  }[]
  status: { open: number; pending: number; closed: number }
  /** Qualidade operacional (conta inteira, pra comparar modelos por QUALIDADE,
   *  não só custo). */
  quality: {
    toolCalls: number
    toolCallsPerConversation: number
    ordersCreated: number
    handoffs: number
    handoffRatePct: number
    aiOnlyConversations: number
    aiOnlyPct: number
  }
}

interface DayModelRow extends TokenRow {
  day: string
  model: string
  calls: unknown
}
interface DimModelRow extends TokenRow {
  dim: string | null
  model: string
  calls: unknown
}
interface DimConvRow {
  dim: string | null
  convs: unknown
}
interface StatusRow {
  status: string
  n: unknown
}

const TOP_N = 8

export async function getUsageDashboard(
  accountId: string,
  opts: { days?: number; source?: UsageSource; agentId?: string | null } = {},
): Promise<UsageDashboard> {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? 30)))
  const source = opts.source ?? 'real'
  const agentId = opts.agentId ?? null

  const now = new Date()
  const todayStart = brDayStart(now)
  const rangeStart = addDays(todayStart, -(days - 1)).toISOString()
  const src = sourceCond(source)
  const agentFilter = agentId ? sql`AND agent_id = ${agentId}::uuid` : sql``

  // 1) por (dia, modelo) → série diária + totais + por modelo.
  const dayModelRes = await db.execute(sql`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${REPORT_TZ}), 'YYYY-MM-DD') AS day,
           model,
           sum(prompt_tokens)         AS prompt,
           sum(completion_tokens)     AS completion,
           sum(cached_read_tokens)    AS cached_read,
           sum(cache_creation_tokens) AS cache_creation,
           count(*)                   AS calls
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
    GROUP BY 1, 2
  `)

  const dayMap = new Map<string, { costUsd: number; calls: number }>()
  const modelMap = new Map<
    string,
    { calls: number; costUsd: number; promptTokens: number; completionTokens: number }
  >()
  const totals = {
    costUsd: 0,
    costBrl: 0,
    calls: 0,
    conversations: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
  }
  for (const row of dayModelRes.rows as unknown as DayModelRow[]) {
    const t = tokensOf(row)
    const c = costUsd(row.model, t)
    const calls = n(row.calls)
    const day = dayMap.get(row.day) ?? { costUsd: 0, calls: 0 }
    day.costUsd += c
    day.calls += calls
    dayMap.set(row.day, day)
    const m = modelMap.get(row.model) ?? {
      calls: 0,
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
    }
    m.calls += calls
    m.costUsd += c
    m.promptTokens += t.promptTokens
    m.completionTokens += t.completionTokens
    modelMap.set(row.model, m)
    totals.costUsd += c
    totals.calls += calls
    totals.promptTokens += t.promptTokens
    totals.completionTokens += t.completionTokens
    totals.cachedReadTokens += t.cachedReadTokens
    totals.cacheCreationTokens += t.cacheCreationTokens
  }
  totals.costBrl = toBrl(totals.costUsd)

  // Série diária preenchida (dias sem uso = 0), na ordem do período.
  const daily: UsageDashboard['daily'] = []
  for (let i = 0; i < days; i++) {
    const dt = addDays(todayStart, -(days - 1) + i)
    const { y, m, d } = brParts(dt)
    const key = `${y}-${m}-${d}`
    const e = dayMap.get(key)
    daily.push({
      date: key,
      costUsd: e?.costUsd ?? 0,
      costBrl: toBrl(e?.costUsd ?? 0),
      calls: e?.calls ?? 0,
    })
  }

  const byModel = Array.from(modelMap.entries())
    .map(([model, v]) => ({ model, ...v, estimated: !priceForModel(model).known }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_N)

  // 2) por agente (id → custo/calls) + conversas distintas.
  const agentCostRes = await db.execute(sql`
    SELECT agent_id AS dim, model,
           sum(prompt_tokens) AS prompt, sum(completion_tokens) AS completion,
           sum(cached_read_tokens) AS cached_read, sum(cache_creation_tokens) AS cache_creation,
           count(*) AS calls
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
    GROUP BY 1, 2
  `)
  const agentConvRes = await db.execute(sql`
    SELECT agent_id AS dim, count(DISTINCT conversation_id) AS convs
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
      AND conversation_id IS NOT NULL
    GROUP BY 1
  `)

  // 3) por canal (inbox).
  const channelCostRes = await db.execute(sql`
    SELECT channel_id AS dim, model,
           sum(prompt_tokens) AS prompt, sum(completion_tokens) AS completion,
           sum(cached_read_tokens) AS cached_read, sum(cache_creation_tokens) AS cache_creation,
           count(*) AS calls
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
    GROUP BY 1, 2
  `)
  const channelConvRes = await db.execute(sql`
    SELECT channel_id AS dim, count(DISTINCT conversation_id) AS convs
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
      AND conversation_id IS NOT NULL
    GROUP BY 1
  `)

  // 4) total de conversas distintas (para custo/conversa).
  const totalConvRes = await db.execute(sql`
    SELECT count(DISTINCT conversation_id) AS convs
    FROM ai_usage
    WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
      AND conversation_id IS NOT NULL
  `)
  totals.conversations = n(
    (totalConvRes.rows as unknown as { convs: unknown }[])[0]?.convs,
  )

  // 5) status das conversas que a IA tocou.
  const statusRes = await db.execute(sql`
    SELECT c.status AS status, count(DISTINCT c.id) AS n
    FROM conversations c
    JOIN ai_usage u ON u.conversation_id = c.id
    WHERE u.account_id = ${accountId} AND u.created_at >= ${rangeStart}::timestamptz ${src} ${agentFilter}
    GROUP BY c.status
  `)
  const status = { open: 0, pending: 0, closed: 0 }
  for (const row of statusRes.rows as unknown as StatusRow[]) {
    if (row.status === 'open') status.open = n(row.n)
    else if (row.status === 'pending') status.pending = n(row.n)
    else if (row.status === 'closed') status.closed = n(row.n)
  }

  // 6) 📊 Qualidade operacional (conta inteira, no período) — pra comparar
  // modelos por QUALIDADE, não só custo. Ignora o filtro de agente de propósito
  // (é saúde geral do atendimento).
  const [toolCallsRes, ordersRes, handoffRes, withHumanRes] = await Promise.all([
    db.execute(sql`
      SELECT count(*) AS n FROM agent_tool_runs
      WHERE account_id = ${accountId} AND created_at >= ${rangeStart}::timestamptz
    `),
    db.execute(sql`
      SELECT count(*) AS n FROM agent_tool_runs r
      JOIN agent_tools t ON t.id = r.tool_id
      WHERE r.account_id = ${accountId} AND r.created_at >= ${rangeStart}::timestamptz
        AND r.status = 'ok' AND t.creates_deal = true
    `),
    db.execute(sql`
      SELECT count(*) AS n FROM messages
      WHERE account_id = ${accountId} AND is_internal = true
        AND content_text LIKE '%Transferido pela IA%'
        AND created_at >= ${rangeStart}::timestamptz
    `),
    db.execute(sql`
      SELECT count(DISTINCT c.id) AS n
      FROM conversations c
      JOIN ai_usage u ON u.conversation_id = c.id
      WHERE u.account_id = ${accountId} AND u.created_at >= ${rangeStart}::timestamptz ${src}
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_type = 'agent' AND m.is_internal = false
        )
    `),
  ])
  const toolCalls = n((toolCallsRes.rows as { n: unknown }[])[0]?.n)
  const ordersCreated = n((ordersRes.rows as { n: unknown }[])[0]?.n)
  const handoffs = n((handoffRes.rows as { n: unknown }[])[0]?.n)
  const withHuman = n((withHumanRes.rows as { n: unknown }[])[0]?.n)
  const convs = totals.conversations
  const aiOnlyConversations = Math.max(0, convs - withHuman)
  const quality = {
    toolCalls,
    toolCallsPerConversation: convs > 0 ? toolCalls / convs : 0,
    ordersCreated,
    handoffs,
    handoffRatePct: convs > 0 ? (handoffs / convs) * 100 : 0,
    aiOnlyConversations,
    aiOnlyPct: convs > 0 ? (aiOnlyConversations / convs) * 100 : 0,
  }

  // Resolve nomes de agentes/canais.
  const agentNames = new Map<string, string>()
  for (const a of await db
    .select({ id: aiConfigs.id, name: aiConfigs.name })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))) {
    agentNames.set(a.id, a.name?.trim() || 'Agente')
  }
  const channelNames = new Map<string, string>()
  for (const c of await db
    .select({ id: channels.id, name: channels.name, phone: channels.phoneNumber })
    .from(channels)
    .where(eq(channels.accountId, accountId))) {
    channelNames.set(c.id, c.name?.trim() || c.phone || 'Canal')
  }

  const byAgent = rollupDim(
    agentCostRes.rows as unknown as DimModelRow[],
    agentConvRes.rows as unknown as DimConvRow[],
    (id) => (id ? (agentNames.get(id) ?? 'Agente') : 'Sem agente'),
  ).map((r) => ({ agentId: r.dim, name: r.name, ...r.vals }))

  const byChannel = rollupDim(
    channelCostRes.rows as unknown as DimModelRow[],
    channelConvRes.rows as unknown as DimConvRow[],
    (id) => (id ? (channelNames.get(id) ?? 'Canal') : 'Sem canal'),
  ).map((r) => ({ channelId: r.dim, name: r.name, ...r.vals }))

  return {
    rangeDays: days,
    source,
    usdBrlRate: totals.costUsd > 0 ? totals.costBrl / totals.costUsd : toBrl(1),
    totals,
    costPerConversationUsd:
      totals.conversations > 0 ? totals.costUsd / totals.conversations : 0,
    costPerConversationBrl:
      totals.conversations > 0 ? totals.costBrl / totals.conversations : 0,
    daily,
    byModel,
    byAgent,
    byChannel,
    status,
    quality,
  }
}

/** Consolida linhas (dim, modelo) em custo/calls por dim + conversas, ordenado por custo. */
function rollupDim(
  costRows: DimModelRow[],
  convRows: DimConvRow[],
  nameOf: (id: string | null) => string,
): { dim: string | null; name: string; vals: { calls: number; costUsd: number; conversations: number } }[] {
  const map = new Map<string, { dim: string | null; calls: number; costUsd: number; conversations: number }>()
  const keyOf = (dim: string | null) => dim ?? '∅'
  for (const row of costRows) {
    const k = keyOf(row.dim)
    const e = map.get(k) ?? { dim: row.dim, calls: 0, costUsd: 0, conversations: 0 }
    e.calls += n(row.calls)
    e.costUsd += costUsd(row.model, tokensOf(row))
    map.set(k, e)
  }
  for (const row of convRows) {
    const k = keyOf(row.dim)
    const e = map.get(k)
    if (e) e.conversations = n(row.convs)
  }
  return Array.from(map.values())
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_N)
    .map((e) => ({
      dim: e.dim,
      name: nameOf(e.dim),
      vals: { calls: e.calls, costUsd: e.costUsd, conversations: e.conversations },
    }))
}

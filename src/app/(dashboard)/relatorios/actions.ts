'use server'

// ============================================================
// Relatórios — dashboard COMERCIAL (estilo RD + guia dos 8 dashboards).
//
// A pergunta que a tela responde: "De tudo que entrou no funil, o que
// virou dinheiro — e onde o resto morreu?".
//
// Duas janelas de dados por período:
//  • COORTE (criadas): negócios com created_at no período → alimenta
//    "Criadas", o funil por etapa (com taxa de perda por etapa) e a
//    conversão. ⚠️ Regra do guia: conversão só conta FECHADOS no
//    denominador (ganhos + perdidos); aberto ainda pode virar venda.
//  • FECHADAS no período (via deal_events, type='status_changed'):
//    datam "Vendas" e "Perdas" pelo dia do fechamento, não da criação
//    — igual ao RD. Alimenta ticket médio, motivos de perda e a
//    performance por responsável.
//
// Visibilidade: agente só enxerga os negócios dele; supervisor+ vê tudo
// da conta (mesma regra do funil — dealReadable em pipelines/actions).
// ============================================================

import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db, deals, member, pipelines, pipelineStages, user } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'

// Brasil não observa horário de verão desde 2019 → offset fixo -03.
const BR_TZ = 'America/Sao_Paulo'

export type ReportPipeline = { id: string; name: string }
export type ReportResponsavel = { id: string; name: string }

export type ReportFilterOptions = {
  pipelines: ReportPipeline[]
  responsaveis: ReportResponsavel[]
  /** Agente não escolhe responsável (só vê os dele). */
  canFilterResponsavel: boolean
  defaultCurrency: string
  defaultPipelineId: string | null
}

export type ComercialFilters = {
  pipelineId: string
  /** id do responsável, ou 'all'. Ignorado p/ agente (força os dele). */
  responsavelId: string
  /** datas YYYY-MM-DD (inclusivas). */
  from: string
  to: string
}

export type FunnelStage = {
  stageId: string
  name: string
  position: number
  total: number
  open: number
  won: number
  lost: number
  openValue: number
  totalValue: number
  /** perdidos / total da etapa (0..1). */
  lossRate: number
  /** true na etapa de MAIOR taxa de perda (destaque do guia). */
  isLossHotspot: boolean
}

export type TimePoint = { bucket: string; criadas: number; ganhas: number }
export type LossReason = { reason: string; count: number; value: number }
export type ResponsavelRow = {
  id: string
  name: string
  criadas: number
  ganhas: number
  perdidas: number
  valorGanho: number
}

export type ComercialReport = {
  filters: ComercialFilters
  currency: string
  kpis: {
    criadas: number
    valorCriado: number
    vendas: number
    valorVendas: number
    perdas: number
    valorPerdas: number
    /** conversão da coorte, só fechados no denominador (0..1). */
    conversao: number
    ticketMedio: number
    /** valor dos negócios AINDA abertos (coorte). */
    valorEmAberto: number
    abertas: number
  }
  funnel: FunnelStage[]
  timeseries: TimePoint[]
  timeGranularity: 'day' | 'week' | 'month'
  lossReasons: LossReason[]
  responsaveis: ResponsavelRow[]
  /** título-insight gerado dos números (conclusão, não rótulo). */
  insight: string
}

/** Opções dos filtros (funis, responsáveis) + defaults p/ montar a tela. */
export async function listReportFilters(): Promise<ReportFilterOptions> {
  const ctx = await getCurrentAccount()
  const canFilterResponsavel = hasMinRole(ctx.role, 'supervisor')

  const pipes = await db
    .select({ id: pipelines.id, name: pipelines.name })
    .from(pipelines)
    .where(eq(pipelines.accountId, ctx.accountId))
    .orderBy(asc(pipelines.createdAt))

  let responsaveis: ReportResponsavel[] = []
  if (canFilterResponsavel) {
    responsaveis = await db
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId))
      .orderBy(asc(user.name))
  }

  return {
    pipelines: pipes,
    responsaveis,
    canFilterResponsavel,
    defaultCurrency: ctx.defaultCurrency ?? 'BRL',
    defaultPipelineId: pipes[0]?.id ?? null,
  }
}

function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 30
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/** Relatório comercial completo p/ o período/funil/responsável. */
export async function getComercialReport(
  filters: ComercialFilters,
): Promise<ComercialReport> {
  const ctx = await getCurrentAccount()
  const currency = ctx.defaultCurrency ?? 'BRL'

  // Responsável efetivo: agente sempre restrito a si; supervisor+ respeita o filtro.
  const canFilterResponsavel = hasMinRole(ctx.role, 'supervisor')
  const assigneeId = !canFilterResponsavel
    ? ctx.userId
    : filters.responsavelId && filters.responsavelId !== 'all'
      ? filters.responsavelId
      : null

  // Bordas do período em timestamptz no fuso do Brasil (dia inteiro, inclusivo).
  const fromTs = `${filters.from} 00:00:00-03`
  const toTs = `${filters.to} 23:59:59.999-03`

  // Fragmento de filtro reusado nas queries cruas (deal_events).
  const assigneeSqlD = assigneeId ? sql` AND d.assigned_to = ${assigneeId}` : sql``

  // Condições Drizzle p/ a coorte (deals criados no período).
  const cohortWhere = [
    eq(deals.accountId, ctx.accountId),
    eq(deals.pipelineId, filters.pipelineId),
    gte(deals.createdAt, fromTs),
    lte(deals.createdAt, toTs),
  ]
  if (assigneeId) cohortWhere.push(eq(deals.assignedTo, assigneeId))

  // ---- Q1: linhas da coorte (agrego em JS: KPIs, funil, responsáveis) ----
  const cohortRows = await db
    .select({
      id: deals.id,
      value: deals.value,
      status: deals.status,
      stageId: deals.stageId,
      assignedTo: deals.assignedTo,
    })
    .from(deals)
    .where(and(...cohortWhere))

  // ---- Q2: fechadas no período (datadas pelo evento de status) ----
  // DISTINCT ON pega o ÚLTIMO status_changed de cada negócio dentro do período,
  // então um negócio reaberto-e-refechado conta uma vez, pelo desfecho final.
  const closedRes = await db.execute(sql`
    SELECT DISTINCT ON (d.id)
      d.id            AS id,
      d.value         AS value,
      d.assigned_to   AS assigned_to,
      d.lost_reason   AS lost_reason,
      (ev.data->>'to') AS outcome
    FROM deal_events ev
    JOIN deals d ON d.id = ev.deal_id
    WHERE ev.account_id = ${ctx.accountId}
      AND ev.type = 'status_changed'
      AND (ev.data->>'to') IN ('won','lost')
      AND ev.created_at >= ${fromTs}
      AND ev.created_at <= ${toTs}
      AND d.pipeline_id = ${filters.pipelineId}${assigneeSqlD}
    ORDER BY d.id, ev.created_at DESC
  `)
  const closedRows = closedRes.rows as unknown as Array<{
    id: string
    value: string | number
    assigned_to: string | null
    lost_reason: string | null
    outcome: 'won' | 'lost'
  }>

  // ---- Q3: etapas do funil (ordenadas) ----
  const stages = await db
    .select({
      id: pipelineStages.id,
      name: pipelineStages.name,
      position: pipelineStages.position,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, filters.pipelineId))
    .orderBy(asc(pipelineStages.position))

  // ---- Q4: série temporal (criadas por dia/semana/mês) ----
  const days = daysBetween(filters.from, filters.to)
  const gran: 'day' | 'week' | 'month' =
    days <= 45 ? 'day' : days <= 200 ? 'week' : 'month'

  const criadasSeriesRes = await db.execute(sql`
    SELECT to_char(date_trunc(${gran}, created_at AT TIME ZONE ${BR_TZ}), 'YYYY-MM-DD') AS bucket,
           count(*)::int AS n
    FROM deals d
    WHERE d.account_id = ${ctx.accountId}
      AND d.pipeline_id = ${filters.pipelineId}
      AND d.created_at >= ${fromTs}
      AND d.created_at <= ${toTs}${assigneeSqlD}
    GROUP BY 1 ORDER BY 1
  `)
  const ganhasSeriesRes = await db.execute(sql`
    SELECT to_char(date_trunc(${gran}, ev.created_at AT TIME ZONE ${BR_TZ}), 'YYYY-MM-DD') AS bucket,
           count(DISTINCT ev.deal_id)::int AS n
    FROM deal_events ev
    JOIN deals d ON d.id = ev.deal_id
    WHERE ev.account_id = ${ctx.accountId}
      AND ev.type = 'status_changed'
      AND (ev.data->>'to') = 'won'
      AND ev.created_at >= ${fromTs}
      AND ev.created_at <= ${toTs}
      AND d.pipeline_id = ${filters.pipelineId}${assigneeSqlD}
    GROUP BY 1 ORDER BY 1
  `)

  // ---------- agregações em JS ----------

  // KPIs da coorte.
  let criadas = 0
  let valorCriado = 0
  let abertas = 0
  let valorEmAberto = 0
  let ganhosCoorte = 0
  let perdidosCoorte = 0
  // funil: por etapa, contagem por status.
  const byStage = new Map<
    string,
    { total: number; open: number; won: number; lost: number; openValue: number; totalValue: number }
  >()
  // responsáveis: criadas por pessoa.
  const respMap = new Map<string, ResponsavelRow>()
  const ensureResp = (id: string | null): ResponsavelRow => {
    const key = id ?? '—'
    let r = respMap.get(key)
    if (!r) {
      r = { id: key, name: '', criadas: 0, ganhas: 0, perdidas: 0, valorGanho: 0 }
      respMap.set(key, r)
    }
    return r
  }

  for (const row of cohortRows) {
    const v = toNum(row.value)
    criadas += 1
    valorCriado += v
    if (row.status === 'open') {
      abertas += 1
      valorEmAberto += v
    } else if (row.status === 'won') ganhosCoorte += 1
    else if (row.status === 'lost') perdidosCoorte += 1

    const s = byStage.get(row.stageId) ?? {
      total: 0,
      open: 0,
      won: 0,
      lost: 0,
      openValue: 0,
      totalValue: 0,
    }
    s.total += 1
    s.totalValue += v
    if (row.status === 'open') {
      s.open += 1
      s.openValue += v
    } else if (row.status === 'won') s.won += 1
    else if (row.status === 'lost') s.lost += 1
    byStage.set(row.stageId, s)

    ensureResp(row.assignedTo).criadas += 1
  }

  // KPIs de fechamento (datados pelo evento).
  let vendas = 0
  let valorVendas = 0
  let perdas = 0
  let valorPerdas = 0
  const lossMap = new Map<string, LossReason>()
  for (const row of closedRows) {
    const v = toNum(row.value)
    if (row.outcome === 'won') {
      vendas += 1
      valorVendas += v
      ensureResp(row.assigned_to).ganhas += 1
      ensureResp(row.assigned_to).valorGanho += v
    } else {
      perdas += 1
      valorPerdas += v
      ensureResp(row.assigned_to).perdidas += 1
      const reason = (row.lost_reason ?? '').trim() || 'Sem motivo'
      const lr = lossMap.get(reason) ?? { reason, count: 0, value: 0 }
      lr.count += 1
      lr.value += v
      lossMap.set(reason, lr)
    }
  }

  // Conversão (guia): só fechados no denominador.
  const fechadosCoorte = ganhosCoorte + perdidosCoorte
  const conversao = fechadosCoorte > 0 ? ganhosCoorte / fechadosCoorte : 0
  const ticketMedio = vendas > 0 ? valorVendas / vendas : 0

  // Funil por etapa + destaque da maior taxa de perda.
  const funnel: FunnelStage[] = stages.map((st) => {
    const s = byStage.get(st.id)
    const total = s?.total ?? 0
    const lost = s?.lost ?? 0
    return {
      stageId: st.id,
      name: st.name,
      position: st.position,
      total,
      open: s?.open ?? 0,
      won: s?.won ?? 0,
      lost,
      openValue: s?.openValue ?? 0,
      totalValue: s?.totalValue ?? 0,
      lossRate: total > 0 ? lost / total : 0,
      isLossHotspot: false,
    }
  })
  // Hotspot: maior lossRate entre etapas com massa mínima (evita ruído de n=1).
  let hotIdx = -1
  let hotRate = 0
  funnel.forEach((f, i) => {
    if (f.total >= 3 && f.lossRate > hotRate) {
      hotRate = f.lossRate
      hotIdx = i
    }
  })
  if (hotIdx >= 0) funnel[hotIdx].isLossHotspot = true

  // Série temporal: une criadas + ganhas por bucket.
  const tsMap = new Map<string, TimePoint>()
  for (const r of criadasSeriesRes.rows as unknown as Array<{ bucket: string; n: number }>) {
    tsMap.set(r.bucket, { bucket: r.bucket, criadas: toNum(r.n), ganhas: 0 })
  }
  for (const r of ganhasSeriesRes.rows as unknown as Array<{ bucket: string; n: number }>) {
    const p = tsMap.get(r.bucket) ?? { bucket: r.bucket, criadas: 0, ganhas: 0 }
    p.ganhas = toNum(r.n)
    tsMap.set(r.bucket, p)
  }
  const timeseries = [...tsMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))

  // Nomes dos responsáveis (um único SELECT p/ os ids coletados).
  const respIds = [...respMap.keys()].filter((k) => k !== '—')
  if (respIds.length) {
    const names = await db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, respIds))
    const nmeMap = new Map(names.map((n) => [n.id, n.name]))
    for (const [id, r] of respMap) r.name = nmeMap.get(id) ?? r.name
  }
  const respRow = respMap.get('—')
  if (respRow) respRow.name = 'Não atribuído'

  const responsaveis = [...respMap.values()]
    .filter((r) => r.criadas > 0 || r.ganhas > 0 || r.perdidas > 0)
    .sort((a, b) => b.valorGanho - a.valorGanho || b.ganhas - a.ganhas)

  const lossReasons = [...lossMap.values()].sort((a, b) => b.count - a.count)

  const insight = buildInsight({
    criadas,
    vendas,
    valorVendas,
    conversao,
    fechadosCoorte,
    hotspot: hotIdx >= 0 ? funnel[hotIdx] : null,
    currency,
  })

  return {
    filters,
    currency,
    kpis: {
      criadas,
      valorCriado,
      vendas,
      valorVendas,
      perdas,
      valorPerdas,
      conversao,
      ticketMedio,
      valorEmAberto,
      abertas,
    },
    funnel,
    timeseries,
    timeGranularity: gran,
    lossReasons,
    responsaveis,
    insight,
  }
}

/** Frase-conclusão a partir dos números (título-insight do guia). */
function buildInsight(a: {
  criadas: number
  vendas: number
  valorVendas: number
  conversao: number
  fechadosCoorte: number
  hotspot: FunnelStage | null
  currency: string
}): string {
  if (a.criadas === 0 && a.vendas === 0) {
    return 'Sem movimento no período — nenhum negócio criado ou fechado.'
  }
  const pct = Math.round(a.conversao * 100)
  const parts: string[] = []
  parts.push(
    `${a.criadas} ${a.criadas === 1 ? 'negócio criado' : 'negócios criados'}, ` +
      `${a.vendas} ${a.vendas === 1 ? 'venda' : 'vendas'} fechada${a.vendas === 1 ? '' : 's'}.`,
  )
  if (a.fechadosCoorte > 0) {
    parts.push(`Conversão de ${pct}% entre os já encerrados.`)
  }
  if (a.hotspot && a.hotspot.lossRate > 0) {
    parts.push(
      `A etapa "${a.hotspot.name}" concentra a maior perda (${Math.round(a.hotspot.lossRate * 100)}%).`,
    )
  }
  return parts.join(' ')
}

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
import { db, deals, member, pipelines, pipelineStages, salesGoals, user } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { canonReason } from '@/lib/deals/lost-reasons'

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

/** Motivo de perda cruzado com a etapa (Raio-X): "por que morreu AQUI". */
export type StageLossReason = { reason: string; count: number }

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
  // ---- Raio-X do funil (passagem REAL por etapa, reconstruída de eventos) ----
  /** Quantos negócios da coorte PASSARAM por esta etapa (entrada ≤ etapa ≤ topo). */
  reached: number
  /** Quantos seguiram para uma etapa POSTERIOR (avanço real; exclui ganho-em-pé). */
  movedForward: number
  /** movedForward / reached (0..1) — fluxo real para a próxima etapa. */
  forwardRate: number
  /** Quantos GANHARAM nesta etapa (sucesso em pé; nem avanço nem vazamento). */
  wonHere: number
  /** Quantos MORRERAM nesta etapa (etapa carimbada da perda). */
  lostHere: number
  /** lostHere / (avançou+ganhou+morreu-aqui) — taxa de morte entre os resolvidos. */
  deathRate: number
  /** Quantos ABERTOS estão parados nesta etapa (em trânsito). */
  openHere: number
  /** Média de dias que os negócios ABERTOS estão parados nesta etapa (null se 0). */
  avgDaysStalled: number | null
  /** Top motivos de perda DESTA etapa (pela etapa carimbada da morte). */
  lossReasons: StageLossReason[]
  /** true na etapa de MAIOR taxa de morte (o gargalo real do funil). */
  biggestLeak: boolean
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
  /** Meta MENSAL (0 = sem meta). Progresso = valorGanho/ganhas no período. */
  metaValue: number
  metaCount: number
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
      lostReason: deals.lostReason,
      // Raio-X: dias parado na etapa (abertos) usa stage_changed_at (ou createdAt
      // como piso quando o negócio nunca mudou de etapa).
      stageChangedAt: deals.stageChangedAt,
      createdAt: deals.createdAt,
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
    // Desempate estável quando duas etapas têm a mesma position.
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))

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
  // Raio-X: acúmulo de dias parado dos negócios ABERTOS por etapa (motivo×etapa
  // é computado depois, pela etapa CARIMBADA da morte). O "hoje" do cálculo de
  // dias é limitado ao fim do período p/ janelas passadas não inflarem/derivarem.
  const stalledByStage = new Map<string, { sum: number; n: number }>()
  const nowMs = Date.now()
  const refMs = Math.min(nowMs, Date.parse(toTs) || nowMs)
  // responsáveis: criadas por pessoa.
  const respMap = new Map<string, ResponsavelRow>()
  const ensureResp = (id: string | null): ResponsavelRow => {
    const key = id ?? '—'
    let r = respMap.get(key)
    if (!r) {
      r = { id: key, name: '', criadas: 0, ganhas: 0, perdidas: 0, valorGanho: 0, metaValue: 0, metaCount: 0 }
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
      // Dias parado nesta etapa (piso = criação quando nunca mudou de etapa).
      const since = Date.parse(row.stageChangedAt ?? row.createdAt ?? '')
      if (!Number.isNaN(since)) {
        const days = Math.max(0, (refMs - since) / 864e5)
        const acc = stalledByStage.get(row.stageId) ?? { sum: 0, n: 0 }
        acc.sum += days
        acc.n += 1
        stalledByStage.set(row.stageId, acc)
      }
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
      // Agrupa sem caixa/acento ("Não responde" ≡ "nao responde") pra
      // variação de grafia não dividir a contagem; exibe a 1ª grafia vista.
      const reason = (row.lost_reason ?? '').trim() || 'Sem motivo'
      const key = canonReason(reason) || 'sem motivo'
      const lr = lossMap.get(key) ?? { reason, count: 0, value: 0 }
      lr.count += 1
      lr.value += v
      lossMap.set(key, lr)
    }
  }

  // Conversão (guia): só fechados no denominador.
  const fechadosCoorte = ganhosCoorte + perdidosCoorte
  const conversao = fechadosCoorte > 0 ? ganhosCoorte / fechadosCoorte : 0
  const ticketMedio = vendas > 0 ? valorVendas / vendas : 0

  // Raio-X — PASSAGEM REAL por etapa, reconstruída dos EVENTOS do negócio.
  // Inferir passagem pelo snapshot da etapa atual mente em 4 casos: ganho no
  // meio do funil, negócio criado direto numa etapa avançada, card movido pra
  // trás/reaberto e aberto em trânsito. Então, por negócio da coorte, montamos o
  // piso de ENTRADA (evento 'created') e a etapa de DESFECHO (perda carimbada /
  // ganho / atual) e contamos a passagem no intervalo [entrada..desfecho].
  // Trabalha em ÍNDICE via stageId (único) — `position` pode empatar entre
  // etapas. Nome só como último recurso p/ eventos antigos sem id.
  const idxByStageId = new Map(stages.map((st, i) => [st.id, i]))
  const idxByName = new Map(stages.map((st, i) => [st.name, i]))
  const resolveIdx = (id?: string | null, name?: string | null): number | undefined => {
    if (id && idxByStageId.has(id)) return idxByStageId.get(id)
    if (name && idxByName.has(name)) return idxByName.get(name)
    return undefined
  }

  // Estado por negócio da coorte — piso/teto visitados + etapa de desfecho.
  type DealMeta = {
    status: string
    curIdx: number | undefined
    minI: number | undefined // entrada (menor índice visitado)
    maxI: number | undefined // ponto mais avançado alcançado
    deathI: number | undefined // etapa carimbada da perda
    lostReason: string | null
  }
  const meta = new Map<string, DealMeta>()
  for (const row of cohortRows) {
    const curIdx = idxByStageId.get(row.stageId)
    meta.set(row.id, {
      status: row.status ?? 'open',
      curIdx,
      minI: undefined,
      maxI: undefined,
      deathI: row.status === 'lost' ? curIdx : undefined,
      lostReason: row.lostReason ?? null,
    })
  }

  // Eventos de passagem/desfecho da coorte (created + stage_changed + status).
  const passageRes = await db.execute(sql`
    SELECT ev.deal_id AS deal_id, ev.type AS type, ev.data AS data
    FROM deal_events ev
    JOIN deals d ON d.id = ev.deal_id
    WHERE ev.account_id = ${ctx.accountId}
      AND ev.type IN ('created','stage_changed','status_changed')
      AND d.pipeline_id = ${filters.pipelineId}
      AND d.created_at >= ${fromTs}
      AND d.created_at <= ${toTs}${assigneeSqlD}
    ORDER BY ev.deal_id, ev.created_at ASC
  `)
  type EvRow = { deal_id: string; type: string; data: Record<string, unknown> }
  const asStr = (x: unknown) => (typeof x === 'string' ? x : undefined)
  for (const ev of passageRes.rows as unknown as EvRow[]) {
    const m = meta.get(ev.deal_id)
    if (!m) continue
    const d = ev.data ?? {}
    const visit = (idx: number | undefined) => {
      if (idx === undefined) return
      m.minI = m.minI === undefined ? idx : Math.min(m.minI, idx)
      m.maxI = m.maxI === undefined ? idx : Math.max(m.maxI, idx)
    }
    if (ev.type === 'created') {
      visit(resolveIdx(asStr(d.stageId), asStr(d.stage)))
    } else if (ev.type === 'stage_changed') {
      visit(resolveIdx(asStr(d.fromId), asStr(d.from)))
      visit(resolveIdx(asStr(d.toId), asStr(d.to)))
    } else if (ev.type === 'status_changed' && asStr(d.to) === 'lost') {
      // Etapa CARIMBADA da morte (perde-em-pé); o último 'lost' vence.
      const p = resolveIdx(asStr(d.stageId), null)
      if (p !== undefined) m.deathI = p
    }
  }

  // Consolida com o snapshot como rede de segurança (deals sem evento).
  for (const m of meta.values()) {
    if (m.curIdx !== undefined) {
      m.maxI = m.maxI === undefined ? m.curIdx : Math.max(m.maxI, m.curIdx)
      m.minI = m.minI === undefined ? m.curIdx : Math.min(m.minI, m.curIdx)
    }
    if (m.minI === undefined) m.minI = m.maxI
    if (m.status === 'lost' && m.deathI === undefined) m.deathI = m.curIdx ?? m.maxI
  }

  // Contagens de passagem por índice de etapa.
  const N = stages.length
  const reached = new Array<number>(N).fill(0)
  const movedForward = new Array<number>(N).fill(0)
  const wonHere = new Array<number>(N).fill(0)
  const lostHere = new Array<number>(N).fill(0)
  const openHere = new Array<number>(N).fill(0)
  // Motivo de perda pela etapa CARIMBADA da morte (não o snapshot atual).
  const lossByIdx = new Array<Map<string, number> | null>(N).fill(null)

  for (const m of meta.values()) {
    if (m.minI === undefined) continue
    // Etapa de DESFECHO (onde o negócio EFETIVAMENTE parou): perda = etapa
    // carimbada; ganho/aberto = etapa atual; senão o ponto mais avançado. Contar
    // até o desfecho (e não até o max) garante que cada negócio caia em UM único
    // balde terminal — sem duplo-count quando morre antes do topo alcançado.
    let termI = m.status === 'lost' ? m.deathI ?? m.curIdx ?? m.maxI : m.curIdx ?? m.maxI
    if (termI === undefined) termI = m.maxI
    if (termI === undefined) continue
    const entryI = Math.min(m.minI, termI) // entrada nunca depois do desfecho
    for (let i = entryI; i <= termI; i++) {
      reached[i] += 1
      if (i < termI) {
        // Seguiu adiante deste ponto (avanço real).
        movedForward[i] += 1
      } else if (m.status === 'won') {
        // Ganhou aqui: sucesso EM PÉ, não é avanço nem vazamento.
        wonHere[i] += 1
      } else if (m.status === 'lost') {
        // Morreu aqui (etapa carimbada da perda).
        lostHere[i] += 1
        const reason = (m.lostReason ?? '').trim() || 'Sem motivo'
        const rm = lossByIdx[i] ?? new Map<string, number>()
        rm.set(reason, (rm.get(reason) ?? 0) + 1)
        lossByIdx[i] = rm
      } else {
        // Aberto, parado nesta etapa (em trânsito).
        openHere[i] += 1
      }
    }
  }

  // Funil por etapa: snapshot (herói) + Raio-X de passagem (conversão/gargalo).
  const funnel: FunnelStage[] = stages.map((st, i) => {
    const s = byStage.get(st.id)
    const total = s?.total ?? 0
    const lost = s?.lost ?? 0
    const won = s?.won ?? 0
    const rc = reached[i]
    // Fluxo REAL para a próxima etapa (exclui ganho-em-pé e aberto parado).
    const forwardRate = rc > 0 ? movedForward[i] / rc : 0
    // Vazamento = mortes ENTRE os já resolvidos/seguidos nesta etapa
    // (avançou + ganhou + morreu-aqui). Abertos em trânsito ficam de fora — igual
    // à regra "só fechados no denominador" da conversão; evita gargalo falso.
    const decided = movedForward[i] + wonHere[i] + lostHere[i]
    const deathRate = decided > 0 ? lostHere[i] / decided : 0
    const st2 = stalledByStage.get(st.id)
    const avgDaysStalled = st2 && st2.n > 0 ? st2.sum / st2.n : null
    const lm = lossByIdx[i]
    const lossReasons: StageLossReason[] = lm
      ? [...lm.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
      : []
    return {
      stageId: st.id,
      name: st.name,
      position: st.position,
      total,
      open: s?.open ?? 0,
      won,
      lost,
      openValue: s?.openValue ?? 0,
      totalValue: s?.totalValue ?? 0,
      lossRate: total > 0 ? lost / total : 0,
      isLossHotspot: false,
      reached: rc,
      movedForward: movedForward[i],
      forwardRate,
      wonHere: wonHere[i],
      lostHere: lostHere[i],
      deathRate,
      openHere: openHere[i],
      avgDaysStalled,
      lossReasons,
      biggestLeak: false,
    }
  })

  // Gargalo (Raio-X): maior taxa de MORTE-por-etapa entre os já resolvidos, com
  // massa mínima e perda real. Ignora a última (não há "próxima" p/ vazar).
  let leakIdx = -1
  let leakRate = 0
  funnel.forEach((f, i) => {
    const decided = f.movedForward + f.wonHere + f.lostHere
    if (i < funnel.length - 1 && f.lostHere > 0 && decided >= 3 && f.deathRate > leakRate) {
      leakRate = f.deathRate
      leakIdx = i
    }
  })
  // Destaque de perda snapshot (fallback quando não há gargalo claro pelo fluxo).
  let hotIdx = -1
  let hotRate = 0
  funnel.forEach((f, i) => {
    if (f.total >= 3 && f.lossRate > hotRate) {
      hotRate = f.lossRate
      hotIdx = i
    }
  })
  if (leakIdx >= 0) {
    funnel[leakIdx].biggestLeak = true
    // Um único vermelho no relatório: o herói aponta a MESMA etapa do gargalo.
    funnel[leakIdx].isLossHotspot = true
  } else if (hotIdx >= 0) {
    // Sem gargalo de fluxo: destaca a maior perda (snapshot) nos DOIS cards.
    funnel[hotIdx].isLossHotspot = true
    funnel[hotIdx].biggestLeak = true
  }

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

  // Metas (mensais) por responsável — anexa ao respMap.
  try {
    const goals = await db
      .select({
        userId: salesGoals.userId,
        targetValue: salesGoals.targetValue,
        targetCount: salesGoals.targetCount,
      })
      .from(salesGoals)
      .where(eq(salesGoals.accountId, ctx.accountId))
    const gMap = new Map(goals.map((g) => [g.userId, g]))
    for (const [id, r] of respMap) {
      const g = gMap.get(id)
      if (g) {
        r.metaValue = toNum(g.targetValue)
        r.metaCount = Number(g.targetCount) || 0
      }
    }
  } catch (err) {
    console.error('[relatorios] metas:', err)
  }

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
    leak: leakIdx >= 0 ? funnel[leakIdx] : null,
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
  leak: FunnelStage | null
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
  // Gargalo (Raio-X) tem prioridade: é o "conserte AQUI". Cita a etapa, o % que
  // morre entre os resolvidos e o motivo principal — a conclusão que o vendedor quer.
  if (a.leak && a.leak.deathRate > 0) {
    const top = a.leak.lossReasons[0]
    parts.push(
      `Maior gargalo: "${a.leak.name}" — ${Math.round(a.leak.deathRate * 100)}% dos que passam morrem aqui` +
        (top ? ` (motivo nº1: ${top.reason}).` : '.'),
    )
  } else if (a.hotspot && a.hotspot.lossRate > 0) {
    parts.push(
      `A etapa "${a.hotspot.name}" concentra a maior perda (${Math.round(a.hotspot.lossRate * 100)}%).`,
    )
  }
  return parts.join(' ')
}

// ------------------------------------------------------------
// Metas de venda por responsável (fase 5). 1 meta mensal por pessoa.
// ------------------------------------------------------------
export interface SalesGoalRow {
  user_id: string
  name: string
  target_value: number
  target_count: number
}

/** Membros da conta + a meta de cada um (0 se não tem). */
export async function listSalesGoals(): Promise<SalesGoalRow[]> {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        user_id: user.id,
        name: user.name,
        target_value: salesGoals.targetValue,
        target_count: salesGoals.targetCount,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .leftJoin(
        salesGoals,
        and(eq(salesGoals.userId, user.id), eq(salesGoals.accountId, ctx.accountId)),
      )
      .where(eq(member.organizationId, ctx.accountId))
      .orderBy(asc(user.name))
    return rows.map((r) => ({
      user_id: r.user_id,
      name: r.name ?? '',
      target_value: toNum(r.target_value),
      target_count: Number(r.target_count) || 0,
    }))
  } catch (err) {
    console.error('[listSalesGoals]', err)
    return []
  }
}

/** Define a meta (mensal) de um responsável (supervisor+). */
export async function saveSalesGoal(
  userId: string,
  targetValue: number,
  targetCount: number,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!hasMinRole(ctx.role, 'supervisor')) {
      return { error: 'Sem permissão para definir metas.' }
    }
    const v = Number.isFinite(targetValue) ? Math.max(0, targetValue) : 0
    const c = Number.isFinite(targetCount) ? Math.max(0, Math.trunc(targetCount)) : 0
    await db
      .insert(salesGoals)
      .values({
        accountId: ctx.accountId,
        userId,
        targetValue: String(v),
        targetCount: c,
        createdBy: ctx.userId,
        updatedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [salesGoals.accountId, salesGoals.userId],
        set: { targetValue: String(v), targetCount: c, updatedAt: sql`now()` },
      })
    return { error: null }
  } catch (err) {
    console.error('[saveSalesGoal]', err)
    return { error: 'Falha ao salvar a meta.' }
  }
}

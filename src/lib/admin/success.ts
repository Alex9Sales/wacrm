// ============================================================
// 📈 Painel de SUCESSO DO CLIENTE (/admin/sucesso) — o framework do Rafael
// (24/08) em 4 camadas, medido com o que JÁ está no banco:
//   1. Dinheiro: MRR contratado, novos/cancelados no mês, churn de receita.
//   2. Risco: tempo até o 1º resultado, funil de ativação, parados 14d+.
//   3. Operação: health score 0-100 (pesos-hipótese, com aviso de
//      calibração), chamados de suporte por conta.
//   4. Expansão: contas do plano de entrada com uso alto (lista de upgrade).
// SQL 100% cru e QUALIFICADO (lição do bug da subquery Drizzle de 24/08).
// Honestidade em primeiro lugar: o que depende do gateway em produção
// (NRR recebido, churn involuntário) aparece como "ainda não dá pra medir".
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { PLANS, isPlanKey } from '@/lib/billing/plans'

export interface AccountHealthRow {
  orgId: string
  name: string
  createdAt: string
  status: string
  plan: string | null
  price: number
  /** Dias entre criar a conta e o 1º negócio no funil (null = ainda não). */
  ttvDays: number | null
  activated: boolean
  /** Aha Moment: horas entre criar a conta e a 1ª resposta REAL da IA
   *  (messages.sender_type='bot'). null = a IA nunca respondeu — a conta
   *  pode estar "ativa operacionalmente" (inbox humano) sem nunca ter
   *  experimentado o valor central do produto. */
  iaTtvHours: number | null
  iaActivated: boolean
  channels: number
  contacts: number
  deals: number
  msgs7d: number
  activeUsers7d: number
  modules: number
  modulesTotal: number
  ticketsOpen: number
  /** Dias desde a última atividade (mensagem de agente OU sessão). */
  idleDays: number | null
  health: number
}

export interface SuccessDashboard {
  money: {
    mrr: number
    activeCount: number
    trialCount: number
    trialMrr: number
    newThisMonth: number
    canceledThisMonth: number
    churnedMrr: number
    churnRate: number | null
  }
  activation: {
    /** Funil das contas criadas nos últimos 90 dias. */
    created: number
    withChannel: number
    withContact: number
    withDeal: number
    /** Mediana de dias até o 1º negócio (contas que chegaram lá). */
    ttvMedianDays: number | null
  }
  /** Aha Moment (1ª resposta real da IA) — o valor central do produto.
   *  Distinto de "ativa operacionalmente" (inbox humano em uso). */
  aha: {
    /** Contas que alguma vez tiveram resposta da IA. */
    activated: number
    total: number
    /** % das contas que chegaram ao Aha em até 48h da criação. */
    rate48h: number | null
    /** Mediana de horas criação → 1ª resposta da IA (entre as que chegaram). */
    medianTtvHours: number | null
    /** Alerta operacional: contas com +48h de vida e IA NUNCA respondeu. */
    neverActivated: AccountHealthRow[]
  }
  actNow: AccountHealthRow[]
  upgradeReady: AccountHealthRow[]
  accounts: AccountHealthRow[]
}

const MODULES_TOTAL = 8

/** db.execute retorna array OU {rows} conforme o driver — normaliza. */
function toRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const r = (res as { rows?: unknown }).rows
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : []
}

function planPrice(plan: string | null): number {
  if (plan && isPlanKey(plan)) return PLANS[plan].price
  return 0
}

/** Health 0-100 — pesos-HIPÓTESE (ativação 30, frequência 25, profundidade
 *  20, volume 15, pagamento 10). Calibrar quando houver histórico de
 *  cancelamento: a nota das contas 60 dias antes de sair tem que separar quem
 *  saiu de quem ficou. Até lá: ordena a fila de atenção, não decide sozinha. */
function healthScore(r: {
  channels: number
  contacts: number
  deals: number
  msgs7d: number
  idleDays: number | null
  modules: number
  status: string
}): number {
  let activation = 0
  if (r.channels > 0) activation += 10
  if (r.contacts > 0) activation += 5
  if (r.deals > 0) activation += 15

  let frequency = 0
  if (r.idleDays !== null) {
    if (r.idleDays <= 2) frequency = 25
    else if (r.idleDays <= 7) frequency = 18
    else if (r.idleDays <= 14) frequency = 10
    else frequency = 0
  }

  const depth = Math.round((r.modules / MODULES_TOTAL) * 20)

  let volume = 0
  if (r.contacts >= 200) volume = 15
  else if (r.contacts >= 50) volume = 10
  else if (r.contacts >= 10) volume = 5

  let payment = 0
  if (r.status === 'active') payment = 10
  else if (r.status === 'trial') payment = 6

  return Math.min(100, activation + frequency + depth + volume + payment)
}

export async function getSuccessDashboard(): Promise<SuccessDashboard> {
  // Uma linha por conta (billing vivo, sem soft-delete) com TODOS os
  // agregados de uso. Subqueries qualificadas na mão — nada de interpolação
  // de coluna dentro de subquery (gotcha Drizzle 24/08).
  const rows = toRows(await db.execute(sql`
    SELECT
      o.id AS org_id,
      o.name,
      o.created_at,
      b.status,
      b.plan,
      (SELECT count(*)::int FROM channels c WHERE c.account_id = o.id) AS channels,
      (SELECT count(*)::int FROM contacts ct WHERE ct.account_id = o.id) AS contacts,
      (SELECT count(*)::int FROM deals d WHERE d.account_id = o.id) AS deals,
      (SELECT min(d2.created_at) FROM deals d2 WHERE d2.account_id = o.id) AS first_deal_at,
      (SELECT min(mb.created_at) FROM messages mb
        WHERE mb.account_id = o.id AND mb.sender_type = 'bot') AS first_bot_at,
      (SELECT count(*)::int FROM messages m
        WHERE m.account_id = o.id AND m.sender_type <> 'customer'
          AND m.created_at > now() - interval '7 days') AS msgs7d,
      (SELECT max(m2.created_at) FROM messages m2
        WHERE m2.account_id = o.id AND m2.sender_type <> 'customer') AS last_agent_msg,
      (SELECT max(s.updated_at) FROM session s
        WHERE s.active_organization_id = o.id) AS last_session,
      (SELECT count(DISTINCT s2.user_id)::int FROM session s2
        WHERE s2.active_organization_id = o.id
          AND s2.updated_at > now() - interval '7 days') AS active_users_7d,
      (SELECT count(*)::int FROM support_tickets st
        WHERE st.account_id = o.id AND st.status <> 'resolved'
          AND st.created_at > now() - interval '30 days') AS tickets_open,
      ((SELECT count(*) FROM cadences x1 WHERE x1.account_id = o.id) > 0)::int
        + ((SELECT count(*) FROM capture_forms x2 WHERE x2.account_id = o.id) > 0)::int
        + ((SELECT count(*) FROM broadcasts x3 WHERE x3.account_id = o.id) > 0)::int
        + ((SELECT count(*) FROM deal_proposals x4 WHERE x4.account_id = o.id) > 0)::int
        + ((SELECT count(*) FROM schedulers x5 WHERE x5.account_id = o.id) > 0)::int
        + ((SELECT count(*) FROM ai_configs x6 WHERE x6.account_id = o.id) > 0)::int
        AS extra_modules
    FROM organization o
    JOIN organization_billing b ON b.organization_id = o.id
    WHERE b.deleted_at IS NULL AND b.status <> 'canceled'
    ORDER BY o.created_at DESC
  `))

  const now = Date.now()
  const accounts: AccountHealthRow[] = rows.map((r) => {
    const channels = Number(r.channels ?? 0)
    const contacts = Number(r.contacts ?? 0)
    const deals = Number(r.deals ?? 0)
    const msgs7d = Number(r.msgs7d ?? 0)
    const createdAt = String(r.created_at)
    const firstDeal = r.first_deal_at ? new Date(String(r.first_deal_at)).getTime() : null
    const created = new Date(createdAt).getTime()
    const ttvDays = firstDeal
      ? Math.max(0, Math.round((firstDeal - created) / 86_400_000))
      : null
    const firstBot = r.first_bot_at ? new Date(String(r.first_bot_at)).getTime() : null
    const iaTtvHours = firstBot
      ? Math.max(0, Math.round(((firstBot - created) / 3_600_000) * 10) / 10)
      : null
    const lastAgent = r.last_agent_msg ? new Date(String(r.last_agent_msg)).getTime() : null
    const lastSession = r.last_session ? new Date(String(r.last_session)).getTime() : null
    const lastActivity = Math.max(lastAgent ?? 0, lastSession ?? 0) || null
    const idleDays = lastActivity
      ? Math.max(0, Math.round((now - lastActivity) / 86_400_000))
      : null
    // canais + funil (deals) contam como módulos; + os 6 extras da query.
    const modules =
      (channels > 0 ? 1 : 0) + (deals > 0 ? 1 : 0) + Number(r.extra_modules ?? 0)
    const status = String(r.status)
    const base = {
      channels,
      contacts,
      deals,
      msgs7d,
      idleDays,
      modules,
      status,
    }
    return {
      orgId: String(r.org_id),
      name: String(r.name),
      createdAt,
      status,
      plan: (r.plan as string | null) ?? null,
      price: planPrice((r.plan as string | null) ?? null),
      ttvDays,
      activated: channels > 0 && deals > 0,
      iaTtvHours,
      iaActivated: iaTtvHours !== null,
      channels,
      contacts,
      deals,
      msgs7d,
      activeUsers7d: Number(r.active_users_7d ?? 0),
      modules,
      modulesTotal: MODULES_TOTAL,
      ticketsOpen: Number(r.tickets_open ?? 0),
      idleDays,
      health: healthScore(base),
    }
  })

  // ---- Dinheiro (contratado; o RECEBIDO depende do gateway em produção) ----
  const active = accounts.filter((a) => a.status === 'active')
  const trials = accounts.filter((a) => a.status === 'trial')
  const mrr = active.reduce((s, a) => s + a.price, 0)
  const trialMrr = trials.reduce((s, a) => s + (a.price || PLANS.essencial.price), 0)

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthIso = monthStart.toISOString()

  const [monthAgg] = toRows(await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM organization_billing nb
        WHERE nb.created_at >= ${monthIso} AND nb.deleted_at IS NULL) AS new_this_month,
      (SELECT count(*)::int FROM billing_events be
        WHERE be.event = 'canceled' AND be.created_at >= ${monthIso}) AS canceled_this_month,
      (SELECT COALESCE(string_agg(DISTINCT ob.plan, ','), '')
        FROM billing_events be2
        JOIN organization_billing ob ON ob.organization_id = be2.organization_id
        WHERE be2.event = 'canceled' AND be2.created_at >= ${monthIso}) AS canceled_plans
  `))

  const canceledThisMonth = Number(monthAgg?.canceled_this_month ?? 0)
  const churnedMrr = String(monthAgg?.canceled_plans ?? '')
    .split(',')
    .filter(Boolean)
    .reduce((s, p) => s + planPrice(p), 0)
  const baseCount = active.length + canceledThisMonth
  const churnRate = baseCount > 0 ? canceledThisMonth / baseCount : null

  // ---- Ativação (funil das contas dos últimos 90 dias) ----
  const recent = accounts.filter(
    (a) => now - new Date(a.createdAt).getTime() < 90 * 86_400_000,
  )
  const ttvs = accounts
    .map((a) => a.ttvDays)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b)
  const ttvMedianDays = ttvs.length
    ? ttvs[Math.floor(ttvs.length / 2)]
    : null

  // ---- Aha Moment (1ª resposta real da IA) — TTV do valor central ----
  const iaActivatedRows = accounts.filter((a) => a.iaActivated)
  const iaTtvs = iaActivatedRows
    .map((a) => a.iaTtvHours!)
    .sort((a, b) => a - b)
  const within48 = accounts.filter(
    (a) => a.iaTtvHours !== null && a.iaTtvHours <= 48,
  ).length
  const aha = {
    activated: iaActivatedRows.length,
    total: accounts.length,
    rate48h: accounts.length
      ? Math.round((within48 / accounts.length) * 100)
      : null,
    medianTtvHours: iaTtvs.length
      ? iaTtvs[Math.floor(iaTtvs.length / 2)]
      : null,
    neverActivated: accounts
      .filter(
        (a) =>
          !a.iaActivated &&
          now - new Date(a.createdAt).getTime() > 48 * 3_600_000,
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
  }

  // ---- Fila de atenção + expansão ----
  const actNow = accounts
    .filter(
      (a) =>
        (a.status === 'active' || a.status === 'trial') &&
        ((a.idleDays !== null && a.idleDays >= 14) || a.health < 70),
    )
    .sort((a, b) => a.health - b.health)
    .slice(0, 10)

  const upgradeReady = accounts
    .filter(
      (a) =>
        a.status === 'active' &&
        (a.plan === 'essencial' || a.plan === null) &&
        (a.msgs7d >= 300 || a.modules >= 6 || a.activeUsers7d >= 4),
    )
    .sort((a, b) => b.msgs7d - a.msgs7d)
    .slice(0, 10)

  return {
    money: {
      mrr,
      activeCount: active.length,
      trialCount: trials.length,
      trialMrr,
      newThisMonth: Number(monthAgg?.new_this_month ?? 0),
      canceledThisMonth,
      churnedMrr,
      churnRate,
    },
    activation: {
      created: recent.length,
      withChannel: recent.filter((a) => a.channels > 0).length,
      withContact: recent.filter((a) => a.contacts > 0).length,
      withDeal: recent.filter((a) => a.deals > 0).length,
      ttvMedianDays,
    },
    aha,
    actNow,
    upgradeReady,
    accounts,
  }
}

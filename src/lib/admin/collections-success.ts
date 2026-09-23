// ============================================================
// 💰 Sucesso de COBRANÇA (/admin/cobranca) — quanto cada cliente está
// recuperando com a régua e quanto deixou de pagar ao Asaas.
//
// 23/09, ideia do Rafael: "mostrar em números, bem na cara, quanto o cliente
// está tendo de recuperação com a ferramenta e de economia — por dia, mês e
// conta". Serve para a renovação (o cliente vê o retorno antes de reclamar do
// preço) e para o CS saber onde a régua está parada.
//
// Duas regras de honestidade, as duas aprendidas doendo:
//  1. RECUPERADO só conta `status IN ('RECEIVED','CONFIRMED')` — `open=false`
//     também é cobrança APAGADA no Asaas (11/09: R$ 610 de diferença em dois
//     dias). E separa o que foi pago DEPOIS de um toque nosso ("com a régua")
//     do que o cliente pagou sozinho ("sem toque") — a soma dos dois nunca é
//     apresentada como mérito da ferramenta.
//  2. ECONOMIA conta PARCELAS avisadas (o Asaas cobra por cobrança, não por
//     mensagem) e deixa a API oficial de fora: lá quem cobra a conversa é a
//     Meta, então não é economia — é troca de fornecedor.
//
// SQL cru e QUALIFICADO (gotcha Drizzle de 24/08). Server-only via db.
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { CAPABILITIES } from '@/lib/channels/provider'
import { ASAAS_WHATSAPP_FEE_DEFAULT } from '@/lib/collections/rules'

export interface CollectionsAccountRow {
  orgId: string
  name: string
  /** Rótulos das contas do Asaas ligadas. */
  connections: string[]
  ruleEnabled: boolean
  autoSend: boolean
  /** R$ por aviso que o Asaas cobra, como a conta configurou. */
  fee: number
  /** O CRM assumiu os avisos do Asaas (senão a economia é só potencial). */
  notificationsOff: boolean
  recovered: { today: number; month: number; total: number }
  /** Pago sem nenhum toque nosso antes — fica à parte, nunca somado ao mérito. */
  recoveredNoTouch: { month: number; total: number }
  /** Parcelas avisadas pelo CRM (canal NÃO oficial) e o que isso vale em R$. */
  savings: { todayCount: number; todayBrl: number; monthCount: number; monthBrl: number }
  /** Parcelas avisadas pela API oficial no mês (a Meta cobra a conversa). */
  officialMonth: number
  /** Carteira vencida em aberto agora. */
  openValue: number
  openCount: number
}

export interface CollectionsConnectionRow {
  orgId: string
  orgName: string
  connectionId: string
  label: string
  recoveredMonth: number
  savingsMonthCount: number
  savingsMonthBrl: number
  openValue: number
}

export interface CollectionsSuccessDashboard {
  totals: {
    recoveredToday: number
    recoveredMonth: number
    recoveredTotal: number
    savingsMonthBrl: number
    savingsMonthCount: number
    officialMonth: number
    openValue: number
    accounts: number
  }
  accounts: CollectionsAccountRow[]
  connections: CollectionsConnectionRow[]
}

function toRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const r = (res as { rows?: unknown }).rows
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : []
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Provedores de WhatsApp em que a Meta cobra a conversa (template). */
function officialProviders(): string[] {
  return Object.entries(CAPABILITIES)
    .filter(([, c]) => (c as { templates?: boolean }).templates === true)
    .map(([p]) => p)
}

export async function getCollectionsSuccess(): Promise<CollectionsSuccessDashboard> {
  const oficiais = officialProviders()
  const oficiaisSql = sql.join(
    oficiais.map((p) => sql`${p}`),
    sql`, `,
  )
  // Fuso de cada conta: o dia da GoLink fecha 23:59 em São Paulo.
  const tz = sql`coalesce(st.settings->>'businessTimezone', 'America/Sao_Paulo')`
  const inicioDia = sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`
  const inicioMes = sql`(date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`
  // Parcelas de um pedido: a régua junta várias numa mensagem só.
  const parcelas = sql`coalesce((r.payload->>'charges')::int, CASE WHEN jsonb_typeof(r.payload->'lines') = 'array' THEN jsonb_array_length(r.payload->'lines') END, 1)`
  // "Foi cobrada": saiu uma cobrança NOSSA para esse contato antes de a
  // parcela sair da carteira (janela de 45 dias — toque de outro ciclo não
  // vira mérito de hoje).
  const cobrada = sql`EXISTS (
    SELECT 1 FROM agent_action_requests rr
     WHERE rr.account_id = ch.account_id AND rr.contact_id = ch.contact_id
       AND rr.action_type = 'collect_charges' AND rr.status = 'sent'
       AND rr.executed_at < coalesce(ch.closed_at, ch.updated_at)
       AND rr.executed_at > coalesce(ch.closed_at, ch.updated_at) - interval '45 days'
  )`
  const pagas = sql`ch.status IN ('RECEIVED','CONFIRMED')`

  const rows = toRows(
    await db.execute(sql`
      SELECT
        o.id AS org_id,
        o.name,
        coalesce(st.settings->'collections'->>'asaasWhatsAppFee', NULL)::numeric AS fee,
        (st.settings->'collections'->>'enabled' = 'true') AS rule_enabled,
        (st.settings->'collections'->>'autoSend' = 'true') AS auto_send,
        (st.settings->'collections'->>'asaasNotificationsOff' = 'true') AS notifications_off,
        (SELECT array_agg(ac.label ORDER BY ac.created_at)
           FROM asaas_connections ac WHERE ac.account_id = o.id AND ac.enabled) AS connections,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ${pagas} AND ${cobrada}
            AND coalesce(ch.closed_at, ch.updated_at) >= ${inicioDia}) AS rec_today,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ${pagas} AND ${cobrada}
            AND coalesce(ch.closed_at, ch.updated_at) >= ${inicioMes}) AS rec_month,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ${pagas} AND ${cobrada}) AS rec_total,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ${pagas} AND NOT ${cobrada}
            AND coalesce(ch.closed_at, ch.updated_at) >= ${inicioMes}) AS notouch_month,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ${pagas} AND NOT ${cobrada}) AS notouch_total,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ch.open) AS open_value,
        (SELECT count(*)::int FROM asaas_charges ch
          WHERE ch.account_id = o.id AND ch.open) AS open_count,
        (SELECT coalesce(sum(${parcelas}), 0)::int FROM agent_action_requests r
           LEFT JOIN conversations cv ON cv.id = coalesce((r.result->>'conversationId')::uuid, r.conversation_id)
           LEFT JOIN channels chn ON chn.id = cv.channel_id
          WHERE r.account_id = o.id AND r.action_type = 'collect_charges' AND r.status = 'sent'
            AND r.result->'sentVia' ? 'whatsapp'
            AND (chn.provider IS NULL OR chn.provider NOT IN (${oficiaisSql}))
            AND coalesce(r.executed_at, r.created_at) >= ${inicioDia}) AS sav_today,
        (SELECT coalesce(sum(${parcelas}), 0)::int FROM agent_action_requests r
           LEFT JOIN conversations cv ON cv.id = coalesce((r.result->>'conversationId')::uuid, r.conversation_id)
           LEFT JOIN channels chn ON chn.id = cv.channel_id
          WHERE r.account_id = o.id AND r.action_type = 'collect_charges' AND r.status = 'sent'
            AND r.result->'sentVia' ? 'whatsapp'
            AND (chn.provider IS NULL OR chn.provider NOT IN (${oficiaisSql}))
            AND coalesce(r.executed_at, r.created_at) >= ${inicioMes}) AS sav_month,
        (SELECT coalesce(sum(${parcelas}), 0)::int FROM agent_action_requests r
           LEFT JOIN conversations cv ON cv.id = coalesce((r.result->>'conversationId')::uuid, r.conversation_id)
           LEFT JOIN channels chn ON chn.id = cv.channel_id
          WHERE r.account_id = o.id AND r.action_type = 'collect_charges' AND r.status = 'sent'
            AND r.result->'sentVia' ? 'whatsapp'
            AND chn.provider IN (${oficiaisSql})
            AND coalesce(r.executed_at, r.created_at) >= ${inicioMes}) AS official_month
      FROM organization o
      JOIN account_settings st ON st.account_id = o.id
      WHERE EXISTS (SELECT 1 FROM asaas_connections ac2 WHERE ac2.account_id = o.id)
      ORDER BY o.name
    `),
  )

  const accounts: CollectionsAccountRow[] = rows.map((r) => {
    const fee = num(r.fee) > 0 ? num(r.fee) : ASAAS_WHATSAPP_FEE_DEFAULT
    const todayCount = num(r.sav_today)
    const monthCount = num(r.sav_month)
    return {
      orgId: String(r.org_id),
      name: String(r.name ?? ''),
      connections: Array.isArray(r.connections) ? (r.connections as string[]).filter(Boolean) : [],
      ruleEnabled: r.rule_enabled === true,
      autoSend: r.auto_send === true,
      fee,
      notificationsOff: r.notifications_off === true,
      recovered: { today: num(r.rec_today), month: num(r.rec_month), total: num(r.rec_total) },
      recoveredNoTouch: { month: num(r.notouch_month), total: num(r.notouch_total) },
      savings: {
        todayCount,
        todayBrl: Math.round(todayCount * fee * 100) / 100,
        monthCount,
        monthBrl: Math.round(monthCount * fee * 100) / 100,
      },
      officialMonth: num(r.official_month),
      openValue: num(r.open_value),
      openCount: num(r.open_count),
    }
  })

  // Quebra por conta do Asaas — o cliente com duas contas quer ver de cada uma.
  // Pedido sem `connectionId` (régua até 23/09) cai na conta com mais cobranças
  // daquele devedor, igual à faixa do painel do cliente.
  const connRows = toRows(
    await db.execute(sql`
      SELECT
        o.id AS org_id, o.name AS org_name, ac.id AS conn_id, ac.label,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.connection_id = ac.id AND ${pagas} AND ${cobrada}
            AND coalesce(ch.closed_at, ch.updated_at) >= ${inicioMes}) AS rec_month,
        (SELECT coalesce(sum(ch.value), 0) FROM asaas_charges ch
          WHERE ch.connection_id = ac.id AND ch.open) AS open_value,
        (SELECT coalesce(sum(${parcelas}), 0)::int FROM agent_action_requests r
           LEFT JOIN conversations cv ON cv.id = coalesce((r.result->>'conversationId')::uuid, r.conversation_id)
           LEFT JOIN channels chn ON chn.id = cv.channel_id
          WHERE r.account_id = o.id AND r.action_type = 'collect_charges' AND r.status = 'sent'
            AND r.result->'sentVia' ? 'whatsapp'
            AND (chn.provider IS NULL OR chn.provider NOT IN (${oficiaisSql}))
            AND coalesce(
                  r.payload->>'connectionId',
                  (SELECT ch2.connection_id::text FROM asaas_charges ch2
                    WHERE ch2.account_id = r.account_id AND ch2.contact_id = r.contact_id
                    GROUP BY ch2.connection_id ORDER BY count(*) DESC LIMIT 1)
                ) = ac.id::text
            AND coalesce(r.executed_at, r.created_at) >= ${inicioMes}) AS sav_month
      FROM asaas_connections ac
      JOIN organization o ON o.id = ac.account_id
      JOIN account_settings st ON st.account_id = o.id
      WHERE ac.enabled
      ORDER BY o.name, ac.created_at
    `),
  )
  const feeOf = new Map(accounts.map((a) => [a.orgId, a.fee]))
  const connections: CollectionsConnectionRow[] = connRows.map((r) => {
    const orgId = String(r.org_id)
    const fee = feeOf.get(orgId) ?? ASAAS_WHATSAPP_FEE_DEFAULT
    const count = num(r.sav_month)
    return {
      orgId,
      orgName: String(r.org_name ?? ''),
      connectionId: String(r.conn_id),
      label: String(r.label ?? ''),
      recoveredMonth: num(r.rec_month),
      savingsMonthCount: count,
      savingsMonthBrl: Math.round(count * fee * 100) / 100,
      openValue: num(r.open_value),
    }
  })

  const totals = accounts.reduce(
    (acc, a) => ({
      recoveredToday: acc.recoveredToday + a.recovered.today,
      recoveredMonth: acc.recoveredMonth + a.recovered.month,
      recoveredTotal: acc.recoveredTotal + a.recovered.total,
      savingsMonthBrl: Math.round((acc.savingsMonthBrl + a.savings.monthBrl) * 100) / 100,
      savingsMonthCount: acc.savingsMonthCount + a.savings.monthCount,
      officialMonth: acc.officialMonth + a.officialMonth,
      openValue: acc.openValue + a.openValue,
      accounts: acc.accounts + 1,
    }),
    { recoveredToday: 0, recoveredMonth: 0, recoveredTotal: 0, savingsMonthBrl: 0, savingsMonthCount: 0, officialMonth: 0, openValue: 0, accounts: 0 },
  )

  return { totals, accounts, connections }
}

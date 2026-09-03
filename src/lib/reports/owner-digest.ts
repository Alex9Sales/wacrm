// ============================================================
// Sócio IA — resumo diário do funil no WhatsApp do dono.
//
// O dono de PME vive no WhatsApp e quase nunca abre o CRM, então não SENTE o
// valor que já entregamos. Todo dia, numa hora configurável (no fuso da conta),
// a IA sintetiza o essencial — vendas de ontem, valor em aberto, negócios
// esfriando, conversas esperando resposta, meta do mês — e MANDA no WhatsApp
// dele. É a única superfície que fala com o dono onde ele já está.
//
// SEM 'use server' e SEM 'server-only': roda no WORKER (tick) e não pode puxar
// o pacote server-only (derruba o worker — ver memória do crash-loop).
// A config vive no blob account_settings (sem migração); o marcador anti-dup
// (ownerDigestLastSent) é uma CHAVE SEPARADA, escrita só aqui, pra o save da UI
// não sobrescrever.
// ============================================================

import { recommend } from '@/lib/orchestration/nba'
import { eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { organization } from '@/db/schema'
import {
  DEFAULT_ACCOUNT_SETTINGS,
  getAccountSettings,
  updateAccountSettings,
  type AccountSettings,
} from '@/lib/settings/account-settings'
import { listChannels } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { formatCurrency, DEFAULT_CURRENCY } from '@/lib/currency'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']
// Conversa cujo ÚLTIMO evento é do cliente e mais antigo que isto conta como
// "esperando resposta" no resumo.
const WAITING_HOURS = 1

// ------------------------------------------------------------
// Helpers de fuso (espelham tzOffsetMs/zonedSendAt do deal-suggest).
// ------------------------------------------------------------

/** Offset (ms) do fuso `tz` em `date`: (relógio-de-parede lido como UTC) − UTC. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0)
  const asUtc = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour') % 24,
    g('minute'),
    g('second'),
  )
  return asUtc - date.getTime()
}

/** Hora local (0–23) no fuso `tz`, agora. */
function hourInTz(tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
}

/** Data local 'YYYY-MM-DD' no fuso `tz`, agora (chave do anti-duplicação). */
function dateKeyInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** ISO do início do dia local (hoje + `dayOffset`) no fuso `tz`. */
function startOfDayUtc(dayOffset: number, tz: string): string {
  const base = new Date(Date.now() + dayOffset * 86400000)
  const dp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base)
  const g = (t: string) => Number(dp.find((x) => x.type === t)?.value ?? 0)
  const guess = Date.UTC(g('year'), g('month') - 1, g('day'), 0, 0, 0)
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString()
}

/** ISO do início do MÊS local corrente no fuso `tz`. */
function startOfMonthUtc(tz: string): string {
  const dp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const g = (t: string) => Number(dp.find((x) => x.type === t)?.value ?? 0)
  const guess = Date.UTC(g('year'), g('month') - 1, 1, 0, 0, 0)
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString()
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 8
  return Math.min(23, Math.max(0, Math.trunc(h)))
}

// ------------------------------------------------------------
// Métricas do resumo.
// ------------------------------------------------------------

export interface DigestData {
  wonYesterdayCount: number
  wonYesterdayValue: number
  openValue: number
  openCount: number
  staleCount: number
  waitingCount: number
  monthWonValue: number
  monthGoal: number
  // Fase 2: ações da IA esperando aprovação + próximas ações recomendadas (NBA)
  pendingApprovals: number
  nextActions: string[]
}

/** Agrega os sinais do dono para uma conta (account-scoped, sem auth). */
export async function buildDigestData(
  accountId: string,
  tz: string,
  staleDays: number,
): Promise<DigestData> {
  const yStart = startOfDayUtc(-1, tz)
  const tStart = startOfDayUtc(0, tz)
  const mStart = startOfMonthUtc(tz)

  const num = (v: unknown) => Number(v ?? 0)

  const [wonYest, open, stale, waiting, monthWon, goal, approvals, nextSignals] = await Promise.all([
    // Vendas de ONTEM (via deal_events → status_changed → won).
    db.execute(sql`
      SELECT count(*)::int AS n, COALESCE(SUM(value), 0)::float8 AS total FROM (
        SELECT DISTINCT ev.deal_id, d.value
        FROM deal_events ev JOIN deals d ON d.id = ev.deal_id
        WHERE ev.account_id = ${accountId}
          AND ev.type = 'status_changed' AND (ev.data->>'to') = 'won'
          AND ev.created_at >= ${yStart} AND ev.created_at < ${tStart}
      ) x
    `),
    // Valor em aberto (negócios abertos).
    db.execute(sql`
      SELECT count(*)::int AS n, COALESCE(SUM(value), 0)::float8 AS total
      FROM deals WHERE account_id = ${accountId} AND status = 'open'
    `),
    // Esfriando (aberto, não pausado, parado na etapa há >= staleDays).
    staleDays > 0
      ? db.execute(sql`
          SELECT count(*)::int AS n FROM deals
          WHERE account_id = ${accountId} AND status = 'open' AND paused_at IS NULL
            AND COALESCE(stage_changed_at, created_at) <= now() - (${staleDays} * interval '1 day')
        `)
      : Promise.resolve({ rows: [{ n: 0 }] }),
    // Conversas abertas cujo ÚLTIMO evento é do cliente, mais antigo que a janela
    // (>WAITING_HOURS) mas AINDA RECENTE (<24h) — o backlog ACIONÁVEL de hoje.
    // Sem o teto de 24h a conta inflava com centenas de threads velhas/mortas.
    db.execute(sql`
      SELECT count(*)::int AS n FROM conversations c
      JOIN LATERAL (
        SELECT sender_type, created_at FROM messages m
        WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) lm ON true
      WHERE c.account_id = ${accountId} AND c.status = 'open'
        AND lm.sender_type = 'customer'
        AND lm.created_at < now() - (${WAITING_HOURS} * interval '1 hour')
        AND lm.created_at >= now() - interval '24 hours'
    `),
    // Ganho no MÊS corrente.
    db.execute(sql`
      SELECT COALESCE(SUM(value), 0)::float8 AS total FROM (
        SELECT DISTINCT ev.deal_id, d.value
        FROM deal_events ev JOIN deals d ON d.id = ev.deal_id
        WHERE ev.account_id = ${accountId}
          AND ev.type = 'status_changed' AND (ev.data->>'to') = 'won'
          AND ev.created_at >= ${mStart}
      ) x
    `),
    // Meta do time no mês (soma das metas por vendedor).
    db.execute(sql`
      SELECT COALESCE(SUM(target_value), 0)::float8 AS total
      FROM sales_goals WHERE account_id = ${accountId}
    `),
    // Fase 2: fila "Precisa de você".
    db.execute(sql`
      SELECT count(*)::int AS n FROM agent_action_requests
      WHERE account_id = ${accountId} AND status = 'pending'
    `),
    // Fase 2: sinais abertos mais fortes (NBA vira "próximas ações").
    db.execute(sql`
      SELECT s.signal_type, s.severity, s.payload, s.contact_id, s.deal_id,
             c.name AS contact_name, d.title AS deal_title, d.assigned_to, d.conversation_id,
             (p.deal_id IS NOT NULL) AS has_proposal, (p.accepted_at IS NOT NULL) AS proposal_accepted
      FROM customer_signals s
      JOIN contacts c ON c.id = s.contact_id
      LEFT JOIN deals d ON d.id = s.deal_id
      LEFT JOIN deal_proposals p ON p.deal_id = s.deal_id
      WHERE s.account_id = ${accountId} AND s.resolved_at IS NULL
        AND s.signal_type IN ('proposal_idle', 'followup_due', 'stale_deal', 'high_intent', 'churn_risk', 'ticket_declining')
        AND (s.deal_id IS NULL OR d.status = 'open')
      ORDER BY s.severity DESC, s.detected_at DESC
      LIMIT 3
    `),
  ])
  const nextActions: string[] = []
  for (const r of (nextSignals.rows ?? []) as Record<string, unknown>[]) {
    const rec = recommend(
      {
        signalType: String(r.signal_type),
        severity: Number(r.severity) || 0,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        contactId: String(r.contact_id),
        dealId: (r.deal_id as string | null) ?? null,
      },
      {
        hasProposal: r.has_proposal === true,
        proposalAccepted: r.proposal_accepted === true,
        hasConversation: !!r.conversation_id,
        dealAssigned: !!r.assigned_to,
        contactName: (r.contact_name as string | null) ?? null,
        dealTitle: (r.deal_title as string | null) ?? null,
      },
    )
    if (rec) nextActions.push(`${rec.headline} — ${(r.contact_name as string | null) ?? 'cliente'}${r.deal_title ? ` (${r.deal_title})` : ''}`)
  }

  const wy = wonYest.rows[0] as { n?: number; total?: number } | undefined
  const op = open.rows[0] as { n?: number; total?: number } | undefined
  return {
    wonYesterdayCount: num(wy?.n),
    wonYesterdayValue: num(wy?.total),
    openValue: num(op?.total),
    openCount: num(op?.n),
    staleCount: num((stale.rows[0] as { n?: number } | undefined)?.n),
    waitingCount: num((waiting.rows[0] as { n?: number } | undefined)?.n),
    monthWonValue: num((monthWon.rows[0] as { total?: number } | undefined)?.total),
    monthGoal: num((goal.rows[0] as { total?: number } | undefined)?.total),
    pendingApprovals: num((approvals.rows[0] as { n?: number } | undefined)?.n),
    nextActions,
  }
}

// ------------------------------------------------------------
// Texto do resumo (determinístico — sem custo de LLM na v1).
// ------------------------------------------------------------

export function formatDigest(
  data: DigestData,
  currency: string,
  tz: string,
  staleDays: number,
): string {
  // Locale pt-BR fixo (público brasileiro): "R$ 35.599" e não "R$ 35,599".
  const money = (v: number) => {
    try {
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: currency || 'BRL',
        maximumFractionDigits: 0,
      }).format(Number(v) || 0)
    } catch {
      return formatCurrency(v, currency)
    }
  }
  const dateStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
  }).format(new Date())
  const vendas =
    data.wonYesterdayCount === 1 ? '1 venda' : `${data.wonYesterdayCount} vendas`
  const negocios = data.openCount === 1 ? '1 negócio' : `${data.openCount} negócios`

  const lines: string[] = [
    `☀️ Bom dia! Seu resumo da Fluxia — ${dateStr}`,
    '',
    `💰 Ontem: ${vendas} · ${money(data.wonYesterdayValue)}`,
    `📊 Em aberto: ${money(data.openValue)} em ${negocios}`,
  ]
  if (staleDays > 0) {
    lines.push(
      data.staleCount > 0
        ? `❄️ Esfriando: ${data.staleCount} negócio(s) parado(s) há +${staleDays} dias`
        : `❄️ Esfriando: nenhum negócio parado 👏`,
    )
  }
  lines.push(
    data.waitingCount > 0
      ? `💬 Esperando resposta (últimas 24h): ${data.waitingCount} conversa(s)`
      : `💬 Nenhum cliente esperando resposta 👏`,
  )
  if (data.monthGoal > 0) {
    const pct = Math.round((data.monthWonValue / data.monthGoal) * 100)
    lines.push(
      `🎯 Meta do mês: ${money(data.monthWonValue)} de ${money(data.monthGoal)} (${pct}%)`,
    )
  }

  // Fase 2: o que a IA quer fazer e precisa de você + próximas ações (NBA).
  if (data.pendingApprovals > 0) {
    lines.push(`🤖 Fluxia: ${data.pendingApprovals} ação(ões) esperando sua aprovação — abra "Precisa de você"`)
  }
  if (data.nextActions.length > 0) {
    lines.push('🎯 Próximas ações que valem a pena hoje:')
    for (const a of data.nextActions) lines.push(`   • ${a}`)
  }
  // Fechamento: aponta o foco do dia sem soar robótico.
  lines.push('')
  if (data.waitingCount > 0) {
    lines.push('Comece o dia pelas conversas que estão esperando — elas esfriam rápido. 💜')
  } else if (data.staleCount > 0 && staleDays > 0) {
    lines.push('Que tal dar um toque nos negócios parados hoje? Um empurrãozinho reaquece. 💜')
  } else {
    lines.push('Tá voando! Bom dia e boas vendas. 💜')
  }
  return lines.join('\n')
}

// ------------------------------------------------------------
// Envio + sweep (chamado pelo worker).
// ------------------------------------------------------------

async function accountCurrency(accountId: string): Promise<string> {
  const row = firstOrNull(
    await db
      .select({ c: organization.default_currency })
      .from(organization)
      .where(eq(organization.id, accountId))
      .limit(1),
  )
  return row?.c || DEFAULT_CURRENCY
}

async function sendDigest(
  accountId: string,
  phone: string,
  channelId: string | null,
  text: string,
): Promise<boolean> {
  const channels = await listChannels(accountId)
  const wa =
    (channelId
      ? channels.find(
          (c) => c.id === channelId && WHATSAPP_PROVIDERS.includes(c.provider),
        )
      : null) ?? channels.find((c) => WHATSAPP_PROVIDERS.includes(c.provider))
  if (!wa) {
    console.warn(`[owner-digest] conta ${accountId} sem canal WhatsApp p/ enviar`)
    return false
  }
  await getProvider(wa.provider).sendText(wa, phone, text)
  return true
}

/** Monta o texto do resumo para a conta AGORA (não envia) — pro preview na UI. */
export async function previewDigest(accountId: string): Promise<string> {
  const s = await getAccountSettings(accountId)
  const tz = s.businessTimezone || 'America/Sao_Paulo'
  const data = await buildDigestData(accountId, tz, s.staleDealDays)
  return formatDigest(data, await accountCurrency(accountId), tz, s.staleDealDays)
}

/** Envia o resumo AGORA pro número configurado (botão "enviar teste"). */
export async function sendDigestNow(
  accountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const s = await getAccountSettings(accountId)
  const phone = (s.ownerDigestPhone ?? '').trim()
  if (!phone) return { ok: false, error: 'Configure o número do WhatsApp primeiro.' }
  const tz = s.businessTimezone || 'America/Sao_Paulo'
  const data = await buildDigestData(accountId, tz, s.staleDealDays)
  const text = formatDigest(data, await accountCurrency(accountId), tz, s.staleDealDays)
  const ok = await sendDigest(accountId, phone, s.ownerDigestChannelId, text)
  return ok
    ? { ok: true }
    : { ok: false, error: 'Nenhum canal WhatsApp conectado para enviar.' }
}

/** Varre as contas com o resumo LIGADO e envia para as que estão na hora certa
 *  (no fuso da conta) e ainda não receberam hoje. Best-effort por conta. */
export async function runOwnerDigestSweep(): Promise<{ sent: number }> {
  const res = await db.execute(sql`
    SELECT account_id, settings FROM account_settings
    WHERE (settings->>'ownerDigestEnabled') = 'true'
  `)
  const rows = res.rows as unknown as Array<{
    account_id: string
    settings: Record<string, unknown> | null
  }>
  let sent = 0
  for (const r of rows) {
    try {
      const s = { ...DEFAULT_ACCOUNT_SETTINGS, ...(r.settings ?? {}) } as AccountSettings
      const phone = (s.ownerDigestPhone ?? '').trim()
      if (!s.ownerDigestEnabled || !phone) continue

      const tz = s.businessTimezone || 'America/Sao_Paulo'
      if (hourInTz(tz) !== clampHour(s.ownerDigestHour)) continue

      const todayKey = dateKeyInTz(tz)
      if (s.ownerDigestLastSent === todayKey) continue // já enviou hoje

      const data = await buildDigestData(r.account_id, tz, s.staleDealDays)
      const currency = await accountCurrency(r.account_id)
      const text = formatDigest(data, currency, tz, s.staleDealDays)
      const ok = await sendDigest(r.account_id, phone, s.ownerDigestChannelId, text)
      if (ok) {
        // Marca SÓ esta chave (updateAccountSettings relê e faz merge → não
        // sobrescreve a config do dono).
        await updateAccountSettings(r.account_id, { ownerDigestLastSent: todayKey })
        sent++
        console.log(`[owner-digest] resumo enviado (conta ${r.account_id})`)
      }
    } catch (err) {
      console.error(`[owner-digest] conta ${r.account_id} falhou:`, err)
    }
  }
  return { sent }
}

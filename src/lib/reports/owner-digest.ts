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
//
// 02/10/2026 (pedido de uma clínica: "todo fim de expediente"): dois modos.
//   • 'hora' (o de sempre): todo dia na hora escolhida, resumo da MANHÃ
//     ("☀️ Bom dia", vendas de ontem).
//   • 'fechamento': em cada dia de expediente, no primeiro tick depois do
//     FECHAMENTO comercial do dia (seg–sex 20h30, sábado 17h…), resumo de HOJE.
//     Dia fechado não tem resumo. Sem expediente configurado cai na hora.
// Os dois listam as transferências da IA PARADAS (lib/alerts/
// transferencias-paradas.ts), e "esperando resposta" passou a ignorar nota
// interna: a conversa transferida pela IA termina numa nota 'bot' interna e,
// antes, nunca contava como esperando.
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
import { localParts } from '@/lib/settings/business-hours'
import { listChannels } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { formatCurrency, DEFAULT_CURRENCY } from '@/lib/currency'
import { markSelfMessage } from '@/lib/ai/self-message'
import { HANDOFF_NOTE_PREFIX } from '@/lib/ai/handoff-pause'
import { clipAtWord } from '@/lib/alerts/alert-text'
import {
  expedienteConfigurado,
  fechamentoDeHoje,
  formatarEspera,
  fusoSeguro,
} from '@/lib/alerts/expediente'
import {
  listarTransferenciasParadas,
  rotuloDoContato,
  type TransferenciaParada,
} from '@/lib/alerts/transferencias-paradas'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']
// Conversa cujo ÚLTIMO evento (não interno) é do cliente e mais antigo que isto
// conta como "esperando resposta" no resumo da manhã.
const WAITING_HOURS = 1
// No fim do dia o corte é menor: quem escreveu às 20h e ninguém respondeu até
// o fechamento está esperando — 15 min só tira o que a IA ainda vai responder.
const WAITING_MINUTES_FIM_DO_DIA = 15
/** Quantas transferências paradas o resumo lista (o resto vira "+N"). */
export const MAX_PARADAS_NO_RESUMO = 8

export type DigestMode = 'hora' | 'fechamento'

/** Valor cru do banco → modo válido ('hora' é o padrão). */
export function toDigestMode(raw: unknown): DigestMode {
  return raw === 'fechamento' ? 'fechamento' : 'hora'
}

/** O modo que vale de fato: 'fechamento' sem expediente configurado cai na
 *  hora (o resumo não pode sumir em silêncio porque alguém desligou o horário
 *  de atendimento — a tela avisa). */
export function modoEfetivo(s: AccountSettings, pedido?: DigestMode): DigestMode {
  const modo = pedido ?? toDigestMode(s.ownerDigestMode)
  return modo === 'fechamento' && expedienteConfigurado(s) ? 'fechamento' : 'hora'
}

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

/** Hora local (0–23) no fuso `tz`, em `now`. */
function hourInTz(tz: string, now: Date = new Date()): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now)
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
}

/** Data local 'YYYY-MM-DD' no fuso `tz`, em `now` (chave do anti-duplicação). */
function dateKeyInTz(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** ISO do início do dia local (hoje + `dayOffset`) no fuso `tz`. */
function startOfDayUtc(dayOffset: number, tz: string, now: Date = new Date()): string {
  const base = new Date(now.getTime() + dayOffset * 86400000)
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
function startOfMonthUtc(tz: string, now: Date = new Date()): string {
  const dp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const g = (t: string) => Number(dp.find((x) => x.type === t)?.value ?? 0)
  const guess = Date.UTC(g('year'), g('month') - 1, 1, 0, 0, 0)
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString()
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 8
  return Math.min(23, Math.max(0, Math.trunc(h)))
}

/**
 * É hora de mandar o resumo desta conta? Puro (o sweep chama a cada 15 min).
 *  • já mandou hoje (ownerDigestLastSent = data local de hoje) → não;
 *  • 'hora': no tick que cai na hora escolhida;
 *  • 'fechamento': dia de expediente e já passou do fechamento de HOJE. Vale
 *    até a meia-noite — um deploy às 20h30 não faz o resumo do dia sumir.
 *    Dia fechado (domingo da clínica) → não.
 */
export function resumoNaHora(
  s: AccountSettings,
  now: Date = new Date(),
): { enviar: boolean; chave: string; modo: DigestMode } {
  const tz = fusoSeguro(s.businessTimezone)
  const chave = dateKeyInTz(tz, now)
  const modo = modoEfetivo(s)
  if (s.ownerDigestLastSent === chave) return { enviar: false, chave, modo }
  if (modo === 'fechamento') {
    const fecha = fechamentoDeHoje(s, now)
    const enviar = fecha != null && localParts(now, tz).minutes >= fecha
    return { enviar, chave, modo }
  }
  return { enviar: hourInTz(tz, now) === clampHour(s.ownerDigestHour), chave, modo }
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
  /** Transferências da IA sem resposta humana (48h), da mais antiga. */
  paradas: TransferenciaParada[]
}

/** O resumo do FIM DO DIA (modo 'fechamento'): números de HOJE no fuso da conta. */
export interface FimDoDiaData {
  /** Conversas com mensagem de cliente hoje (grupo não conta). */
  chegaramHoje: number
  /** Dessas, quantas tiveram resposta (equipe ou IA) depois da 1ª mensagem do dia. */
  respondidasHoje: number
  /** Esperando resposta agora (última mensagem não interna é do cliente). */
  esperandoAgora: number
  /** Transferências da IA ([[HANDOFF]]) feitas hoje. */
  transferenciasHoje: number
  paradas: TransferenciaParada[]
  vendasHojeCount: number
  vendasHojeValor: number
  openValue: number
  openCount: number
  staleCount: number
  monthWonValue: number
  monthGoal: number
  pendingApprovals: number
}

const num = (v: unknown) => Number(v ?? 0)
const primeira = <T>(res: { rows?: unknown[] }): T => ((res.rows ?? [])[0] ?? {}) as T

/**
 * Conversas abertas esperando resposta: a última mensagem NÃO interna é do
 * cliente, mais antiga que `minMinutos` e de no máximo 24h — o backlog
 * ACIONÁVEL (sem o teto de 24h a conta inflava com centenas de threads
 * mortas). Até 02/10 a nota interna contava como "último evento", e a conversa
 * que a IA transferiu (termina numa nota 'bot') nunca aparecia. Grupo não é
 * cliente esperando. O last_message_at (empurrado a cada mensagem do cliente)
 * só recorta pelo índice (conta, última mensagem) com folga de 1h.
 */
function contarEsperando(accountId: string, minMinutos: number) {
  return db.execute(sql`
    SELECT count(*)::int AS n FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id AND ct.is_group = false
    JOIN LATERAL (
      SELECT sender_type, created_at FROM messages m
      WHERE m.conversation_id = c.id AND m.is_internal = false
      ORDER BY m.created_at DESC LIMIT 1
    ) lm ON true
    WHERE c.account_id = ${accountId} AND c.status = 'open'
      AND c.last_message_at >= now() - interval '25 hours'
      AND lm.sender_type = 'customer'
      AND lm.created_at < now() - make_interval(mins => ${minMinutos})
      AND lm.created_at >= now() - interval '24 hours'
  `)
}

/** Vendas (deal_events → status_changed → won) a partir de `de` (e antes de `ate`). */
function vendasEntre(accountId: string, de: string, ate: string | null) {
  return db.execute(sql`
    SELECT count(*)::int AS n, COALESCE(SUM(value), 0)::float8 AS total FROM (
      SELECT DISTINCT ev.deal_id, d.value
      FROM deal_events ev JOIN deals d ON d.id = ev.deal_id
      WHERE ev.account_id = ${accountId}
        AND ev.type = 'status_changed' AND (ev.data->>'to') = 'won'
        AND ev.created_at >= ${de}
        ${ate ? sql`AND ev.created_at < ${ate}` : sql``}
    ) x
  `)
}

/** Funil do momento: em aberto, esfriando, ganho no mês, meta e aprovações. */
async function numerosDoFunil(
  accountId: string,
  tz: string,
  staleDays: number,
  now: Date,
): Promise<Pick<DigestData, 'openValue' | 'openCount' | 'staleCount' | 'monthWonValue' | 'monthGoal' | 'pendingApprovals'>> {
  const mStart = startOfMonthUtc(tz, now)
  const [open, stale, monthWon, goal, approvals] = await Promise.all([
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
    // Ganho no MÊS corrente.
    vendasEntre(accountId, mStart, null),
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
  ])
  const op = primeira<{ n?: number; total?: number }>(open)
  return {
    openValue: num(op.total),
    openCount: num(op.n),
    staleCount: num(primeira<{ n?: number }>(stale).n),
    monthWonValue: num(primeira<{ total?: number }>(monthWon).total),
    monthGoal: num(primeira<{ total?: number }>(goal).total),
    pendingApprovals: num(primeira<{ n?: number }>(approvals).n),
  }
}

/** A lista nunca derruba o resumo: falhou, o resumo sai sem ela (e o log diz). */
async function paradasDaConta(
  accountId: string,
  cfg: Pick<AccountSettings, 'businessHoursEnabled' | 'businessDays' | 'businessTimezone'>,
  now: Date,
): Promise<TransferenciaParada[]> {
  try {
    return await listarTransferenciasParadas(accountId, cfg, { now })
  } catch (err) {
    console.error(`[owner-digest] lista de transferências paradas falhou (conta ${accountId}):`, err)
    return []
  }
}

/** Agrega os sinais do dono para uma conta (account-scoped, sem auth). */
export async function buildDigestData(
  accountId: string,
  tz: string,
  staleDays: number,
  cfg?: Pick<AccountSettings, 'businessHoursEnabled' | 'businessDays' | 'businessTimezone'>,
  now: Date = new Date(),
): Promise<DigestData> {
  const yStart = startOfDayUtc(-1, tz, now)
  const tStart = startOfDayUtc(0, tz, now)
  const expediente = cfg ?? { ...DEFAULT_ACCOUNT_SETTINGS, businessTimezone: tz }

  const [wonYest, funil, waiting, nextSignals, paradas] = await Promise.all([
    // Vendas de ONTEM.
    vendasEntre(accountId, yStart, tStart),
    numerosDoFunil(accountId, tz, staleDays, now),
    contarEsperando(accountId, WAITING_HOURS * 60),
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
    paradasDaConta(accountId, expediente, now),
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

  const wy = primeira<{ n?: number; total?: number }>(wonYest)
  return {
    wonYesterdayCount: num(wy.n),
    wonYesterdayValue: num(wy.total),
    ...funil,
    waitingCount: num(primeira<{ n?: number }>(waiting).n),
    nextActions,
    paradas,
  }
}

/** Os números de HOJE para o resumo do fim do expediente. */
export async function buildFimDoDiaData(
  accountId: string,
  s: AccountSettings,
  now: Date = new Date(),
): Promise<FimDoDiaData> {
  const tz = fusoSeguro(s.businessTimezone)
  const tStart = startOfDayUtc(0, tz, now)
  const [chegaram, transferencias, vendasHoje, funil, waiting, paradas] = await Promise.all([
    // Conversas com mensagem de cliente HOJE e, delas, as que tiveram resposta
    // (equipe ou IA, fora nota interna) depois da 1ª mensagem do dia. O
    // last_message_at só recorta pelo índice: quem escreveu hoje o empurrou.
    db.execute(sql`
      SELECT count(*)::int AS chegaram,
             count(*) FILTER (WHERE x.respondida)::int AS respondidas
      FROM (
        SELECT EXISTS (
                 SELECT 1 FROM messages r
                 WHERE r.conversation_id = c.id AND r.is_internal = false
                   AND r.sender_type IN ('agent', 'bot')
                   AND r.created_at > fm.primeira
               ) AS respondida
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id AND ct.is_group = false
        JOIN LATERAL (
          SELECT min(m.created_at) AS primeira FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
            AND m.is_internal = false AND m.created_at >= ${tStart}
        ) fm ON fm.primeira IS NOT NULL
        WHERE c.account_id = ${accountId} AND c.last_message_at >= ${tStart}
      ) x
    `),
    // Transferências da IA feitas hoje (a nota nasce logo depois da mensagem
    // do cliente, que empurrou o last_message_at).
    db.execute(sql`
      SELECT count(*)::int AS n
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE c.account_id = ${accountId} AND c.last_message_at >= ${tStart}
        AND m.is_internal = true
        AND m.content_text LIKE ${HANDOFF_NOTE_PREFIX + '%'}
        AND m.created_at >= ${tStart}
    `),
    vendasEntre(accountId, tStart, null),
    numerosDoFunil(accountId, tz, s.staleDealDays, now),
    contarEsperando(accountId, WAITING_MINUTES_FIM_DO_DIA),
    paradasDaConta(accountId, s, now),
  ])
  const ch = primeira<{ chegaram?: number; respondidas?: number }>(chegaram)
  const vh = primeira<{ n?: number; total?: number }>(vendasHoje)
  return {
    chegaramHoje: num(ch.chegaram),
    respondidasHoje: num(ch.respondidas),
    esperandoAgora: num(primeira<{ n?: number }>(waiting).n),
    transferenciasHoje: num(primeira<{ n?: number }>(transferencias).n),
    paradas,
    vendasHojeCount: num(vh.n),
    vendasHojeValor: num(vh.total),
    ...funil,
  }
}

// ------------------------------------------------------------
// Texto do resumo (determinístico — sem custo de LLM na v1).
// ------------------------------------------------------------

/** Locale pt-BR fixo (público brasileiro): "R$ 35.599" e não "R$ 35,599". */
function formatarDinheiro(v: number, currency: string): string {
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

/**
 * As transferências paradas, uma por linha: "nome · há 2h · motivo". Até
 * MAX_PARADAS_NO_RESUMO; o resto vira "+N". O tempo é de RELÓGIO (o resumo diz
 * desde quando a pessoa espera; o aviso de parada é que conta expediente).
 */
export function linhasDasParadas(
  paradas: ReadonlyArray<TransferenciaParada>,
  max = MAX_PARADAS_NO_RESUMO,
): string[] {
  if (paradas.length === 0) return []
  const linhas = [`⏰ Transferências da IA sem resposta: ${paradas.length}`]
  for (const t of paradas.slice(0, max)) {
    const motivo = t.motivo ? ` · ${clipAtWord(t.motivo, 60)}` : ''
    linhas.push(`   • ${rotuloDoContato(t)} · há ${formatarEspera(t.minutosRelogio)}${motivo}`)
  }
  const resto = paradas.length - max
  if (resto > 0) linhas.push(`   +${resto} ${resto === 1 ? 'outra' : 'outras'}`)
  return linhas
}

export function formatDigest(
  data: DigestData,
  currency: string,
  tz: string,
  staleDays: number,
): string {
  const money = (v: number) => formatarDinheiro(v, currency)
  const dateStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
  }).format(new Date())
  const vendas =
    data.wonYesterdayCount === 1 ? '1 venda' : `${data.wonYesterdayCount} vendas`
  const negocios = data.openCount === 1 ? '1 negócio' : `${data.openCount} negócios`
  const paradas = data.paradas ?? []

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
  lines.push(...linhasDasParadas(paradas))
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
  if (paradas.length > 0) {
    lines.push('Comece o dia pelas transferências paradas — essas pessoas já pediram alguém da equipe. 💜')
  } else if (data.waitingCount > 0) {
    lines.push('Comece o dia pelas conversas que estão esperando — elas esfriam rápido. 💜')
  } else if (data.staleCount > 0 && staleDays > 0) {
    lines.push('Que tal dar um toque nos negócios parados hoje? Um empurrãozinho reaquece. 💜')
  } else {
    lines.push('Tá voando! Bom dia e boas vendas. 💜')
  }
  return lines.join('\n')
}

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const

/**
 * O resumo do FIM DO DIA (modo 'fechamento'), curto pra ler no WhatsApp.
 * Linha de funil/venda só aparece com número > 0: a clínica que não usa funil
 * não recebe "💰 Vendas hoje: R$ 0" toda noite.
 */
export function formatFimDoDia(
  data: FimDoDiaData,
  currency: string,
  tz: string,
  staleDays: number,
  now: Date = new Date(),
): string {
  const zona = fusoSeguro(tz)
  const money = (v: number) => formatarDinheiro(v, currency)
  const dia = DIAS_DA_SEMANA[localParts(now, zona).day]
  const ddmm = new Intl.DateTimeFormat('pt-BR', { timeZone: zona, day: '2-digit', month: '2-digit' }).format(now)

  const lines: string[] = [`📊 Resumo de hoje, ${dia} ${ddmm}`, '']
  if (data.chegaramHoje > 0) {
    const resp = data.respondidasHoje === 1 ? '1 respondida' : `${data.respondidasHoje} respondidas`
    lines.push(`💬 Conversas que chegaram hoje: ${data.chegaramHoje} · ${resp}`)
  } else {
    lines.push('💬 Nenhuma conversa de cliente hoje')
  }
  lines.push(
    data.esperandoAgora > 0
      ? `⏳ Esperando resposta agora: ${data.esperandoAgora} conversa(s)`
      : '✅ Ninguém esperando resposta agora 👏',
  )
  if (data.transferenciasHoje > 0) {
    lines.push(`🙋 Transferências da IA hoje: ${data.transferenciasHoje}`)
  }
  lines.push(...linhasDasParadas(data.paradas))

  if (data.vendasHojeCount > 0) {
    const vendas = data.vendasHojeCount === 1 ? '1 venda' : `${data.vendasHojeCount} vendas`
    lines.push(
      data.vendasHojeValor > 0
        ? `💰 Hoje: ${vendas} · ${money(data.vendasHojeValor)}`
        : `💰 Hoje: ${vendas}`,
    )
  }
  if (data.openValue > 0) {
    const negocios = data.openCount === 1 ? '1 negócio' : `${data.openCount} negócios`
    lines.push(`📊 Em aberto: ${money(data.openValue)} em ${negocios}`)
  }
  if (staleDays > 0 && data.staleCount > 0) {
    lines.push(`❄️ Esfriando: ${data.staleCount} negócio(s) parado(s) há +${staleDays} dias`)
  }
  if (data.monthGoal > 0) {
    const pct = Math.round((data.monthWonValue / data.monthGoal) * 100)
    lines.push(`🎯 Meta do mês: ${money(data.monthWonValue)} de ${money(data.monthGoal)} (${pct}%)`)
  }
  if (data.pendingApprovals > 0) {
    lines.push(`🤖 Fluxia: ${data.pendingApprovals} ação(ões) esperando sua aprovação — abra "Precisa de você"`)
  }

  lines.push('')
  if (data.paradas.length > 0) {
    lines.push('Vale dar retorno às transferências paradas antes de amanhã. 💜')
  } else if (data.esperandoAgora > 0) {
    lines.push('Quem ficou esperando hoje é o primeiro da fila amanhã. 💜')
  } else {
    lines.push('Dia fechado! Bom descanso. 💜')
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
  // Se o destino for um canal com IA (08/09: resumo mandado do celular do
  // Alex pro número oficial), a IA reconhece o texto e não responde a ele.
  await markSelfMessage(text)
  await getProvider(wa.provider).sendText(wa, phone, text)
  return true
}

/** Monta o texto do resumo no modo pedido (ou no da conta). */
async function montarTexto(
  accountId: string,
  s: AccountSettings,
  modo: DigestMode,
  now: Date = new Date(),
): Promise<string> {
  const tz = fusoSeguro(s.businessTimezone)
  const currency = await accountCurrency(accountId)
  if (modoEfetivo(s, modo) === 'fechamento') {
    const data = await buildFimDoDiaData(accountId, s, now)
    return formatFimDoDia(data, currency, tz, s.staleDealDays, now)
  }
  const data = await buildDigestData(accountId, tz, s.staleDealDays, s, now)
  return formatDigest(data, currency, tz, s.staleDealDays)
}

/** Monta o texto do resumo para a conta AGORA (não envia) — pro preview na UI.
 *  `modo` = o que está escolhido na tela (ainda sem salvar); sem ele, o da conta. */
export async function previewDigest(accountId: string, modo?: DigestMode): Promise<string> {
  const s = await getAccountSettings(accountId)
  return montarTexto(accountId, s, modo ?? toDigestMode(s.ownerDigestMode))
}

/** Envia o resumo AGORA pro número configurado (botão "enviar teste"). */
export async function sendDigestNow(
  accountId: string,
  modo?: DigestMode,
): Promise<{ ok: boolean; error?: string }> {
  const s = await getAccountSettings(accountId)
  const phone = (s.ownerDigestPhone ?? '').trim()
  if (!phone) return { ok: false, error: 'Configure o número do WhatsApp primeiro.' }
  const text = await montarTexto(accountId, s, modo ?? toDigestMode(s.ownerDigestMode))
  const ok = await sendDigest(accountId, phone, s.ownerDigestChannelId, text)
  return ok
    ? { ok: true }
    : { ok: false, error: 'Nenhum canal WhatsApp conectado para enviar.' }
}

/** Varre as contas com o resumo LIGADO e envia para as que estão na hora certa
 *  (no fuso da conta) e ainda não receberam hoje. Best-effort por conta. */
export async function runOwnerDigestSweep(now: Date = new Date()): Promise<{ sent: number }> {
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

      const { enviar, chave, modo } = resumoNaHora(s, now)
      if (!enviar) continue

      const text = await montarTexto(r.account_id, s, modo, now)
      const ok = await sendDigest(r.account_id, phone, s.ownerDigestChannelId, text)
      if (ok) {
        // Marca SÓ esta chave (updateAccountSettings relê e faz merge → não
        // sobrescreve a config do dono).
        await updateAccountSettings(r.account_id, { ownerDigestLastSent: chave })
        sent++
        console.log(`[owner-digest] resumo enviado (conta ${r.account_id}, modo ${modo})`)
      }
    } catch (err) {
      console.error(`[owner-digest] conta ${r.account_id} falhou:`, err)
    }
  }
  return { sent }
}

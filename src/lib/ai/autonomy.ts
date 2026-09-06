// ============================================================
// 🎛️ CDL Fase 8 — Autonomia governada.
// Política POR AÇÃO por agente (ai_configs.autonomy) + fila de aprovação
// (agent_action_requests). v1: ação "reactivation" (reativar cliente).
//   suggest = lista "Chamar de volta" (humano inicia);
//   approve = a IA rascunha e vai pra FILA (humano aprova/edita/recusa);
//   auto    = o follow-up reengaja sozinho no silêncio.
// Sem 'server-only' — alcançável do worker.
// ============================================================

import { planReactivationBatches } from './reactivation-plan'
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'

import { db, aiConfigs, agentActionRequests, contacts, conversations, customerSignals, broadcasts, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { greeting } from '@/lib/cdl/names'
import { ORCH_ACTIONS } from '@/lib/orchestration/policy'

export type AutonomyLevel = 'suggest' | 'approve' | 'auto'

/** Ações governadas hoje (chaves válidas no jsonb ai_configs.autonomy). */
export const AUTONOMY_ACTIONS = ['reactivation'] as const
const LEVELS: AutonomyLevel[] = ['suggest', 'approve', 'auto']

/** Nível de autonomia da ação (default 'suggest'). */
export function autonomyLevel(
  autonomy: unknown,
  action: string,
): AutonomyLevel {
  const v = (autonomy as Record<string, unknown> | null)?.[action]
  return v === 'approve' || v === 'auto' ? v : 'suggest'
}

/** Só deixa passar chaves conhecidas — pro POST do config. Guarda o nível por
 *  ação + as TRAVAS do modo 'auto' (teto diário + linha de envio). */
export function sanitizeAutonomy(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const o =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  for (const action of AUTONOMY_ACTIONS) {
    const v = o[action]
    if (typeof v === 'string' && (LEVELS as string[]).includes(v)) out[action] = v
  }
  const cap = Number(o.reactivationDailyCap)
  if (Number.isFinite(cap) && cap >= 1)
    out.reactivationDailyCap = Math.min(500, Math.floor(cap))
  if (typeof o.reactivationChannelId === 'string' && o.reactivationChannelId.trim())
    out.reactivationChannelId = o.reactivationChannelId.trim()
  if (
    typeof o.reactivationStartsAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.reactivationStartsAt.trim())
  )
    out.reactivationStartsAt = o.reactivationStartsAt.trim()
  const sh = Number(o.reactivationStartHour)
  if (Number.isInteger(sh) && sh >= 0 && sh <= 23) out.reactivationStartHour = sh
  const eh = Number(o.reactivationEndHour)
  if (Number.isInteger(eh) && eh >= 1 && eh <= 24) out.reactivationEndHour = eh
  // 🔁 Chamar de volta pelo mecanismo dos Disparos (06/09): N canais, cada um
  // com o próprio teto diário, e espaçamento em minutos entre mensagens.
  if (Array.isArray(o.reactivationChannels)) {
    const list: { channelId: string; dailyCap: number }[] = []
    for (const item of o.reactivationChannels as unknown[]) {
      const it = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
      const id = typeof it?.channelId === 'string' ? it.channelId.trim() : ''
      const capN = Number(it?.dailyCap)
      if (!id || list.some((l) => l.channelId === id)) continue
      list.push({ channelId: id, dailyCap: Number.isFinite(capN) && capN >= 1 ? Math.min(500, Math.floor(capN)) : 50 })
    }
    if (list.length) out.reactivationChannels = list
  }
  const iv = Number(o.reactivationIntervalMin)
  if (Number.isFinite(iv) && iv >= 1) out.reactivationIntervalMin = Math.min(120, Math.floor(iv))
  // ---- Fase 2: política POR AÇÃO (+ tetos e travas) — ver lib/orchestration/policy.ts
  const actions = o.actions && typeof o.actions === 'object' ? (o.actions as Record<string, unknown>) : null
  if (actions) {
    const clean: Record<string, string> = {}
    for (const act of ORCH_ACTIONS) {
      const v = actions[act]
      if (typeof v === 'string' && (LEVELS as string[]).includes(v)) clean[act] = v
    }
    if (Object.keys(clean).length) out.actions = clean
    // espelha no legado pra telas antigas continuarem certas
    if (clean.reactivation && !out.reactivation) out.reactivation = clean.reactivation
  }
  const caps = o.caps && typeof o.caps === 'object' ? (o.caps as Record<string, unknown>) : null
  if (caps) {
    const clean: Record<string, number> = {}
    for (const act of ORCH_ACTIONS) {
      const n = Number(caps[act])
      if (Number.isFinite(n) && n >= 1) clean[act] = Math.min(500, Math.floor(n))
    }
    if (Object.keys(clean).length) out.caps = clean
  }
  const pct = Number(o.discountAutoMaxPct)
  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) out.discountAutoMaxPct = pct
  if (typeof o.paused === 'boolean') out.paused = o.paused
  const hc = Number(o.humanCooldownHours)
  if (Number.isFinite(hc) && hc >= 0 && hc <= 168) out.humanCooldownHours = hc
  const perDeal = Number(o.maxAutoPerDealPerDay)
  if (Number.isInteger(perDeal) && perDeal >= 1 && perDeal <= 10) out.maxAutoPerDealPerDay = perDeal
  const perDayMsgs = Number(o.maxAutoMessagesPerDay)
  if (Number.isInteger(perDayMsgs) && perDayMsgs >= 1 && perDayMsgs <= 500) out.maxAutoMessagesPerDay = perDayMsgs
  if (typeof o.staleCadenceId === 'string' && o.staleCadenceId.trim()) out.staleCadenceId = o.staleCadenceId.trim()
  return out
}

/** Janela de envio do auto (horas locais [início, fim)). null = sem janela
 *  própria (usa o horário de atendimento / janela-segura). */
export function reactivationWindow(
  autonomy: unknown,
): { start: number; end: number } | null {
  const a = autonomy as Record<string, unknown> | null
  const start = Number(a?.reactivationStartHour)
  const end = Number(a?.reactivationEndHour)
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || start > 23 || end <= start || end > 24) return null
  return { start, end }
}

/** Teto de reativações automáticas por 24h (default 20, máx 500). */
export function reactivationDailyCap(autonomy: unknown): number {
  const v = Number((autonomy as Record<string, unknown> | null)?.reactivationDailyCap)
  return Number.isFinite(v) && v >= 1 ? Math.min(500, Math.floor(v)) : 20
}

/** Linha de WhatsApp pra criar conversa (importado) no modo auto. */
export function reactivationChannelId(autonomy: unknown): string | null {
  const v = (autonomy as Record<string, unknown> | null)?.reactivationChannelId
  return typeof v === 'string' && v ? v : null
}

/** 📅 Data de início do modo auto ("YYYY-MM-DD"). Antes dela, o auto fica
 *  dormente (configurado mas sem enviar). null = começa já. */
/**
 * Canais do "Chamar de volta" com teto diário cada. Sem lista → cai no legado
 * (uma linha + um teto), para contas configuradas antes de 06/09.
 */
export function reactivationChannels(autonomy: unknown): { channelId: string; dailyCap: number }[] {
  const a = autonomy as Record<string, unknown> | null
  const raw = a?.reactivationChannels
  if (Array.isArray(raw) && raw.length) {
    return raw
      .map((x) => x as { channelId?: unknown; dailyCap?: unknown })
      .filter((x) => typeof x.channelId === 'string' && x.channelId)
      .map((x) => ({ channelId: String(x.channelId), dailyCap: Math.max(1, Math.min(500, Number(x.dailyCap) || 50)) }))
  }
  const legacy = reactivationChannelId(autonomy)
  return legacy ? [{ channelId: legacy, dailyCap: reactivationDailyCap(autonomy) }] : []
}

/** Minutos entre uma mensagem e a próxima no mesmo canal (padrão 8, como o Alex usa nos Disparos). */
export function reactivationIntervalMin(autonomy: unknown): number {
  const v = Number((autonomy as Record<string, unknown> | null)?.reactivationIntervalMin)
  return Number.isFinite(v) && v >= 1 ? Math.min(120, Math.floor(v)) : 8
}

export function reactivationStartsAt(autonomy: unknown): string | null {
  const v = (autonomy as Record<string, unknown> | null)?.reactivationStartsAt
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** Agente PADRÃO ativo da conta (é a política dele que vale pra reativação). */
async function defaultAgent(accountId: string) {
  return firstOrNull(
    await db
      .select({
        id: aiConfigs.id,
        autonomy: aiConfigs.autonomy,
        createdBy: aiConfigs.createdBy,
      })
      .from(aiConfigs)
      .where(
        and(
          eq(aiConfigs.accountId, accountId),
          eq(aiConfigs.isDefault, true),
          eq(aiConfigs.isActive, true),
        ),
      )
      .limit(1),
  )
}

/** Rascunho de reativação (mesma linguagem da lista "Chamar de volta"). */
function draftReactivation(
  name: string | null,
  signalType: string,
  payload: Record<string, unknown>,
): string {
  const oi = greeting(name)
  const prod = payload.product ? String(payload.product) : 'seu pedido'
  if (signalType === 'inactive')
    return `${oi} Sumiu, hein 😄 Faz um tempo que não passa aqui. Tá precisando de ${prod}? Consigo te atender rapidinho.`
  if (signalType === 'repurchase_overdue')
    return `${oi} 😊 Vi que já faz ${payload.days_since ?? 'uns'} dias do seu último ${prod}. Quer que eu já separe pra você?`
  return `${oi} Passando pra ver se tá na hora de repor o ${prod}. Quer que eu já deixe separado? 😊`
}

const REACTIVATION_SIGNALS = ['repurchase_overdue', 'inactive', 'repurchase_due']

/**
 * Gera pedidos de reativação na FILA a partir dos sinais abertos, quando o
 * agente padrão da conta está em reactivation='approve'. Idempotente (upsert no
 * pendente). Só pra contatos com conversa (pra dar pra enviar depois).
 */
export async function generateReactivationRequests(accountId: string): Promise<number> {
  const agent = await defaultAgent(accountId)
  if (!agent) return 0
  if (autonomyLevel(agent.autonomy, 'reactivation') !== 'approve') return 0

  // 🧹 Auto-cura: expira rascunhos PENDENTES cujo contato não tem mais sinal de
  // reativação aberto (cliente comprou → sinal resolvido → não faz sentido
  // "chamar de volta"). Subquery com coluna externa QUALIFICADA por literal
  // (gotcha do drizzle: `${tab.col}` em sql raw sai sem prefixo). [[crmfluxia-drizzle-subquery-unqualified]]
  await db
    .update(agentActionRequests)
    .set({ status: 'expired', resolvedAt: sql`now()` })
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        eq(agentActionRequests.actionType, 'reactivation'),
        eq(agentActionRequests.status, 'pending'),
        sql`NOT EXISTS (
          SELECT 1 FROM customer_signals cs
          WHERE cs.account_id = ${accountId}
            AND cs.contact_id = "agent_action_requests"."contact_id"
            AND cs.resolved_at IS NULL
            AND cs.signal_type IN ('repurchase_overdue', 'inactive', 'repurchase_due')
        )`,
      ),
    )

  const sigs = await db
    .select({
      contactId: customerSignals.contactId,
      signalType: customerSignals.signalType,
      severity: customerSignals.severity,
      payload: customerSignals.payload,
    })
    .from(customerSignals)
    .where(
      and(
        eq(customerSignals.accountId, accountId),
        isNull(customerSignals.resolvedAt),
        inArray(customerSignals.signalType, REACTIVATION_SIGNALS),
      ),
    )
    .orderBy(desc(customerSignals.severity))
    .limit(200)
  if (sigs.length === 0) return 0

  const ids = [...new Set(sigs.map((s) => s.contactId))]
  const [cs, convs, recent] = await Promise.all([
    db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(inArray(contacts.id, ids)),
    db
      .select({ id: conversations.id, contactId: conversations.contactId })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          inArray(conversations.contactId, ids),
        ),
      )
      .orderBy(desc(conversations.createdAt)),
    // 🧊 Cooldown: quem já foi TRATADO (enviado/recusado) nos últimos 7 dias
    // não volta pra fila. A decisão do humano tem validade.
    db
      .select({ contactId: agentActionRequests.contactId })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'reactivation'),
          ne(agentActionRequests.status, 'pending'),
          inArray(agentActionRequests.contactId, ids),
          gte(agentActionRequests.resolvedAt, sql`now() - interval '7 days'`),
        ),
      ),
  ])
  const nameOf = new Map(cs.map((c) => [c.id, c.name]))
  const convOf = new Map<string, string>()
  for (const c of convs) {
    if (c.contactId && !convOf.has(c.contactId)) convOf.set(c.contactId, c.id)
  }
  const cooling = new Set(recent.map((r) => r.contactId))

  let created = 0
  for (const s of sigs) {
    if (cooling.has(s.contactId)) continue // decisão humana recente
    const conversationId = convOf.get(s.contactId)
    if (!conversationId) continue // sem conversa não dá pra enviar
    const p = (s.payload ?? {}) as Record<string, unknown>
    const text = draftReactivation(nameOf.get(s.contactId) ?? null, s.signalType, p)
    const reason =
      s.signalType === 'inactive'
        ? `Cliente sumido há ${p.days_since ?? '?'} dias`
        : s.signalType === 'repurchase_overdue'
          ? `Recompra atrasada — ${p.days_since ?? '?'} dias (média ${p.avg_days ?? '?'})`
          : `Na hora da recompra — ${p.days_since ?? '?'} dias`
    const ins = firstOrNull(
      await db
        .insert(agentActionRequests)
        .values({
          accountId,
          agentId: agent.id,
          contactId: s.contactId,
          conversationId,
          actionType: 'reactivation',
          payload: { signalType: s.signalType, severity: s.severity, ...p },
          suggestedText: text,
          reason,
          status: 'pending',
        })
        .onConflictDoUpdate({
          target: [
          agentActionRequests.accountId,
          agentActionRequests.contactId,
          agentActionRequests.actionType,
          agentActionRequests.dealKey,
        ],
          targetWhere: sql`status = 'pending'`,
          set: { suggestedText: text, reason, payload: { signalType: s.signalType, severity: s.severity, ...p } },
        })
        .returning({ id: agentActionRequests.id, inserted: sql<boolean>`(xmax = 0)` }),
    )
    if (ins?.inserted) created++
  }
  return created
}

/** Gera pra todas as contas com agente padrão em 'approve' (sweep do worker). */
export async function generateAllReactivationRequests(): Promise<void> {
  const rows = await db
    .selectDistinct({ accountId: aiConfigs.accountId })
    .from(aiConfigs)
    .where(
      and(
        eq(aiConfigs.isDefault, true),
        eq(aiConfigs.isActive, true),
        sql`(${aiConfigs.autonomy}->>'reactivation') = 'approve'`,
      ),
    )
  for (const r of rows) {
    try {
      await generateReactivationRequests(r.accountId)
    } catch (err) {
      console.error('[autonomy] gerar pedidos falhou:', r.accountId, err)
    }
  }
}

// ============================================================
// 🤖 MODO AUTOMÁTICO (Fase 8 v2) — a IA reativa SOZINHA, GOVERNADA por travas:
//   🛑 kill switch da conta · 🔢 rate-limit 24h · ⏰ horário de atendimento ·
//   🔕 opt-out · 🧊 cooldown pós-decisão (7d) · 👤 não atropela humano ·
//   ⚡ circuit breaker (3 falhas) · 📝 log (agent_action_requests status='sent').
// ============================================================

export interface AutoRunResult {
  sent: number
  skipped: string | null
}

/** Hora local (0–23) no fuso, ou null se o fuso for inválido. */
function localHour(tz: string): number | null {
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date())
    for (const p of h) if (p.type === 'hour') return Number(p.value) % 24
  } catch {
    return null
  }
  return null
}

/** Janela-segura padrão pro AUTO quando a conta NÃO configurou horário de
 *  atendimento: 8h–20h no fuso da conta. Nunca dispara de madrugada. */
function isSafeDaytime(tz: string): boolean {
  const h = localHour(tz)
  if (h == null) return false // fuso ruim → não arrisca no auto
  return h >= 8 && h < 20
}

/** Data local "YYYY-MM-DD" no fuso, ou null se o fuso for inválido. */
function localDate(tz: string): string | null {
  try {
    // en-CA formata como YYYY-MM-DD, que ordena lexicograficamente.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return null
  }
}

export async function runAutoReactivations(accountId: string): Promise<AutoRunResult> {
  // 🛑 1) Kill switch da conta — freio de emergência, ignora tudo.
  const { getAccountSettings } = await import('@/lib/settings/account-settings')
  const settings = await getAccountSettings(accountId)
  if (settings.autonomyPaused) return { sent: 0, skipped: 'kill-switch' }

  // 2) Agente padrão precisa estar em 'auto'.
  const agent = await defaultAgent(accountId)
  if (!agent) return { sent: 0, skipped: 'no-agent' }
  if (autonomyLevel(agent.autonomy, 'reactivation') !== 'auto')
    return { sent: 0, skipped: 'not-auto' }

  // 📅 2b) Data de início: antes dela o auto fica DORMENTE.
  const startsAt = reactivationStartsAt(agent.autonomy)
  const today = localDate(settings.businessTimezone)
  if (startsAt && (!today || today < startsAt)) return { sent: 0, skipped: 'not-started' }

  // ⏰ 3) Horário: janela própria do auto > horário de atendimento > 8h–20h.
  const window = reactivationWindow(agent.autonomy)
  let okHours: boolean
  if (window) {
    const h = localHour(settings.businessTimezone)
    okHours = h != null && h >= window.start && h < window.end
  } else if (settings.businessHoursEnabled) {
    okHours = (await import('@/lib/settings/business-hours')).isWithinBusinessHours(settings)
  } else {
    okHours = isSafeDaytime(settings.businessTimezone)
  }
  if (!okHours) return { sent: 0, skipped: 'off-hours' }

  // 📡 4) Canais escolhidos (cada um com teto do dia). O envio é pelo mecanismo
  //    dos DISPAROS (06/09, pedido do Alex): espaçamento em minutos, pausa +
  //    alerta se a linha cair, tudo visível em Disparos. Uma leva por canal por
  //    dia — se a de hoje já existe (enviando, pausada ou pronta), não cria outra.
  const wanted = reactivationChannels(agent.autonomy)
  if (!wanted.length) return { sent: 0, skipped: 'no-channel' }
  const intervalMin = reactivationIntervalMin(agent.autonomy)
  const dayKey = today ?? new Date().toISOString().slice(0, 10)

  const chanRows = await db
    .select({ id: channels.id, name: channels.name, provider: channels.provider, status: channels.status })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, ['waha', 'evolution', 'evogo', 'meta'])))
  const todays = await db
    .select({ channelId: broadcasts.channelId, status: broadcasts.status, total: broadcasts.totalRecipients })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.accountId, accountId),
        sql`${broadcasts.audienceFilter}->>'kind' = 'reactivation'`,
        sql`${broadcasts.audienceFilter}->>'day' = ${dayKey}`,
      ),
    )
  const doneToday = new Set(todays.map((b) => b.channelId).filter((c): c is string => !!c))

  const usable: { channelId: string; name: string; remaining: number }[] = []
  for (const w of wanted) {
    const ch = chanRows.find((c) => c.id === w.channelId)
    if (!ch) continue
    if (ch.status !== 'connected') {
      console.log(`[autonomy auto] ${accountId.slice(0, 8)}: canal "${ch.name}" desconectado — chamar de volta não sai por ele hoje`)
      continue
    }
    if (ch.provider === 'meta') {
      // Canal oficial: disparo de texto fora da janela de 24h exige template.
      console.log(`[autonomy auto] ${accountId.slice(0, 8)}: canal oficial "${ch.name}" não recebe chamar de volta automático (use uma linha WAHA)`)
      continue
    }
    if (doneToday.has(ch.id)) continue
    usable.push({ channelId: ch.id, name: ch.name, remaining: w.dailyCap })
  }
  if (!usable.length) return { sent: 0, skipped: 'done-today' }

  // 5) Candidatos: TODOS os sinais abertos de reativação (não só os 12 mais
  //    graves — era isso que deixava a lista parada em quem estava em cooldown
  //    ou com humano na conversa, achado de 06/09).
  const sigs = await db
    .select({
      contactId: customerSignals.contactId,
      signalType: customerSignals.signalType,
      severity: customerSignals.severity,
      payload: customerSignals.payload,
    })
    .from(customerSignals)
    .where(
      and(
        eq(customerSignals.accountId, accountId),
        isNull(customerSignals.resolvedAt),
        inArray(customerSignals.signalType, REACTIVATION_SIGNALS),
      ),
    )
    .orderBy(desc(customerSignals.severity), desc(customerSignals.detectedAt))
    .limit(1000)
  if (sigs.length === 0) return { sent: 0, skipped: null }

  // Um sinal por contato (o mais grave vem primeiro).
  const bySignalContact = new Map<string, (typeof sigs)[number]>()
  for (const s of sigs) if (!bySignalContact.has(s.contactId)) bySignalContact.set(s.contactId, s)
  const ids = [...bySignalContact.keys()]

  const [cs, convs, recent] = await Promise.all([
    db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, optedOut: contacts.optedOut })
      .from(contacts)
      .where(inArray(contacts.id, ids)),
    db
      .select({
        contactId: conversations.contactId,
        channelId: conversations.channelId,
        iaOff: conversations.aiAutoreplyDisabled,
        assigned: conversations.assignedAgentId,
      })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), inArray(conversations.contactId, ids)))
      .orderBy(desc(conversations.lastMessageAt)),
    // 🧊 cooldown 7d: quem já foi TRATADO (mensagem enviada ou recusada por
    // gente). 'blocked'/'expired' não são tratamento — não contam (06/09).
    db
      .select({ contactId: agentActionRequests.contactId })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'reactivation'),
          inArray(agentActionRequests.status, ['sent', 'rejected']),
          inArray(agentActionRequests.contactId, ids),
          gte(agentActionRequests.resolvedAt, sql`now() - interval '7 days'`),
        ),
      ),
  ])
  const metaOf = new Map(cs.map((c) => [c.id, c]))
  const convOf = new Map<string, { channelId: string | null; iaOff: boolean; assigned: string | null }>()
  for (const c of convs) {
    if (c.contactId && !convOf.has(c.contactId)) convOf.set(c.contactId, { channelId: c.channelId, iaOff: c.iaOff, assigned: c.assigned })
  }
  const cooling = new Set(recent.map((r) => r.contactId))
  const usableIds = new Set(usable.map((u) => u.channelId))

  const candidates: { contactId: string; preferredChannelId: string | null }[] = []
  for (const contactId of ids) {
    const c = metaOf.get(contactId)
    if (!c || c.optedOut) continue // 🔕 opt-out
    if (!(c.phone ?? '').replace(/\D/g, '')) continue // sem telefone não vai
    if (cooling.has(contactId)) continue // 🧊 cooldown
    const existing = convOf.get(contactId)
    if (existing && (existing.iaOff || existing.assigned)) continue // 👤 humano dono / IA off
    const preferred = existing?.channelId && usableIds.has(existing.channelId) ? existing.channelId : null
    if (existing?.channelId && !preferred) continue // conversa num canal que não está na lista: fica lá
    candidates.push({ contactId, preferredChannelId: preferred })
  }
  if (!candidates.length) return { sent: 0, skipped: null }

  const plan = planReactivationBatches(candidates, usable.map((u) => ({ channelId: u.channelId, remaining: u.remaining })))

  const { enqueueTextBroadcast } = await import('@/lib/broadcasts/text-broadcast')
  const userId = agent.createdBy ?? ''
  const dayLabel = dayKey.split('-').reverse().slice(0, 2).join('/')
  let sent = 0
  for (const u of usable) {
    const list = plan.byChannel.get(u.channelId) ?? []
    if (!list.length) continue
    const recipientVars: Record<string, Record<string, string>> = {}
    const meta: { contactId: string; signalType: string; severity: number | null; payload: Record<string, unknown>; text: string }[] = []
    for (const contactId of list) {
      const s = bySignalContact.get(contactId)!
      const c = metaOf.get(contactId)!
      const p = (s.payload ?? {}) as Record<string, unknown>
      const text = draftReactivation(c.name ?? null, s.signalType, p)
      recipientVars[contactId] = { mensagem: text }
      meta.push({ contactId, signalType: s.signalType, severity: s.severity ?? null, payload: p, text })
    }
    const res = await enqueueTextBroadcast(accountId, userId, {
      name: `Chamar de volta · ${dayLabel} · ${u.name}`,
      channelId: u.channelId,
      bodyText: '{{mensagem}}',
      includeOptOut: false,
      sendNow: true,
      sendNowIntervalMin: intervalMin,
      recipientContactIds: list,
      recipientVars,
      audienceFilter: { kind: 'reactivation', day: dayKey, channelId: u.channelId, intervalMin, cap: u.remaining },
    })
    if (!res.broadcastId) {
      console.error(`[autonomy auto] ${accountId.slice(0, 8)}: chamar de volta pelo canal "${u.name}" não enfileirou: ${res.error ?? 'erro'}`)
      continue
    }
    // 📝 log da decisão (resolved_by NULL = foi a IA) + resolve o sinal (sai da lista).
    for (const m of meta) {
      await db.insert(agentActionRequests).values({
        accountId,
        agentId: agent.id,
        contactId: m.contactId,
        conversationId: null,
        actionType: 'reactivation',
        payload: { signalType: m.signalType, severity: m.severity, auto: true, broadcastId: res.broadcastId, channelId: u.channelId, ...m.payload },
        suggestedText: m.text,
        reason:
          m.signalType === 'inactive'
            ? `[AUTO] Cliente sumido há ${m.payload.days_since ?? '?'} dias`
            : m.signalType === 'repurchase_overdue'
              ? `[AUTO] Recompra atrasada — ${m.payload.days_since ?? '?'} dias`
              : `[AUTO] Na hora da recompra — ${m.payload.days_since ?? '?'} dias`,
        status: 'sent',
        resolvedAt: new Date().toISOString(),
        resolvedBy: null,
      })
      await db
        .update(customerSignals)
        .set({ resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(customerSignals.accountId, accountId),
            eq(customerSignals.contactId, m.contactId),
            eq(customerSignals.signalType, m.signalType),
            isNull(customerSignals.resolvedAt),
          ),
        )
    }
    sent += res.totalRecipients
    console.log(
      `[autonomy auto] ${accountId.slice(0, 8)}: "Chamar de volta · ${dayLabel} · ${u.name}" com ${res.totalRecipients} pessoas, 1 a cada ${intervalMin} min (disparo ${res.broadcastId.slice(0, 8)})`,
    )
  }
  if (plan.leftOver) console.log(`[autonomy auto] ${accountId.slice(0, 8)}: ${plan.leftOver} ficaram para amanhã (teto do dia)`)
  return { sent, skipped: null }
}

/** Sweep do worker: roda o auto pra todas as contas com agente padrão em 'auto'. */
export async function runAllAutoReactivations(): Promise<void> {
  const rows = await db
    .selectDistinct({ accountId: aiConfigs.accountId })
    .from(aiConfigs)
    .where(
      and(
        eq(aiConfigs.isDefault, true),
        eq(aiConfigs.isActive, true),
        sql`(${aiConfigs.autonomy}->>'reactivation') = 'auto'`,
      ),
    )
  for (const r of rows) {
    try {
      const res = await runAutoReactivations(r.accountId)
      if (res.sent > 0)
        console.log(`[autonomy auto] ${r.accountId}: ${res.sent} reativações enviadas`)
    } catch (err) {
      console.error('[autonomy auto] falhou:', r.accountId, err)
    }
  }
}

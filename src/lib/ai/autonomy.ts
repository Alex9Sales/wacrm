// ============================================================
// 🎛️ CDL Fase 8 — Autonomia governada.
// Política POR AÇÃO por agente (ai_configs.autonomy) + fila de aprovação
// (agent_action_requests). v1: ação "reactivation" (reativar cliente).
//   suggest = lista "Chamar de volta" (humano inicia);
//   approve = a IA rascunha e vai pra FILA (humano aprova/edita/recusa);
//   auto    = o follow-up reengaja sozinho no silêncio.
// Sem 'server-only' — alcançável do worker.
// ============================================================

import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'

import {
  db,
  aiConfigs,
  agentActionRequests,
  contacts,
  conversations,
  customerSignals,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { greeting } from '@/lib/cdl/names'

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
  return out
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

  // ⏰ 3) Horário: respeita o atendimento da conta se configurado; senão, cai
  // na janela-segura 8h–20h (o isWithinBusinessHours retorna true quando o
  // horário está desligado — no auto isso vazaria envio de madrugada).
  const okHours = settings.businessHoursEnabled
    ? (await import('@/lib/settings/business-hours')).isWithinBusinessHours(settings)
    : isSafeDaytime(settings.businessTimezone)
  if (!okHours) return { sent: 0, skipped: 'off-hours' }

  // 🔢 4) Rate-limit: teto de envios AUTO (resolved_by IS NULL) nas últimas 24h.
  const cap = reactivationDailyCap(agent.autonomy)
  const sentRow = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'reactivation'),
          eq(agentActionRequests.status, 'sent'),
          isNull(agentActionRequests.resolvedBy),
          gte(agentActionRequests.resolvedAt, sql`now() - interval '24 hours'`),
        ),
      ),
  )
  let budget = cap - (sentRow?.n ?? 0)
  if (budget <= 0) return { sent: 0, skipped: 'rate-limit' }

  const channelId = reactivationChannelId(agent.autonomy)
  const userId = agent.createdBy ?? ''

  // 5) Candidatos: sinais abertos por severidade (buffer p/ os que forem pulados).
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
    .limit(Math.min(300, Math.max(budget * 4, budget)))
  if (sigs.length === 0) return { sent: 0, skipped: null }

  const ids = [...new Set(sigs.map((s) => s.contactId))]
  const [cs, convs, recent] = await Promise.all([
    db
      .select({ id: contacts.id, name: contacts.name, optedOut: contacts.optedOut })
      .from(contacts)
      .where(inArray(contacts.id, ids)),
    db
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        iaOff: conversations.aiAutoreplyDisabled,
        assigned: conversations.assignedAgentId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          inArray(conversations.contactId, ids),
        ),
      )
      .orderBy(desc(conversations.createdAt)),
    // 🧊 cooldown 7d: quem já foi tratado (enviado/recusado, humano OU auto).
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
  const metaOf = new Map(cs.map((c) => [c.id, c]))
  const convOf = new Map<
    string,
    { id: string; iaOff: boolean; assigned: string | null }
  >()
  for (const c of convs) {
    if (c.contactId && !convOf.has(c.contactId))
      convOf.set(c.contactId, { id: c.id, iaOff: c.iaOff, assigned: c.assigned })
  }
  const cooling = new Set(recent.map((r) => r.contactId))

  const { engineSendText } = await import('@/lib/flows/meta-send')
  let findOrCreate: typeof import('@/lib/channels/inbound').findOrCreateConversation | null = null

  let sent = 0
  let fails = 0
  for (const s of sigs) {
    if (budget <= 0) break
    if (fails >= 3) break // ⚡ circuit breaker
    const c = metaOf.get(s.contactId)
    if (!c || c.optedOut) continue // 🔕 opt-out
    if (cooling.has(s.contactId)) continue // 🧊 cooldown

    let conversationId: string | null = null
    const existing = convOf.get(s.contactId)
    if (existing) {
      if (existing.iaOff || existing.assigned) continue // 👤 humano dono / IA off
      conversationId = existing.id
    } else if (channelId) {
      if (!findOrCreate)
        findOrCreate = (await import('@/lib/channels/inbound')).findOrCreateConversation
      try {
        const r = await findOrCreate(accountId, userId, s.contactId, channelId)
        if (!r?.conversation) continue
        conversationId = r.conversation.id
      } catch {
        fails++
        continue
      }
    } else {
      continue // importado sem linha configurada → não dá pra enviar
    }
    if (!conversationId) continue

    const p = (s.payload ?? {}) as Record<string, unknown>
    const text = draftReactivation(c.name ?? null, s.signalType, p)
    const reason =
      s.signalType === 'inactive'
        ? `[AUTO] Cliente sumido há ${p.days_since ?? '?'} dias`
        : s.signalType === 'repurchase_overdue'
          ? `[AUTO] Recompra atrasada — ${p.days_since ?? '?'} dias`
          : `[AUTO] Na hora da recompra — ${p.days_since ?? '?'} dias`
    try {
      await engineSendText({ accountId, userId, conversationId, contactId: s.contactId, text })
      // 📝 log da decisão (resolved_by NULL = foi a IA, não humano)
      await db.insert(agentActionRequests).values({
        accountId,
        agentId: agent.id,
        contactId: s.contactId,
        conversationId,
        actionType: 'reactivation',
        payload: { signalType: s.signalType, severity: s.severity, auto: true, ...p },
        suggestedText: text,
        reason,
        status: 'sent',
        resolvedAt: new Date().toISOString(),
        resolvedBy: null,
      })
      // resolve o sinal (sai da lista)
      await db
        .update(customerSignals)
        .set({ resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(customerSignals.accountId, accountId),
            eq(customerSignals.contactId, s.contactId),
            eq(customerSignals.signalType, s.signalType),
            isNull(customerSignals.resolvedAt),
          ),
        )
      cooling.add(s.contactId)
      sent++
      budget--
      fails = 0 // sucesso zera o contador do breaker
    } catch (err) {
      console.error('[autonomy auto] envio falhou:', s.contactId, err)
      fails++
    }
  }
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

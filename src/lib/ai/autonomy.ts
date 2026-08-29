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

/** Só deixa passar {ação conhecida: nível válido} — pro POST do config. */
export function sanitizeAutonomy(input: unknown): Record<string, AutonomyLevel> {
  const out: Record<string, AutonomyLevel> = {}
  if (input && typeof input === 'object') {
    for (const action of AUTONOMY_ACTIONS) {
      const v = (input as Record<string, unknown>)[action]
      if (typeof v === 'string' && (LEVELS as string[]).includes(v)) {
        out[action] = v as AutonomyLevel
      }
    }
  }
  return out
}

/** Agente PADRÃO ativo da conta (é a política dele que vale pra reativação). */
async function defaultAgent(accountId: string) {
  return firstOrNull(
    await db
      .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy })
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

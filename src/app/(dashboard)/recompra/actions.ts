'use server'

// ============================================================
// 📡 "Chamar de volta" (CDL Fase 7) — a lista acionável dos sinais de recompra.
// Recomputa na hora (best-effort) + lê os sinais abertos, junta nome/telefone
// e a conversa mais recente pra abrir com 1 clique.
// ============================================================

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  db,
  agentActionRequests,
  contacts,
  conversations,
  customerSignals,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { recomputeSignalsForAccount, listOpenSignals } from '@/lib/cdl/signals'
import { generateReactivationRequests } from '@/lib/ai/autonomy'

export interface RepurchaseRow {
  contactId: string
  name: string | null
  phone: string | null
  conversationId: string | null
  signalType: string
  severity: number
  payload: Record<string, unknown>
}

export async function getRepurchaseBoard(): Promise<RepurchaseRow[]> {
  const ctx = await getCurrentAccount()
  // Recomputa na hora pra a lista nunca ficar velha (o worker mantém quente).
  try {
    await recomputeSignalsForAccount(ctx.accountId)
  } catch {
    /* best-effort */
  }
  const sigs = await listOpenSignals(ctx.accountId, { limit: 300 })
  if (sigs.length === 0) return []

  const ids = [...new Set(sigs.map((s) => s.contactId))]
  const [cs, convs] = await Promise.all([
    db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
      .from(contacts)
      .where(inArray(contacts.id, ids)),
    db
      .select({ id: conversations.id, contactId: conversations.contactId })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, ctx.accountId),
          inArray(conversations.contactId, ids),
        ),
      )
      .orderBy(desc(conversations.createdAt)),
  ])
  const cmap = new Map(cs.map((c) => [c.id, c]))
  const convMap = new Map<string, string>()
  for (const cv of convs) {
    if (cv.contactId && !convMap.has(cv.contactId)) convMap.set(cv.contactId, cv.id)
  }

  return sigs.map((s) => ({
    contactId: s.contactId,
    name: cmap.get(s.contactId)?.name ?? null,
    phone: cmap.get(s.contactId)?.phone ?? null,
    conversationId: convMap.get(s.contactId) ?? null,
    signalType: s.signalType,
    severity: s.severity,
    payload: s.payload ?? {},
  }))
}

// 🔁 Motor de recompra SEMI-automático (a lista sugere, o humano aprova):
// envia a mensagem de reativação pela conversa do cliente e RESOLVE o sinal
// (sai da lista). O texto vem aprovado/editado pelo humano no clique.
export async function sendReactivation(input: {
  conversationId: string
  contactId: string
  signalType: string
  text: string
}): Promise<{ error: string | null }> {
  const text = (input.text ?? '').trim()
  if (!input.conversationId || !text) return { error: 'Sem conversa ou mensagem.' }
  try {
    const ctx = await getCurrentAccount()
    const { engineSendText } = await import('@/lib/flows/meta-send')
    await engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text,
    })
    await db
      .update(customerSignals)
      .set({ resolvedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(customerSignals.accountId, ctx.accountId),
          eq(customerSignals.contactId, input.contactId),
          eq(customerSignals.signalType, input.signalType),
          isNull(customerSignals.resolvedAt),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao enviar.' }
  }
}

// ============================================================
// 🎛️ Fila de APROVAÇÃO (CDL Fase 8) — quando o agente está em
// reactivation='approve', a IA rascunha e a mensagem espera aqui. O humano
// aprova (envia), edita antes de aprovar, ou recusa. Nada sai sem um clique.
// ============================================================

export interface PendingRequestRow {
  id: string
  contactId: string
  conversationId: string | null
  name: string | null
  phone: string | null
  suggestedText: string
  reason: string | null
  createdAt: string
  payload: Record<string, unknown>
}

/** Rascunha na hora (best-effort) + lista os pedidos pendentes da conta. */
export async function listPendingRequests(): Promise<PendingRequestRow[]> {
  const ctx = await getCurrentAccount()
  // Gera na hora pra a fila refletir os sinais atuais (só age se 'approve').
  try {
    await generateReactivationRequests(ctx.accountId)
  } catch {
    /* best-effort */
  }
  const rows = await db
    .select({
      id: agentActionRequests.id,
      contactId: agentActionRequests.contactId,
      conversationId: agentActionRequests.conversationId,
      suggestedText: agentActionRequests.suggestedText,
      reason: agentActionRequests.reason,
      createdAt: agentActionRequests.createdAt,
      payload: agentActionRequests.payload,
      name: contacts.name,
      phone: contacts.phone,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .where(
      and(
        eq(agentActionRequests.accountId, ctx.accountId),
        eq(agentActionRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(agentActionRequests.createdAt))
    .limit(100)

  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    conversationId: r.conversationId,
    name: r.name ?? null,
    phone: r.phone ?? null,
    suggestedText: r.suggestedText ?? '',
    reason: r.reason ?? null,
    createdAt: String(r.createdAt),
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }))
}

/** Aprova um pedido: envia (texto do humano) + resolve o sinal + marca 'sent'. */
export async function approveRequest(input: {
  id: string
  text: string
}): Promise<{ error: string | null }> {
  const text = (input.text ?? '').trim()
  if (!input.id || !text) return { error: 'Sem mensagem.' }
  try {
    const ctx = await getCurrentAccount()
    const req = firstOrNull(
      await db
        .select({
          id: agentActionRequests.id,
          contactId: agentActionRequests.contactId,
          conversationId: agentActionRequests.conversationId,
          payload: agentActionRequests.payload,
        })
        .from(agentActionRequests)
        .where(
          and(
            eq(agentActionRequests.id, input.id),
            eq(agentActionRequests.accountId, ctx.accountId),
            eq(agentActionRequests.status, 'pending'),
          ),
        )
        .limit(1),
    )
    if (!req) return { error: 'Pedido não está mais pendente.' }
    if (!req.conversationId) return { error: 'Sem conversa pra enviar.' }

    const { engineSendText } = await import('@/lib/flows/meta-send')
    await engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: req.conversationId,
      contactId: req.contactId,
      text,
    })
    await db
      .update(agentActionRequests)
      .set({ status: 'sent', resolvedAt: sql`now()`, resolvedBy: ctx.userId })
      .where(eq(agentActionRequests.id, req.id))

    // Resolve o sinal que originou o pedido (sai da lista "Chamar de volta").
    const signalType = (req.payload as Record<string, unknown> | null)?.signalType
    if (typeof signalType === 'string') {
      await db
        .update(customerSignals)
        .set({ resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(customerSignals.accountId, ctx.accountId),
            eq(customerSignals.contactId, req.contactId),
            eq(customerSignals.signalType, signalType),
            isNull(customerSignals.resolvedAt),
          ),
        )
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao aprovar.' }
  }
}

/** Recusa um pedido: marca 'rejected' (o cooldown de 7 dias segura a refila). */
export async function rejectRequest(input: {
  id: string
}): Promise<{ error: string | null }> {
  if (!input.id) return { error: 'Pedido inválido.' }
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(agentActionRequests)
      .set({ status: 'rejected', resolvedAt: sql`now()`, resolvedBy: ctx.userId })
      .where(
        and(
          eq(agentActionRequests.id, input.id),
          eq(agentActionRequests.accountId, ctx.accountId),
          eq(agentActionRequests.status, 'pending'),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao recusar.' }
  }
}

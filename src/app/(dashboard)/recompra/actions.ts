'use server'

// ============================================================
// 📡 "Chamar de volta" (CDL Fase 7) — a lista acionável dos sinais de recompra.
// Recomputa na hora (best-effort) + lê os sinais abertos, junta nome/telefone
// e a conversa mais recente pra abrir com 1 clique.
// ============================================================

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { db, contacts, conversations, customerSignals } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { recomputeSignalsForAccount, listOpenSignals } from '@/lib/cdl/signals'

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

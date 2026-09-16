// ============================================================
// Pausa da régua no banco (collections_touches) — IA, webhook e notas.
// Regras em pause-rules.ts. Sem 'server-only' — o worker e a rota do webhook
// alcançam isso.
// ============================================================

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import { db, collectionsTouches, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'

import { AI_PAUSE_REASONS, pauseAfterSettle, type PauseAfterSettle } from './pause-rules'

/** A pausa da IA na linha: origem 'ai', ou linha antiga com motivo da IA. */
const aiPauseWhere = () =>
  or(
    eq(collectionsTouches.pausedSource, 'ai'),
    and(isNull(collectionsTouches.pausedSource), inArray(collectionsTouches.pausedReason, [...AI_PAUSE_REASONS])),
  )

/** Depois que uma PESSOA retoma a cobrança, a IA não pausa de novo por este tempo. */
export const RESUME_GRACE_DAYS = 7

export type AiPauseResult = 'paused' | 'team_paused' | 'recently_resumed'

/**
 * A IA pausa a régua (acordo/contestação) — sem passar por cima de pausa que
 * uma pessoa pôs, nem desfazer um "Retomar cobrança" recente (16/09: Mapami e
 * Matheus MB foram pausados de novo minutos depois — a IA lê errado "me manda
 * o link que eu acerto" como pedido de acordo).
 */
export async function pauseByAi(accountId: string, contactId: string, reason: string, nowIso: string): Promise<AiPauseResult> {
  const rows = await db
    .insert(collectionsTouches)
    .values({ accountId, contactId, paused: true, pausedReason: reason, pausedSource: 'ai', pausedAt: nowIso, pausedBy: null, updatedAt: nowIso })
    .onConflictDoUpdate({
      target: [collectionsTouches.accountId, collectionsTouches.contactId],
      set: { paused: true, pausedReason: reason, pausedSource: 'ai', pausedAt: nowIso, pausedBy: null, updatedAt: nowIso },
      setWhere: sql`(${collectionsTouches.paused} = false AND NOT (${collectionsTouches.pausedSource} = 'resumed' AND ${collectionsTouches.pausedAt} > now() - make_interval(days => ${RESUME_GRACE_DAYS}))) OR ${collectionsTouches.pausedSource} = 'ai' OR (${collectionsTouches.pausedSource} IS NULL AND ${collectionsTouches.pausedReason} IN ('Cliente pediu acordo/parcelamento', 'Cliente contesta a cobrança'))`,
    })
    .returning({ contactId: collectionsTouches.contactId })
  if (rows.length) return 'paused'
  const st = firstOrNull(
    await db
      .select({ paused: collectionsTouches.paused })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
      .limit(1),
  )
  return st?.paused ? 'team_paused' : 'recently_resumed'
}

/** Nota interna na conversa mais recente do contato. Best-effort. */
async function noteOnLatestConversation(accountId: string, contactId: string, text: string): Promise<void> {
  try {
    const conv = firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId)))
        .orderBy(desc(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`))
        .limit(1),
    )
    if (!conv) return
    await db.insert(messages).values({
      conversationId: conv.id,
      senderType: 'bot',
      contentType: 'text',
      contentText: text,
      isInternal: true,
      status: 'sent',
    })
  } catch (err) {
    console.error('[cobranca] nota da pausa falhou:', err instanceof Error ? err.message : err)
  }
}

/**
 * Depois que o webhook fecha uma cobrança paga e o contato não deve mais nada
 * vencido: tira a pausa da IA (com nota) ou avisa que a pausa da equipe
 * continua. Nunca lança.
 */
export async function settlePauseAfterPayment(args: {
  accountId: string
  contactId: string
  /** 1º pagamento desta cobrança (status anterior não era pago). */
  firstSettle: boolean
  stillOwes: boolean
  nowIso: string
}): Promise<PauseAfterSettle> {
  try {
    const st = firstOrNull(
      await db
        .select({
          paused: collectionsTouches.paused,
          pausedSource: collectionsTouches.pausedSource,
          pausedReason: collectionsTouches.pausedReason,
        })
        .from(collectionsTouches)
        .where(and(eq(collectionsTouches.accountId, args.accountId), eq(collectionsTouches.contactId, args.contactId)))
        .limit(1),
    )
    const verdict = pauseAfterSettle(st, { firstSettle: args.firstSettle, stillOwes: args.stillOwes })
    if (verdict === 'none') return 'none'
    if (verdict === 'lift') {
      const lifted = await db
        .update(collectionsTouches)
        .set({ paused: false, pausedReason: null, pausedSource: null, pausedAt: null, updatedAt: args.nowIso })
        .where(
          and(
            eq(collectionsTouches.accountId, args.accountId),
            eq(collectionsTouches.contactId, args.contactId),
            eq(collectionsTouches.paused, true),
            aiPauseWhere(),
          ),
        )
        .returning({ contactId: collectionsTouches.contactId })
      if (!lifted.length) return 'none'
      await noteOnLatestConversation(
        args.accountId,
        args.contactId,
        `🧾 A cobrança foi paga e não sobrou nada vencido na carteira. A pausa automática da régua ("${st!.pausedReason}") foi retirada: parcela a vencer e cobrança nova voltam a receber lembrete e régua.`,
      )
      return 'lift'
    }
    await noteOnLatestConversation(
      args.accountId,
      args.contactId,
      `🧾 Pagou o que estava vencido, mas a régua continua PAUSADA por decisão da equipe${st!.pausedReason ? ` ("${st!.pausedReason}")` : ''}. Cobrança nova deste cliente não recebe régua, lembrete nem aviso — para voltar a cobrar, use "Retomar cobrança" na lateral da conversa ou em Cobranças.`,
    )
    return 'keep_human'
  } catch (err) {
    console.error('[cobranca] pausa após pagamento falhou:', err instanceof Error ? err.message : err)
    return 'none'
  }
}

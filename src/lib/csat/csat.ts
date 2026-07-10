// ============================================================
// CSAT (pesquisa de satisfação) — send a 1–5 survey when a conversation is
// closed, then capture the customer's numeric reply as a score.
//
//   sendCsatSurveyIfEnabled()  — called when a conversation transitions to
//     'closed'. Sends the survey (as a bot message) and stamps
//     conversations.csat_pending_at so the next customer reply is read as a
//     rating.
//   maybeRecordCsat()          — called from the inbound pipeline. If the
//     conversation is awaiting a rating and the message is a 1–5, records it,
//     clears the pending flag, and sends the thank-you. Returns true when it
//     consumed the message (caller then skips flows/AI for it).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, conversations, csatResponses } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { engineSendText } from '@/lib/flows/meta-send'

/** Hours a survey stays open for a reply before it's considered stale. */
const CSAT_WINDOW_HOURS = 24

/**
 * Send the CSAT survey for a just-closed conversation, if CSAT is enabled and
 * we're not already awaiting a rating. Best-effort — never throws to the caller
 * (closing a conversation must succeed regardless).
 */
export async function sendCsatSurveyIfEnabled(
  accountId: string,
  conversationId: string,
): Promise<void> {
  try {
    const settings = await getAccountSettings(accountId)
    if (!settings.csatEnabled) return
    const question = settings.csatQuestion?.trim()
    if (!question) return

    const conv = firstOrNull(
      await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          userId: conversations.userId,
          csatPendingAt: conversations.csatPendingAt,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, accountId),
          ),
        )
        .limit(1),
    )
    if (!conv || conv.csatPendingAt) return // gone, or already surveyed

    await engineSendText({
      accountId,
      userId: conv.userId,
      conversationId: conv.id,
      contactId: conv.contactId,
      text: question,
    })
    await db
      .update(conversations)
      .set({ csatPendingAt: new Date().toISOString() })
      .where(eq(conversations.id, conv.id))
  } catch (err) {
    console.error('[csat] survey send failed:', err)
  }
}

/** Parse a 1–5 score from a short customer reply, or null. Accepts "5",
 *  "nota 5", "5!", "⭐⭐⭐⭐⭐" is NOT handled — just a digit 1–5. */
export function parseCsatScore(text: string): number | null {
  const m = /(^|\D)([1-5])(\D|$)/.exec(text.trim())
  if (!m) return null
  // Reject if the message clearly carries other numbers/context (e.g. a phone
  // or an address) — only treat SHORT replies as ratings.
  if (text.trim().length > 12) return null
  return Number(m[2])
}

/**
 * If `conversation` is awaiting a CSAT rating and `text` is a 1–5, record it,
 * clear the pending flag, and thank the customer. Returns true when the
 * message was consumed as a rating. A pending survey older than the window, or
 * a non-numeric reply, clears the flag and returns false (normal processing).
 */
export async function maybeRecordCsat(
  accountId: string,
  conversation: {
    id: string
    contactId: string
    userId: string
    assignedAgentId: string | null
    csatPendingAt: string | null
  },
  text: string,
): Promise<boolean> {
  try {
    if (!conversation.csatPendingAt) return false
    const ageMs = Date.now() - new Date(conversation.csatPendingAt).getTime()
    if (ageMs > CSAT_WINDOW_HOURS * 3_600_000) {
      // Stale survey — stop waiting, process the message normally.
      await db
        .update(conversations)
        .set({ csatPendingAt: null })
        .where(eq(conversations.id, conversation.id))
      return false
    }

    const score = parseCsatScore(text)
    if (score == null) {
      // They replied something that isn't a rating — drop the survey so we
      // don't misread a later message, and let this one flow normally.
      await db
        .update(conversations)
        .set({ csatPendingAt: null })
        .where(eq(conversations.id, conversation.id))
      return false
    }

    await db.insert(csatResponses).values({
      accountId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      agentId: conversation.assignedAgentId,
      score,
    })
    await db
      .update(conversations)
      .set({ csatPendingAt: null })
      .where(eq(conversations.id, conversation.id))

    const settings = await getAccountSettings(accountId)
    const thanks = settings.csatThanks?.trim()
    if (thanks) {
      await engineSendText({
        accountId,
        userId: conversation.userId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        text: thanks,
      })
    }
    return true
  } catch (err) {
    console.error('[csat] record failed:', err)
    return false
  }
}

// ============================================================
// Shared delivery/read-status mirroring (Phase 4, wave 3).
//
// Every WhatsApp transport reports delivery + read receipts, and every
// one of them must mirror those onto the same two places the legacy Meta
// webhook did:
//   1. messages.status           — the inbox bubble ticks.
//   2. broadcast_recipients      — matched by whatsapp_message_id; the
//                                  aggregate trigger re-derives the parent
//                                  broadcast's sent/delivered/read counts.
// …and fan the change out to the public webhook subscribers
// (message.status_updated).
//
// The Meta route and the generic [provider]/[channelId] route both call
// `applyStatusUpdate` so this logic lives in exactly one place. Meta hands
// us the raw string status ('sent'|'delivered'|'read'|'failed') straight
// off its webhook; the non-official providers only surface a
// NormalizedStatus { externalMessageId, level: 2|3 } — `levelToStatus`
// maps 2→'delivered', 3→'read' so both funnel through the same call.
// ============================================================

import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  db,
  broadcastRecipients,
  broadcasts,
  conversations,
  messages,
} from '@/db';
import { firstOrNull } from '@/db/helpers';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down this
// ladder. `failed` is NOT on the ladder: it's a terminal side branch valid
// only from the early states (pending / sent).
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') return false; // failed is terminal
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

/** Map a NormalizedStatus level (2=delivered, 3=read) to a status string. */
export function levelToStatus(level: 2 | 3): 'delivered' | 'read' {
  return level === 3 ? 'read' : 'delivered';
}

export interface StatusUpdateInput {
  /** The provider-side message id (messages.message_id / whatsapp_message_id). */
  externalMessageId: string;
  /** Mirrored status value — must be one of the messages.status CHECK values. */
  status: string;
  /** Epoch-seconds timestamp for the recipient sent/delivered/read stamp. */
  timestampSeconds?: number;
}

/**
 * Mirror one delivery/read status onto messages + broadcast_recipients and
 * fan it out to public webhook subscribers. Best-effort throughout — a
 * failure in any step is logged and swallowed so one bad status never
 * aborts the webhook batch. Shared by the Meta and generic webhook routes.
 */
export async function applyStatusUpdate(input: StatusUpdateInput): Promise<void> {
  const { externalMessageId, status } = input;
  if (!externalMessageId) return;

  // 1) Mirror onto messages. message_id is NOT unique (Meta ids repeat
  //    across numbers), so this updates 0..N rows.
  try {
    await db
      .update(messages)
      .set({ status })
      .where(eq(messages.messageId, externalMessageId));
  } catch (msgErr) {
    console.error('[status] Error updating message status:', msgErr);
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id. The
  //    aggregate trigger re-derives the parent broadcast counts.
  const tsIso = input.timestampSeconds
    ? new Date(input.timestampSeconds * 1000).toISOString()
    : new Date().toISOString();

  let recipient: { id: string; status: string } | null = null;
  let recipientFetchFailed = false;
  try {
    recipient = firstOrNull(
      await db
        .select({
          id: broadcastRecipients.id,
          status: broadcastRecipients.status,
        })
        .from(broadcastRecipients)
        .where(eq(broadcastRecipients.whatsappMessageId, externalMessageId))
        .limit(1),
    );
  } catch (recFetchErr) {
    recipientFetchFailed = true;
    console.error('[status] Error fetching broadcast recipient:', recFetchErr);
  }

  if (
    !recipientFetchFailed &&
    recipient &&
    isValidStatusTransition(recipient.status, status)
  ) {
    const update: {
      status: string;
      sentAt?: string;
      deliveredAt?: string;
      readAt?: string;
    } = { status };
    if (status === 'sent') update.sentAt = tsIso;
    if (status === 'delivered') update.deliveredAt = tsIso;
    if (status === 'read') update.readAt = tsIso;

    try {
      await db
        .update(broadcastRecipients)
        .set(update)
        .where(eq(broadcastRecipients.id, recipient.id));
    } catch (recUpdateErr) {
      console.error('[status] Error updating broadcast recipient status:', recUpdateErr);
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends). Runs last
  //    so a slow subscriber can't delay the mirrors above. Bounded to one
  //    row (message_id isn't unique) purely to resolve the owning account.
  let msgRow: {
    conversationId: string;
    accountId: string | null;
    channelId: string | null;
  } | null = null;
  try {
    msgRow = firstOrNull(
      await db
        .select({
          conversationId: messages.conversationId,
          accountId: conversations.accountId,
          channelId: conversations.channelId,
        })
        .from(messages)
        .leftJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(messages.messageId, externalMessageId))
        .limit(1),
    );
  } catch (err) {
    console.error('[status] Error resolving account for status webhook:', err);
  }

  if (msgRow?.accountId) {
    await dispatchWebhookEvent(
      msgRow.accountId,
      'message.status_updated',
      {
        whatsapp_message_id: externalMessageId,
        conversation_id: msgRow.conversationId,
        status,
      },
      msgRow.channelId,
    );
  }
}

/**
 * Flip a still-unreplied broadcast_recipients row to `replied` when the
 * inbound sender is a recent broadcast recipient. Best-effort. Shared so
 * both webhook routes advance a broadcast's replied_count identically.
 *
 * NOTE: the agnostic inbound pipeline (inbound.ts) already runs its own
 * copy of this on every inbound message, so the webhook routes do NOT need
 * to call this — it's exported here only so a caller that bypasses the
 * pipeline can reuse it. Kept for parity with the legacy Meta webhook.
 */
export async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    const recs = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcastRecipients.broadcastId, broadcasts.id))
      .where(
        and(
          eq(broadcastRecipients.contactId, contactId),
          eq(broadcasts.accountId, accountId),
          inArray(broadcastRecipients.status, ['sent', 'delivered', 'read']),
        ),
      )
      .orderBy(desc(broadcastRecipients.createdAt))
      .limit(1);

    if (!recs || recs.length === 0) return;
    try {
      await db
        .update(broadcastRecipients)
        .set({ status: 'replied', repliedAt: new Date().toISOString() })
        .where(eq(broadcastRecipients.id, recs[0].id));
    } catch (updErr) {
      console.error('[status] Error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('[status] flagBroadcastReplyIfAny failed:', err);
  }
}

// ============================================================
// Data access for the broadcast queue worker (Phase 5 CORE).
//
// The worker only ever has ids (broadcastId / recipientRowId) — it must
// rebuild the send context from the DB after a restart. These helpers
// own every read/write the worker needs so the worker file stays a thin
// orchestration layer. All are Next-independent (Drizzle + our channel
// helpers), matching the worker's constraint.
// ============================================================

import { and, eq, ne } from 'drizzle-orm';

import { db, broadcasts, broadcastRecipients, contacts } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels';
import type { ChannelCtx } from '@/lib/channels/provider';
import {
  loadBroadcastTemplateRow,
  type BroadcastSendContext,
} from '@/lib/whatsapp/broadcast-core';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { contactTokenValues } from '@/lib/whatsapp/message-vars';

/** A broadcast row as the worker sees it. */
export interface BroadcastRow {
  id: string;
  accountId: string;
  channelId: string | null;
  status: string;
  messageKind: string;
  bodyText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaFilename: string | null;
  pacing: unknown;
  templateName: string | null;
  templateLanguage: string;
}

/** Load the broadcast row (or null if it vanished). */
export async function loadBroadcastRow(
  broadcastId: string,
): Promise<BroadcastRow | null> {
  return firstOrNull(
    await db
      .select({
        id: broadcasts.id,
        accountId: broadcasts.accountId,
        channelId: broadcasts.channelId,
        status: broadcasts.status,
        messageKind: broadcasts.messageKind,
        bodyText: broadcasts.bodyText,
        mediaUrl: broadcasts.mediaUrl,
        mediaType: broadcasts.mediaType,
        mediaFilename: broadcasts.mediaFilename,
        pacing: broadcasts.pacing,
        templateName: broadcasts.templateName,
        templateLanguage: broadcasts.templateLanguage,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .limit(1),
  );
}

/**
 * Resolve the channel a broadcast sends on: its persisted channel_id, or
 * the account's default channel as a fallback (older rows / null).
 */
export async function resolveBroadcastChannel(
  b: BroadcastRow,
): Promise<ChannelCtx | null> {
  if (b.channelId) {
    const ch = await loadChannel(b.channelId);
    if (ch) return ch;
  }
  return loadDefaultChannel(b.accountId);
}

/** Move a broadcast to 'sending' (idempotent; only from pre-terminal). */
export async function markBroadcastSending(broadcastId: string): Promise<void> {
  await db
    .update(broadcasts)
    .set({ status: 'sending', updatedAt: new Date().toISOString() })
    .where(eq(broadcasts.id, broadcastId));
}

/** The pending recipient rows of a broadcast (id only — the send job
 *  reloads each row when it runs, so state is always fresh). */
export async function listPendingRecipientIds(
  broadcastId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: broadcastRecipients.id })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'pending'),
      ),
    );
  return rows.map((r) => r.id);
}

/** Pending recipients WITH their computed slot time (humanized drips). The
 *  dispatch worker enqueues each with delay = slot - now. */
export async function listPendingRecipientSlots(
  broadcastId: string,
): Promise<{ id: string; slotAt: string | null }[]> {
  const rows = await db
    .select({
      id: broadcastRecipients.id,
      slotAt: broadcastRecipients.scheduledSlotAt,
    })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'pending'),
      ),
    );
  return rows;
}

/** Everything a recipient send job needs, rebuilt from the DB. */
export interface RecipientJobContext {
  broadcast: BroadcastRow;
  channel: ChannelCtx;
  sendContext: BroadcastSendContext;
  recipient: {
    id: string;
    status: string;
    attempts: number;
    phone: string;
    params: string[];
    messageParams?: SendTimeParams;
    /** Humanized drip: this recipient's target send instant (ISO), if any. */
    slotAt: string | null;
    /** Personalization values for {{tokens}} in a 'text' body. */
    vars: Record<string, string>;
  };
}

/**
 * Load and assemble the full context for one recipient send job. Returns
 * null when the recipient row, its contact phone, or the channel can't be
 * resolved — the worker treats that as an unrecoverable skip.
 */
export async function loadRecipientJobContext(
  recipientRowId: string,
): Promise<
  | { kind: 'ok'; ctx: RecipientJobContext }
  | { kind: 'missing'; reason: string }
  | { kind: 'broadcast'; broadcast: BroadcastRow }
> {
  const row = firstOrNull(
    await db
      .select({
        id: broadcastRecipients.id,
        broadcastId: broadcastRecipients.broadcastId,
        status: broadcastRecipients.status,
        attempts: broadcastRecipients.attempts,
        params: broadcastRecipients.params,
        messageParams: broadcastRecipients.messageParams,
        slotAt: broadcastRecipients.scheduledSlotAt,
        phone: contacts.phone,
        contactName: contacts.name,
        contactEmail: contacts.email,
        contactCompany: contacts.company,
      })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
      .where(eq(broadcastRecipients.id, recipientRowId))
      .limit(1),
  );
  if (!row) return { kind: 'missing', reason: 'recipient row not found' };

  const broadcast = await loadBroadcastRow(row.broadcastId);
  if (!broadcast) return { kind: 'missing', reason: 'broadcast not found' };

  // Short-circuit on a not-actively-sending broadcast (cancelled/paused)
  // — let the worker decide skip vs. re-delay without loading the channel.
  if (broadcast.status !== 'sending') {
    return { kind: 'broadcast', broadcast };
  }

  if (!row.phone) return { kind: 'missing', reason: 'recipient has no phone' };

  const channel = await resolveBroadcastChannel(broadcast);
  if (!channel) return { kind: 'missing', reason: 'channel not resolvable' };

  const isText = broadcast.messageKind === 'text';
  const sendContext: BroadcastSendContext = {
    messageKind: isText ? 'text' : 'template',
    bodyText: broadcast.bodyText,
    mediaUrl: broadcast.mediaUrl,
    mediaType: broadcast.mediaType,
    mediaFilename: broadcast.mediaFilename,
    templateName: broadcast.templateName ?? '',
    templateLanguage: broadcast.templateLanguage,
    // Text broadcasts have no Meta template row to load.
    templateRow:
      isText || !broadcast.templateName
        ? null
        : await loadBroadcastTemplateRow(
            broadcast.accountId,
            broadcast.templateName,
            broadcast.templateLanguage,
          ),
  };

  const params = Array.isArray(row.params)
    ? (row.params as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  return {
    kind: 'ok',
    ctx: {
      broadcast,
      channel,
      sendContext,
      recipient: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        phone: row.phone,
        params,
        messageParams: (row.messageParams as SendTimeParams | null) ?? undefined,
        slotAt: row.slotAt ?? null,
        vars: contactTokenValues({
          name: row.contactName,
          phone: row.phone,
          email: row.contactEmail,
          company: row.contactCompany,
        }),
      },
    },
  };
}

/** Mark a recipient sent (success). Bumps attempts, stamps wamid. */
export async function markRecipientSent(
  recipientRowId: string,
  externalMessageId: string,
  attempts: number,
): Promise<void> {
  await db
    .update(broadcastRecipients)
    .set({
      status: 'sent',
      sentAt: new Date().toISOString(),
      whatsappMessageId: externalMessageId,
      errorMessage: null,
      attempts,
    })
    .where(eq(broadcastRecipients.id, recipientRowId));
}

/** Record a failed attempt WITHOUT marking terminal 'failed' (transient
 *  — BullMQ will retry). Bumps attempts + last error only. */
export async function recordRecipientAttempt(
  recipientRowId: string,
  attempts: number,
  error: string,
): Promise<void> {
  await db
    .update(broadcastRecipients)
    .set({ attempts, errorMessage: error })
    .where(eq(broadcastRecipients.id, recipientRowId));
}

/** Mark a recipient terminally 'failed' (permanent error / retries out). */
export async function markRecipientFailed(
  recipientRowId: string,
  attempts: number,
  error: string,
): Promise<void> {
  await db
    .update(broadcastRecipients)
    .set({ status: 'failed', attempts, errorMessage: error })
    .where(eq(broadcastRecipients.id, recipientRowId));
}

/**
 * Finalize a broadcast's terminal status IF all its recipients have
 * settled (nothing left 'pending'). 'sent' when at least one went out,
 * else 'failed'. No-op while any recipient is still pending, or if the
 * broadcast is cancelled/paused. Counts stay trigger-owned.
 */
export async function finalizeBroadcastIfDone(
  broadcastId: string,
): Promise<void> {
  const b = await loadBroadcastRow(broadcastId);
  if (!b || b.status !== 'sending') return;

  const remaining = await db
    .select({ id: broadcastRecipients.id })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'pending'),
      ),
    )
    .limit(1);
  if (remaining.length > 0) return; // still work to do

  // "sent" if any recipient is in a non-failed terminal state (sent may
  // already have advanced to delivered/read/replied via webhooks).
  const anySent = await db
    .select({ id: broadcastRecipients.id })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        ne(broadcastRecipients.status, 'failed'),
      ),
    )
    .limit(1);

  await db
    .update(broadcasts)
    .set({
      status: anySent.length > 0 ? 'sent' : 'failed',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(broadcasts.id, broadcastId));
}

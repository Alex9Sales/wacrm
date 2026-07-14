// ============================================================
// Broadcast lifecycle controls: pause / resume / cancel (Phase 5 CORE).
//
// State machine (queue-relevant states only):
//   scheduled ─pause→ paused ─resume→ sending
//   sending   ─pause→ paused ─resume→ sending
//   sending|scheduled|paused ─cancel→ cancelled  (terminal)
//
// The worker reads broadcast.status on every recipient job:
//   cancelled → skip (no send),
//   paused    → moveToDelayed(+15s) so it self-resumes,
//   sending   → send.
// So pause/resume/cancel are just status writes here; the queued jobs
// react to them. `resume` also re-enqueues the dispatch so a broadcast
// that had no recipient jobs yet (e.g. paused while still scheduled) gets
// fanned out. This module is Next-independent.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, broadcastRecipients, broadcasts } from '@/db';
import { firstOrNull } from '@/db/helpers';
import {
  enqueueBroadcastDispatch,
  removeBroadcastDispatchJob,
  removeRecipientJobs,
} from './queues';

export type BroadcastControlAction = 'pause' | 'resume' | 'cancel';

export interface ControlResult {
  ok: boolean;
  /** New status on success, or the current status on a rejected transition. */
  status: string;
  /** Error code when !ok. */
  code?: 'not_found' | 'invalid_state';
  message?: string;
}

async function currentStatus(
  broadcastId: string,
  accountId: string,
): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ status: broadcasts.status })
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)),
      )
      .limit(1),
  );
  return row?.status ?? null;
}

async function setStatus(broadcastId: string, status: string): Promise<void> {
  await db
    .update(broadcasts)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(broadcasts.id, broadcastId));
}

/** Pause a broadcast — only from 'sending' or 'scheduled'. */
export async function pauseBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  if (status !== 'sending' && status !== 'scheduled') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Cannot pause a broadcast in status '${status}'`,
    };
  }
  await setStatus(broadcastId, 'paused');
  return { ok: true, status: 'paused' };
}

/**
 * Resume a paused broadcast → 'sending'. Re-enqueues the dispatch so any
 * recipients not yet fanned out get queued; recipient jobs already sitting
 * delayed (paused self-defer) resume once they see status 'sending'.
 */
export async function resumeBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  if (status !== 'paused') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Cannot resume a broadcast in status '${status}'`,
    };
  }
  await setStatus(broadcastId, 'sending');
  // Re-enqueue dispatch (jobId dedups if one is still around) so any
  // still-pending recipients are (re)fanned out.
  await enqueueBroadcastDispatch(broadcastId, {});
  return { ok: true, status: 'sending' };
}

/** Cancel a broadcast → 'cancelled' (terminal). Pending recipients won't
 *  send: their jobs see 'cancelled' and skip. Blocked once already
 *  sent/failed/cancelled. */
export async function cancelBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  if (status === 'sent' || status === 'failed' || status === 'cancelled') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Cannot cancel a broadcast in status '${status}'`,
    };
  }
  await setStatus(broadcastId, 'cancelled');
  return { ok: true, status: 'cancelled' };
}

/**
 * Requeue only the FAILED recipients of a finished (or stuck) broadcast —
 * "reenviar falhados". Resets them to 'pending' (attempts zeroed, error
 * cleared), flips the broadcast back to 'sending' and re-enqueues the
 * dispatch, which fans out pending recipients only (already-sent ones are
 * untouched). Typical use: a channel dropped mid-broadcast and reconnected.
 */
export async function retryFailedBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult & { requeued?: number }> {
  const row = firstOrNull(
    await db
      .select({ status: broadcasts.status, channelId: broadcasts.channelId })
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)),
      )
      .limit(1),
  );
  if (!row) return { ok: false, status: 'unknown', code: 'not_found' };
  const status = row.status;
  if (status === 'scheduled') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Broadcast ainda agendado ('${status}')`,
    };
  }
  // Reset failed → pending, then re-fan ALL pending (failed just reset +
  // any that got stuck) — covers a channel drop mid-broadcast.
  await db
    .update(broadcastRecipients)
    .set({ status: 'pending', attempts: 0, errorMessage: null })
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'failed'),
      ),
    );
  const pending = await db
    .select({ id: broadcastRecipients.id })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'pending'),
      ),
    );
  if (pending.length === 0) {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: 'Nenhum destinatário pendente/falhado para reenviar',
    };
  }
  // Clear the BullMQ jobId dedup: a completed dispatch job and prior
  // failed recipient jobs block the re-enqueue otherwise.
  await removeBroadcastDispatchJob(broadcastId);
  if (row.channelId) {
    await removeRecipientJobs(
      row.channelId,
      pending.map((p) => p.id),
    );
  }
  await setStatus(broadcastId, 'sending');
  await enqueueBroadcastDispatch(broadcastId, {});
  return { ok: true, status: 'sending', requeued: pending.length };
}

export async function controlBroadcast(
  action: BroadcastControlAction,
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  switch (action) {
    case 'pause':
      return pauseBroadcast(broadcastId, accountId);
    case 'resume':
      return resumeBroadcast(broadcastId, accountId);
    case 'cancel':
      return cancelBroadcast(broadcastId, accountId);
  }
}

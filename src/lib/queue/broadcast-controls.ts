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

import { db, broadcastRecipients, broadcasts, notifications } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { publishEvent } from '@/lib/events/publish';
import type { ChannelHaltReason } from './errors';
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

/** What the operator sees when a broadcast is auto-paused. */
function haltAlert(
  reason: ChannelHaltReason,
  broadcastName: string,
): { title: string; body: string } {
  if (reason === 'reputation') {
    return {
      title: 'Disparo pausado — número bloqueado pelo WhatsApp',
      body:
        `Pausei "${broadcastName}" automaticamente: o WhatsApp começou a recusar os envios ` +
        `desse número por reputação (erro 463). Insistir piora e pode banir o número de vez. ` +
        `Deixe-o descansar e aqueça-o antes de continuar — ou siga por outro número. ` +
        `Quando estiver liberado, use "Reenviar falhados".`,
    };
  }
  return {
    title: 'Disparo pausado — canal desconectado',
    body:
      `Pausei "${broadcastName}" automaticamente: a sessão do WhatsApp desse canal caiu ` +
      `(deslogada ou fora do ar), então nada mais sairia. Reconecte o canal e use ` +
      `"Reenviar falhados" para retomar de onde parou.`,
  };
}

/**
 * Auto-pause a broadcast because the CHANNEL is in trouble (reputation block /
 * session down) and alert its owner. Called by the worker on the first such
 * failure — every remaining recipient would fail anyway, and with a 463 each
 * extra attempt burns the sender number further.
 *
 * Race-safe by construction: the pause is a conditional UPDATE on
 * `status = 'sending'`, so of N recipient jobs failing at once exactly ONE
 * flips the status and raises the alert — the rest get `false` and stay quiet.
 * Their queued jobs then see 'paused' and defer themselves, so the broadcast
 * stops without losing anyone: the pending recipients keep their slot and a
 * later "Reenviar falhados" picks the failed ones back up.
 *
 * Returns true when THIS call did the pausing (and alerted).
 */
export async function haltBroadcast(
  broadcastId: string,
  reason: ChannelHaltReason,
  detail: string,
): Promise<boolean> {
  const won = firstOrNull(
    await db
      .update(broadcasts)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.status, 'sending')),
      )
      .returning({
        accountId: broadcasts.accountId,
        userId: broadcasts.userId,
        name: broadcasts.name,
      }),
  );
  // Lost the race (someone already paused/finished it) → don't double-alert.
  if (!won) return false;

  // Alerting must never break the pause — the pause is the part that protects
  // the number.
  try {
    const { title, body } = haltAlert(reason, won.name);
    await db.insert(notifications).values({
      accountId: won.accountId,
      userId: won.userId,
      type: 'broadcast_halted',
      title,
      body: `${body}\n\nErro: ${detail.slice(0, 300)}`,
    });
    await publishEvent(won.accountId, { type: 'notification' });
  } catch (err) {
    console.error('[broadcast-controls] halt alert failed:', err);
  }
  return true;
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

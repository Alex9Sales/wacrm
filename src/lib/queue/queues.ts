// ============================================================
// Queue definitions + enqueue helpers (Phase 5 CORE).
//
// Two tiers of queues:
//
//   broadcast-dispatch   — one job per broadcast. The dispatch worker
//                          loads the broadcast, marks it 'sending', and
//                          fans its pending recipients out onto…
//   outbound-{channelId} — one queue per channel. The recipient worker
//                          for that queue self-limits to the channel's
//                          throughput and does the actual send.
//
// Idempotency is enforced via deterministic jobIds:
//   dispatch-{broadcastId}  — a broadcast is dispatched at most once
//                             (re-enqueue is a no-op while the job lives).
//   {recipientRowId}        — a recipient is sent at most once; an infra
//                             retry of the same row never double-sends.
//
// Next-independent (BullMQ + ioredis only) — imported by both the routes
// and the standalone tsx worker.
// ============================================================

import { Queue, type JobsOptions } from 'bullmq';

import { bullConnection } from './connection';

export const BROADCAST_DISPATCH_QUEUE = 'broadcast-dispatch';
export const SCHEDULED_MESSAGE_QUEUE = 'scheduled-message';

/** Payload of a dispatch job. */
export interface BroadcastDispatchJob {
  broadcastId: string;
}

/** Payload of a per-recipient outbound job. */
export interface RecipientJob {
  broadcastId: string;
  recipientRowId: string;
}

/** Payload of a scheduled 1:1 message job. */
export interface ScheduledMessageJob {
  scheduledMessageId: string;
}

/** Name of the per-channel outbound queue. (BullMQ forbids ':' in queue
 *  names, so we join with '-'.) */
export function outboundQueueName(channelId: string): string {
  return `outbound-${channelId}`;
}

// ---- lazy singletons -------------------------------------------------

let _dispatchQueue: Queue<BroadcastDispatchJob> | null = null;

/** The single broadcast-dispatch queue. */
export function broadcastDispatchQueue(): Queue<BroadcastDispatchJob> {
  if (!_dispatchQueue) {
    _dispatchQueue = new Queue<BroadcastDispatchJob>(BROADCAST_DISPATCH_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return _dispatchQueue;
}

let _scheduledQueue: Queue<ScheduledMessageJob> | null = null;

/** The single scheduled-message queue (delayed 1:1 sends). */
export function scheduledMessageQueue(): Queue<ScheduledMessageJob> {
  if (!_scheduledQueue) {
    _scheduledQueue = new Queue<ScheduledMessageJob>(SCHEDULED_MESSAGE_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: {
        // Transient send failures retry a few times; permanent ones throw
        // UnrecoverableError in the worker and skip retries.
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return _scheduledQueue;
}

const _outboundQueues = new Map<string, Queue<RecipientJob>>();

/** Memoized per-channel outbound queue. */
export function outboundQueue(channelId: string): Queue<RecipientJob> {
  const existing = _outboundQueues.get(channelId);
  if (existing) return existing;
  const q = new Queue<RecipientJob>(outboundQueueName(channelId), {
    connection: bullConnection(),
    defaultJobOptions: {
      // Transient failures retry a few times with exponential backoff;
      // permanent failures throw UnrecoverableError and skip retries.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  _outboundQueues.set(channelId, q);
  return q;
}

// ---- enqueue helpers -------------------------------------------------

/**
 * Enqueue a broadcast dispatch job. `delayMs` schedules it into the
 * future (for `scheduled_at`). jobId = `dispatch-{broadcastId}` so a
 * duplicate enqueue while the job is still queued is a no-op.
 */
export async function enqueueBroadcastDispatch(
  broadcastId: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  // BullMQ forbids ':' in custom job ids, so use a '-' separator.
  const jobOptions: JobsOptions = { jobId: `dispatch-${broadcastId}` };
  if (opts.delayMs && opts.delayMs > 0) {
    jobOptions.delay = opts.delayMs;
  }
  await broadcastDispatchQueue().add('dispatch', { broadcastId }, jobOptions);
}

/**
 * Enqueue a single recipient send onto its channel's outbound queue.
 * jobId = recipientRowId → BullMQ dedups, so an infra-level retry of the
 * dispatch never double-sends a recipient that was already queued.
 */
export async function enqueueRecipient(
  channelId: string,
  payload: { broadcastId: string; recipientRowId: string },
): Promise<void> {
  await outboundQueue(channelId).add(
    'send',
    { broadcastId: payload.broadcastId, recipientRowId: payload.recipientRowId },
    { jobId: payload.recipientRowId },
  );
}

/**
 * Enqueue a scheduled 1:1 message. `delayMs` schedules it to fire at
 * `scheduled_at`. jobId = `sched-{id}` so re-enqueue is a no-op and the
 * job can be located + removed on cancel.
 */
export async function enqueueScheduledMessage(
  scheduledMessageId: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const jobOptions: JobsOptions = { jobId: `sched-${scheduledMessageId}` };
  if (opts.delayMs && opts.delayMs > 0) {
    jobOptions.delay = opts.delayMs;
  }
  await scheduledMessageQueue().add('send', { scheduledMessageId }, jobOptions);
}

/**
 * Remove a scheduled message's delayed job (best-effort). Safe to call
 * even if the job already ran or never existed — the worker also re-checks
 * the row's status, so a cancelled row is never sent even if the job
 * couldn't be removed (e.g. it was already active).
 */
export async function removeScheduledMessageJob(
  scheduledMessageId: string,
): Promise<void> {
  try {
    const job = await scheduledMessageQueue().getJob(
      `sched-${scheduledMessageId}`,
    );
    if (job) await job.remove();
  } catch {
    // Job is active/locked or already gone — the status re-check covers it.
  }
}

/** Close all queue connections (graceful shutdown / test teardown). */
export async function closeQueues(): Promise<void> {
  if (_dispatchQueue) {
    await _dispatchQueue.close();
    _dispatchQueue = null;
  }
  if (_scheduledQueue) {
    await _scheduledQueue.close();
    _scheduledQueue = null;
  }
  for (const q of _outboundQueues.values()) {
    await q.close();
  }
  _outboundQueues.clear();
}

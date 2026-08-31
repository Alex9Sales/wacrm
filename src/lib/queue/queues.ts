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
export const AI_REPLY_QUEUE = 'ai-reply';
export const DEAL_SUGGEST_QUEUE = 'deal-suggest';

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

/** Payload of a debounced AI auto-reply job (message buffer). */
export interface AiReplyJob {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
}

/** Payload of a debounced proactive deal-suggestion job (IA v2 — Fase 3). */
export interface DealSuggestJob {
  accountId: string;
  conversationId: string;
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

let _aiReplyQueue: Queue<AiReplyJob> | null = null;

/** The single AI auto-reply queue (debounced per conversation). */
export function aiReplyQueue(): Queue<AiReplyJob> {
  if (!_aiReplyQueue) {
    _aiReplyQueue = new Queue<AiReplyJob>(AI_REPLY_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return _aiReplyQueue;
}

/**
 * Message buffer: (re)schedule the AI reply for `delayMs` in the future, keyed
 * per conversation. Every new inbound RESETS the timer (remove + re-add), so
 * the AI only replies once the customer STOPS sending — joining a burst of
 * messages into a single, contextful answer instead of replying to each.
 *
 * The eligibility gates (assigned agent, AI paused, per-conv cap) are re-checked
 * at fire time inside the worker, so a human taking over during the buffer
 * window correctly cancels the pending reply.
 *
 * Best-effort by contract — a failure here must never break the inbound path.
 */
export async function enqueueAiReplyDebounced(
  job: AiReplyJob,
  delayMs: number,
): Promise<void> {
  const jobId = `ai-reply-${job.conversationId}`;
  const q = aiReplyQueue();
  try {
    // Reset the timer: drop the still-delayed job so the re-add below starts a
    // fresh countdown.
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'active') {
        // ⚠️ Job RODANDO: a geração pode já ter lido o histórico SEM esta
        // mensagem (corrida de segundos — caso Cristina 31/08). O add abaixo
        // seria IGNORADO pelo BullMQ (jobId duplicado de job vivo) e a
        // mensagem ficava pra sempre sem resposta. Agenda uma RECHECAGEM com
        // id único; o dispatch dá skip se a resposta em voo já tiver coberto
        // (guard "última msg é do cliente").
        await q.add('ai-reply', job, {
          jobId: `${jobId}-chase-${Date.now()}`,
          delay: Math.max(delayMs, 8_000),
        });
        return;
      }
      await existing.remove().catch(() => {});
    }
  } catch {
    /* ignore — still try to add below */
  }
  await q.add('ai-reply', job, { jobId, delay: Math.max(0, delayMs) });
}

let _dealSuggestQueue: Queue<DealSuggestJob> | null = null;

/** A fila única de sugestões proativas (debounced por conversa) — IA v2 Fase 3. */
export function dealSuggestQueue(): Queue<DealSuggestJob> {
  if (!_dealSuggestQueue) {
    _dealSuggestQueue = new Queue<DealSuggestJob>(DEAL_SUGGEST_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 1, // best-effort; sugerir de novo no próximo inbound é ok
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return _dealSuggestQueue;
}

/**
 * Buffer por conversa (mesmo padrão do AI reply): cada novo inbound RESETA o
 * timer, então a análise proativa só roda depois que o cliente para de mandar —
 * junta a rajada numa análise só. Os gates (negócio aberto? cooldown?) são
 * re-checados no worker, na hora de disparar. Best-effort: nunca quebra o inbound.
 */
export async function enqueueDealSuggestDebounced(
  job: DealSuggestJob,
  delayMs: number,
): Promise<void> {
  const jobId = `deal-suggest-${job.conversationId}`;
  const q = dealSuggestQueue();
  try {
    const existing = await q.getJob(jobId);
    if (existing) await existing.remove().catch(() => {});
  } catch {
    /* ignore — still try to add below */
  }
  await q.add('deal-suggest', job, { jobId, delay: Math.max(0, delayMs) });
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
  opts: { delayMs?: number } = {},
): Promise<void> {
  const jobOptions: JobsOptions = { jobId: payload.recipientRowId };
  // Humanized drips schedule each recipient into the future (its slot).
  if (opts.delayMs && opts.delayMs > 0) jobOptions.delay = opts.delayMs;
  await outboundQueue(channelId).add(
    'send',
    { broadcastId: payload.broadcastId, recipientRowId: payload.recipientRowId },
    jobOptions,
  );
}

/**
 * Remove a broadcast's dispatch job (best-effort). BullMQ dedups by jobId
 * even for COMPLETED jobs, so a finished `dispatch-{id}` blocks a re-enqueue
 * — "reenviar falhados" must drop it first.
 */
export async function removeBroadcastDispatchJob(
  broadcastId: string,
): Promise<void> {
  try {
    const job = await broadcastDispatchQueue().getJob(`dispatch-${broadcastId}`);
    if (job) await job.remove();
  } catch {
    // active/locked or already gone
  }
}

/**
 * Remove stale outbound jobs for a set of recipients (best-effort). Their
 * jobId = recipientRowId, so a prior failed/completed job blocks the fresh
 * enqueue on retry.
 */
export async function removeRecipientJobs(
  channelId: string,
  recipientRowIds: string[],
): Promise<void> {
  const q = outboundQueue(channelId);
  for (const id of recipientRowIds) {
    try {
      const job = await q.getJob(id);
      if (job) await job.remove();
    } catch {
      // active/locked — leave it
    }
  }
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

/**
 * Re-schedule one recipient's outbound job to a new delay: drop the existing
 * delayed job (jobId = recipientRowId) and re-enqueue it with `delayMs`. Used
 * by "Enviar agora" to re-anchor a humanized drip's pending recipients to a
 * fresh, now-based spacing (the caller also nulls the broadcast's pacing so
 * the worker's business-hours guard is skipped).
 */
export async function rescheduleRecipient(
  channelId: string,
  broadcastId: string,
  recipientRowId: string,
  delayMs: number,
): Promise<void> {
  const q = outboundQueue(channelId);
  const job = await q.getJob(recipientRowId);
  if (job) {
    try {
      await job.remove();
    } catch {
      // Active/locked — can't remove; leave it (it'll run on its old slot).
    }
  }
  await enqueueRecipient(channelId, { broadcastId, recipientRowId }, { delayMs });
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
  if (_dealSuggestQueue) {
    await _dealSuggestQueue.close();
    _dealSuggestQueue = null;
  }
  for (const q of _outboundQueues.values()) {
    await q.close();
  }
  _outboundQueues.clear();
}
